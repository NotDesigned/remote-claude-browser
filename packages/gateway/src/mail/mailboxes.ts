import { randomInt, randomUUID } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createResendReceiving, MailboxError } from "./resend";

export const RESEND_WEBHOOK_PATH = "/api/webhooks/resend";
const MAILBOX_PATH = "/api/me/mailboxes";
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

export interface MailboxService {
  readonly enabled: boolean;
  createAddress(userId: string, label?: unknown): MailboxAddress;
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
  now?: () => number;
  fetcher?: typeof fetch;
}): Promise<MailboxService> {
  const { file, apiKey, webhookSecret, now = Date.now, fetcher = fetch } = options;
  const domain = options.domain?.trim().toLowerCase() ?? "";
  const receiving =
    apiKey && webhookSecret && domain
      ? createResendReceiving(apiKey, webhookSecret, now, fetcher)
      : undefined;
  if (receiving && !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain))
    throw new Error("RESEND_RECEIVING_DOMAIN must be a bare email domain");

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
    WHERE a.address IN (SELECT value FROM json_each(?))
    ON CONFLICT(address_id, id) DO NOTHING
  `);
  const deleteUser = db.prepare("DELETE FROM mailbox_addresses WHERE user_id = ?");

  const requireReceiving = () => {
    if (!receiving) throw new MailboxError(503, "收件箱尚未启用");
    return receiving;
  };
  return {
    enabled: !!receiving,
    createAddress(userId, label) {
      requireReceiving();
      if (label !== undefined && typeof label !== "string")
        throw new MailboxError(400, "请输入收件地址名称");
      const name = label?.trim() ?? "";
      if ([...name].length > 80) throw new MailboxError(400, "收件地址名称最多 80 个字");
      const id = randomUUID();
      const createdAt = now();
      for (let attempt = 0; attempt < 32; attempt++) {
        const words = Array.from({ length: 2 }, () => addressWords[randomInt(addressWords.length)]);
        const address = `${words.join("-")}@${domain}`;
        if (addAddress.run(id, userId, address, name, createdAt, address).changes)
          return { id, address, label: name, createdAt };
      }
      throw new MailboxError(503, "暂时无法分配新的邮箱地址");
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
          event.from,
          event.subject,
          event.receivedAt,
          JSON.stringify(event.to),
        );
    },
    deleteUser(userId) {
      deleteUser.run(userId);
    },
    close() {
      db.close();
    },
  };
}

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

  app.get(MAILBOX_PATH, async (request, reply) => {
    const userId = userIdFor(request, reply);
    return {
      enabled: service.enabled,
      addresses: service.enabled ? service.listAddresses(userId) : [],
    };
  });
  app.post<{ Body: { label?: unknown } | null }>(MAILBOX_PATH, async (request, reply) => {
    const address = service.createAddress(userIdFor(request, reply), request.body?.label);
    return reply.code(201).send({ address });
  });
  app.get<{ Params: { addressId: string } }>(
    `${MAILBOX_PATH}/:addressId/messages`,
    async (request, reply) => {
      const userId = userIdFor(request, reply);
      const { addressId } = request.params;
      requireAddress(userId, addressId);
      return { messages: service.listMessages(userId, addressId) };
    },
  );
  app.get<{ Params: { addressId: string; messageId: string } }>(
    `${MAILBOX_PATH}/:addressId/messages/:messageId`,
    async (request, reply) => {
      const userId = userIdFor(request, reply);
      const { addressId, messageId } = request.params;
      requireAddress(userId, addressId);
      const message = await service.readMessage(userId, addressId, messageId);
      if (!message) throw new MailboxError(404, "没有这封邮件");
      const { id, from, subject, receivedAt, text } = message;
      return { message: { id, from, subject, receivedAt, text } };
    },
  );
  if (service.enabled)
    void app.register(async (webhook) => {
      webhook.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );
      webhook.post<{ Body: Buffer }>(RESEND_WEBHOOK_PATH, async (request) => {
        if (!Buffer.isBuffer(request.body)) throw new MailboxError(400, "邮件通知格式无效");
        service.receive(request.body, request.headers);
        return {};
      });
    });
}
