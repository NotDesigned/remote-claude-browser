import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STATUS_CODES } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorStyle } from "../http-errors";
import { createResendReceiving, MailboxError } from "./resend";

export const RESEND_WEBHOOK_PATH = "/api/webhooks/resend";
const MAILBOX_PATH = "/api/me/mailboxes";
const CLAIM_PATH = `${MAILBOX_PATH}/claims`;
const CLAIM_VALID_MS = 10 * 60_000;
const CLAIM_RESEND_MS = 60_000;

function stripBidi(value: string): string {
  return value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
/** Addresses a user may hold through their own creating and claiming; admin assignment is exempt. */
export const MAX_ADDRESSES_PER_USER = 20;
const addressWords = `
  acorn alder almond amber anchor apple arbor aster autumn bamboo basil bay beach beech berry
  birch bloom blossom blue breeze briar brook brush butter candle canyon cape caramel cedar
  cherry chestnut cinnamon citrus clay clear clover cloud coast cobalt coconut coral cove
  crane creek crest crimson crocus dawn daybreak dew dove drift dune dusk earth elm ember
  fern field finch fir flame flax flint flood forest frost garden ginger glade glass gleam
  gold grain grape grass grove gull harbor hawk hazel heather heron hickory hill honey iris
  island ivory ivy jade jasmine jay jet juniper kestrel kinglet lake larch lark laurel leaf
  lemon lily lime linen linden lotus lunar maple marble marsh mauve meadow melon mint mist
  moon moss mulberry myrtle nectar night north oak ocean olive orchid oriole otter pale palm
  papaya paper peach pear pearl pebble petal pine plain plum pond poplar poppy prairie prism
  purple quartz rain raven reed reef ridge river robin rose ruby rush rye saffron sage sand
  scarlet sea shell shore silver sky slate snow sorrel sparrow spice spring spruce star stone
  storm strand stream sugar summer summit sun sundew surf teal terrace thorn tide thyme tiger
  topaz trail tulip tundra twig valley velvet violet walnut water wave wheat willow wind winter
  wren yarrow zephyr
`
  .trim()
  .split(/\s+/);

export interface MailboxAddress {
  id: string;
  address: string;
  label: string;
  createdAt: number;
}

export interface MailboxMessageSummary {
  id: string;
  from: string;
  subject: string;
  receivedAt: number;
}

export interface MailboxMessage extends MailboxMessageSummary {
  text: string;
  html?: string;
  authenticated: boolean;
}

interface MailboxClaim {
  address: string;
  codeHash: string;
  sentAt: number;
  attempts: number;
}

export interface MailboxService {
  readonly enabled: boolean;
  readonly domain?: string;
  readonly domains: string[];
  readonly canClaim: boolean;
  pendingClaim(userId: string): string | undefined;
  startClaim(userId: string, address: unknown): Promise<string>;
  confirmClaim(userId: string, address: unknown, code: unknown): MailboxAddress;
  createAddress(
    userId: string,
    label?: unknown,
    localPart?: unknown,
    domain?: unknown,
  ): MailboxAddress;
  assignAddress(userId: string, address: unknown, label?: unknown): MailboxAddress;
  deleteAddress(userId: string, addressId: string): void;
  getAddress(userId: string, addressId: string): MailboxAddress | undefined;
  listAddresses(userId: string): MailboxAddress[];
  listMessages(userId: string, addressId: string, since?: number): MailboxMessageSummary[];
  readMessage(
    userId: string,
    addressId: string,
    messageId: string,
  ): Promise<MailboxMessage | undefined>;
  receive(body: Buffer, headers: IncomingHttpHeaders): void;
  deleteUser(userId: string): void;
  close(): void;
}

export async function createMailboxService(options: {
  file: string;
  apiKey?: string;
  webhookSecret?: string;
  domain?: string;
  verificationFrom?: string;
  now?: () => number;
  fetcher?: typeof fetch;
}): Promise<MailboxService> {
  const { file, apiKey, webhookSecret, now = Date.now, fetcher = fetch } = options;
  const domains = (options.domain ?? "").split(",").map((domain) => domain.trim().toLowerCase());
  const configuredDomains = [...new Set(domains.filter(Boolean))];
  const receiving =
    apiKey && webhookSecret && configuredDomains.length
      ? createResendReceiving(apiKey, webhookSecret, now, fetcher)
      : undefined;
  if (
    receiving &&
    configuredDomains.some((domain) => !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain))
  )
    throw new Error("RESEND_RECEIVING_DOMAIN must contain comma-separated bare email domains");
  const defaultDomain = configuredDomains[0];
  const verificationFrom = options.verificationFrom?.trim();
  const verification =
    receiving && webhookSecret && verificationFrom
      ? { sender: verificationFrom, key: webhookSecret, send: receiving.send }
      : undefined;

  if (file !== ":memory:") {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await (await open(file, "a", 0o600)).close();
    await chmod(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS mailbox_addresses (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, address TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mailbox_addresses_user ON mailbox_addresses(user_id, created_at);
    CREATE TABLE IF NOT EXISTS retired_mailbox_addresses (address TEXT PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS retire_mailbox_address AFTER DELETE ON mailbox_addresses
    BEGIN
      INSERT OR IGNORE INTO retired_mailbox_addresses VALUES (OLD.address);
    END;
    CREATE TABLE IF NOT EXISTS mailbox_messages (
      address_id TEXT NOT NULL REFERENCES mailbox_addresses(id) ON DELETE CASCADE,
      id TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(address_id, id)
    );
    CREATE INDEX IF NOT EXISTS mailbox_messages_received ON mailbox_messages(address_id, received_at);
    CREATE TABLE IF NOT EXISTS mailbox_claims (
      user_id TEXT PRIMARY KEY, address TEXT NOT NULL, code_hash TEXT NOT NULL,
      sent_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  const listAddresses = db.prepare(`
    SELECT id, address, label, created_at AS createdAt
    FROM mailbox_addresses WHERE user_id = ? ORDER BY created_at, id
  `);
  const getAddress = db.prepare(`
    SELECT id, address, label, created_at AS createdAt
    FROM mailbox_addresses WHERE user_id = ? AND id = ?
  `);
  const addAddress = db.prepare(
    `INSERT INTO mailbox_addresses (id, user_id, address, label, created_at)
     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM retired_mailbox_addresses WHERE address = ?)
     ON CONFLICT(address) DO NOTHING`,
  );
  const messagesForOwner = `
    SELECT m.id, m.sender AS "from", m.subject, m.received_at AS receivedAt
    FROM mailbox_messages m JOIN mailbox_addresses a ON m.address_id = a.id
    WHERE a.user_id = ? AND a.id = ?
  `;
  const listMessages = db.prepare(`
    ${messagesForOwner} AND m.received_at >= ? ORDER BY m.received_at DESC, m.id
  `);
  const getMessage = db.prepare(`${messagesForOwner} AND m.id = ?`);
  const addMessage = db.prepare(`
    INSERT INTO mailbox_messages (address_id, id, sender, subject, received_at)
    SELECT a.id, ?, ?, ?, ? FROM mailbox_addresses a
    WHERE a.created_at <= ? AND a.address IN (SELECT value FROM json_each(?))
    ON CONFLICT(address_id, id) DO NOTHING
  `);
  const deleteUser = db.prepare("DELETE FROM mailbox_addresses WHERE user_id = ?");
  const deleteAddress = db.prepare("DELETE FROM mailbox_addresses WHERE user_id = ? AND id = ?");
  const unavailableAddress = db.prepare(`
    SELECT 1 FROM mailbox_addresses WHERE address = ?
    UNION ALL SELECT 1 FROM retired_mailbox_addresses WHERE address = ?
  `);
  const getClaim = db.prepare(`
    SELECT address, code_hash AS codeHash, sent_at AS sentAt, attempts
    FROM mailbox_claims WHERE user_id = ?
  `);
  const setClaim = db.prepare(`
    INSERT INTO mailbox_claims (user_id, address, code_hash, sent_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET address = excluded.address, code_hash = excluded.code_hash,
      sent_at = excluded.sent_at, attempts = 0
  `);
  const failedClaim = db.prepare(
    "UPDATE mailbox_claims SET attempts = attempts + 1 WHERE user_id = ?",
  );
  const deleteClaim = db.prepare("DELETE FROM mailbox_claims WHERE user_id = ?");
  const restoreClaim = db.prepare(`
    INSERT OR REPLACE INTO mailbox_claims (user_id, address, code_hash, sent_at, attempts)
    VALUES (?, ?, ?, ?, ?)
  `);
  const countAddresses = db.prepare(
    "SELECT COUNT(*) AS count FROM mailbox_addresses WHERE user_id = ?",
  );
  const requireRoom = (userId: string) => {
    const { count } = countAddresses.get(userId) as { count: number };
    if (count >= MAX_ADDRESSES_PER_USER)
      throw new MailboxError(
        409,
        `每个用户最多 ${MAX_ADDRESSES_PER_USER} 个收件地址，请先删除不再使用的地址`,
      );
  };

  const requireReceiving = () => {
    if (!receiving) throw new MailboxError(503, "收件箱尚未启用");
    return receiving;
  };
  function mailboxLabel(label: unknown) {
    if (label !== undefined && typeof label !== "string")
      throw new MailboxError(400, "请输入收件地址名称");
    const name = label?.trim() ?? "";
    if ([...name].length > 80) throw new MailboxError(400, "收件地址名称最多 80 个字");
    return name;
  }
  function configuredAddress(value: unknown) {
    const address = typeof value === "string" ? value.trim().toLowerCase() : "";
    const [local, host, extra] = address.split("@");
    if (
      !host ||
      !configuredDomains.includes(host) ||
      extra !== undefined ||
      !local ||
      local.length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)
    )
      throw new MailboxError(400, "请输入已启用域名下的有效收件地址");
    return address;
  }
  const requireVerification = () => {
    if (!verification) throw new MailboxError(503, "邮箱绑定验证尚未启用");
    return verification;
  };
  const claimFor = (userId: string) => getClaim.get(userId) as unknown as MailboxClaim | undefined;
  const activeClaim = (claim: MailboxClaim | undefined) =>
    claim && now() - claim.sentAt < CLAIM_VALID_MS && claim.attempts < 5 ? claim : undefined;
  const claimHash = (key: string, userId: string, address: string, code: string) =>
    createHmac("sha256", key)
      .update(JSON.stringify([userId, address, code]))
      .digest();
  function insertAddress(userId: string, address: string, label: string) {
    const id = randomUUID();
    const createdAt = now();
    if (addAddress.run(id, userId, address, label, createdAt, address).changes)
      return { id, address, label, createdAt };
  }
  function assignAvailable(userId: string, address: string, label: string) {
    const assigned = insertAddress(userId, address, label);
    if (!assigned) throw new MailboxError(409, "这个收件地址已被分配或停用");
    return assigned;
  }
  return {
    enabled: !!receiving,
    domain: receiving ? defaultDomain : undefined,
    domains: receiving ? configuredDomains : [],
    canClaim: !!verification,
    pendingClaim(userId) {
      return verification ? activeClaim(claimFor(userId))?.address : undefined;
    },
    async startClaim(userId, value) {
      const { sender, key, send } = requireVerification();
      const address = configuredAddress(value);
      if (unavailableAddress.get(address, address))
        throw new MailboxError(409, "这个收件地址已被分配或停用");
      requireRoom(userId);
      const sentAt = now();
      const previous = claimFor(userId);
      if (previous && sentAt - previous.sentAt < CLAIM_RESEND_MS)
        throw new MailboxError(429, "请在 1 分钟后重新发送验证码");
      const code = randomInt(100_000_000).toString().padStart(8, "0");
      // Saved first so that a second request within the minute is refused, and put back as it
      // was if the code never went out: a claim nobody received must not show as pending.
      setClaim.run(userId, address, claimHash(key, userId, address, code).toString("hex"), sentAt);
      try {
        await send({
          from: sender,
          to: address,
          subject: "收件箱绑定验证码",
          text: `你的收件箱绑定验证码为 ${code}，10 分钟内有效。`,
        });
      } catch (error) {
        if (previous)
          restoreClaim.run(
            userId,
            previous.address,
            previous.codeHash,
            previous.sentAt,
            previous.attempts,
          );
        else deleteClaim.run(userId);
        throw error;
      }
      return address;
    },
    confirmClaim(userId, requestedAddress, value) {
      const { key } = requireVerification();
      const claim = activeClaim(claimFor(userId));
      if (!claim) throw new MailboxError(400, "请重新获取验证码");
      const address = configuredAddress(requestedAddress);
      if (address !== claim.address) throw new MailboxError(400, "请为这个地址重新获取验证码");
      const code = typeof value === "string" ? value.trim() : "";
      const hash = claimHash(key, userId, address, code);
      if (!timingSafeEqual(hash, Buffer.from(claim.codeHash, "hex"))) {
        failedClaim.run(userId);
        throw new MailboxError(400, "验证码不正确");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        requireRoom(userId);
        const assigned = assignAvailable(userId, address, "");
        deleteClaim.run(userId);
        db.exec("COMMIT");
        return assigned;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    createAddress(userId, label, localPart, requestedDomain = defaultDomain) {
      requireReceiving();
      const domain =
        typeof requestedDomain === "string" ? requestedDomain.trim().toLowerCase() : "";
      if (!configuredDomains.includes(domain))
        throw new MailboxError(400, "请选择已启用的收件域名");
      const name = mailboxLabel(label);
      requireRoom(userId);
      if (localPart !== undefined) {
        const part = typeof localPart === "string" ? localPart.trim().toLowerCase() : "";
        if (!/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(part))
          throw new MailboxError(400, "地址名称须为 1–58 个英文字母、数字或中间的连字符");
        return assignAvailable(userId, `inbox-${part}@${domain}`, name);
      }
      for (let attempt = 0; attempt < 32; attempt++) {
        const words = Array.from({ length: 2 }, () => addressWords[randomInt(addressWords.length)]);
        const address = insertAddress(userId, `${words.join("-")}@${domain}`, name);
        if (address) return address;
      }
      throw new MailboxError(503, "暂时无法分配新的邮箱地址");
    },
    assignAddress(userId, value, label) {
      requireReceiving();
      return assignAvailable(userId, configuredAddress(value), mailboxLabel(label));
    },
    deleteAddress(userId, addressId) {
      if (!deleteAddress.run(userId, addressId).changes)
        throw new MailboxError(404, "没有这个收件地址");
    },
    getAddress(userId, addressId) {
      return getAddress.get(userId, addressId) as unknown as MailboxAddress | undefined;
    },
    listAddresses(userId) {
      return listAddresses.all(userId) as unknown as MailboxAddress[];
    },
    listMessages(userId, addressId, since = 0) {
      return listMessages.all(userId, addressId, since) as unknown as MailboxMessageSummary[];
    },
    async readMessage(userId, addressId, messageId) {
      const summary = getMessage.get(userId, addressId, messageId) as unknown as
        MailboxMessageSummary | undefined;
      if (!summary) return undefined;
      const { from, ...content } = await requireReceiving().read(messageId);
      return { ...summary, ...content, from: from ?? summary.from };
    },
    receive(body, headers) {
      const event = requireReceiving().event(body, headers);
      if (event)
        addMessage.run(
          event.id,
          stripBidi(event.from),
          stripBidi(event.subject),
          event.receivedAt,
          event.receivedAt,
          JSON.stringify(event.to),
        );
    },
    deleteUser(userId) {
      deleteUser.run(userId);
      deleteClaim.run(userId);
    },
    close() {
      db.close();
    },
  };
}

/**
 * Mailbox routes answer a MailboxError the way Fastify answers one, `{ statusCode, error, message }`
 * (the page shows `message`), whatever its status; anything else gets the gateway's generic answer.
 */
export const mailboxErrors: ErrorStyle = (error) =>
  error instanceof MailboxError
    ? {
        status: error.statusCode,
        body: {
          statusCode: error.statusCode,
          error: STATUS_CODES[error.statusCode] ?? "Error",
          message: error.message,
        },
      }
    : undefined;

export function registerMailboxRoutes(
  app: FastifyInstance,
  service: MailboxService,
  currentUserId: (request: IncomingMessage) => string | undefined,
): void {
  const userIdFor = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    const id = currentUserId(request.raw);
    if (!id) throw new MailboxError(401, "请重新登录");
    return id;
  };
  const requireAddress = (userId: string, addressId: string) => {
    if (!service.enabled) throw new MailboxError(503, "收件箱尚未启用");
    if (!service.getAddress(userId, addressId)) throw new MailboxError(404, "没有这个收件地址");
  };

  const config = { errors: mailboxErrors };
  app.get(MAILBOX_PATH, { config }, async (request, reply) => {
    const userId = userIdFor(request, reply);
    return {
      enabled: service.enabled,
      domain: service.domain,
      domains: service.domains,
      ...(service.canClaim && { canClaim: true, pendingClaim: service.pendingClaim(userId) }),
      addresses: service.enabled ? service.listAddresses(userId) : [],
    };
  });
  app.post<{ Body: { label?: unknown; localPart?: unknown; domain?: unknown } | null }>(
    MAILBOX_PATH,
    { bodyLimit: 4096, config },
    async (request, reply) => {
      const address = service.createAddress(
        userIdFor(request, reply),
        request.body?.label,
        request.body?.localPart,
        request.body?.domain,
      );
      return reply.code(201).send({ address });
    },
  );
  app.post<{ Body: { address?: unknown } | null }>(
    CLAIM_PATH,
    { bodyLimit: 1024, config },
    async (request, reply) => {
      const address = await service.startClaim(userIdFor(request, reply), request.body?.address);
      return { address };
    },
  );
  app.post<{ Body: { address?: unknown; code?: unknown } | null }>(
    `${CLAIM_PATH}/confirm`,
    { bodyLimit: 1024, config },
    async (request, reply) => {
      const address = service.confirmClaim(
        userIdFor(request, reply),
        request.body?.address,
        request.body?.code,
      );
      return reply.code(201).send({ address });
    },
  );
  app.delete<{ Params: { addressId: string } }>(
    `${MAILBOX_PATH}/:addressId`,
    { config },
    async (request, reply) => {
      service.deleteAddress(userIdFor(request, reply), request.params.addressId);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { addressId: string } }>(
    `${MAILBOX_PATH}/:addressId/messages`,
    { config },
    async (request, reply) => {
      const userId = userIdFor(request, reply);
      const { addressId } = request.params;
      requireAddress(userId, addressId);
      return { messages: service.listMessages(userId, addressId) };
    },
  );
  app.get<{ Params: { addressId: string; messageId: string } }>(
    `${MAILBOX_PATH}/:addressId/messages/:messageId`,
    { config },
    async (request, reply) => {
      const userId = userIdFor(request, reply);
      const { addressId, messageId } = request.params;
      requireAddress(userId, addressId);
      const message = await service.readMessage(userId, addressId, messageId);
      if (!message) throw new MailboxError(404, "没有这封邮件");
      const { id, from, subject, receivedAt, text, html, authenticated } = message;
      return {
        message: {
          id,
          from: stripBidi(from),
          subject: stripBidi(subject),
          receivedAt,
          text,
          authenticated,
          ...(html ? { html } : {}),
        },
      };
    },
  );
  if (service.enabled)
    void app.register(async (webhook) => {
      webhook.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );
      webhook.post<{ Body: Buffer }>(RESEND_WEBHOOK_PATH, { config }, async (request) => {
        if (!Buffer.isBuffer(request.body)) throw new MailboxError(400, "邮件通知格式无效");
        service.receive(request.body, request.headers);
        return {};
      });
    });
}
