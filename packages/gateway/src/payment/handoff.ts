import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { allowPaymentHandoff } from "../security-headers";

export type PaymentProvider = "apple-pay" | "google-pay" | "payment-request";
export type PaymentHandoffStatus =
  "pending" | "opened" | "authorized" | "failed" | "cancelled" | "expired";

export interface PaymentHandoffRecord {
  id: string;
  sid: string;
  userId: string;
  profileId: string;
  provider: PaymentProvider;
  merchantOrigin: string;
  resumeUrl: string;
  orderRef?: string;
  amount?: string;
  currency?: string;
  createdAt: number;
  expiresAt: number;
  status: PaymentHandoffStatus;
  providerReference?: string;
  capabilities?: {
    applePay?: boolean;
    googlePay?: boolean;
    paymentRequest?: boolean;
    webAuthn?: boolean;
    browser?: string;
  };
}

interface CreateInput {
  sid: string;
  userId: string;
  profileId: string;
  provider: PaymentProvider;
  merchantOrigin: string;
  resumeUrl: string;
  orderRef?: string;
  amount?: string;
  currency?: string;
}

interface Stored extends PaymentHandoffRecord {
  tokenHash: string;
}

const TTL_MS = 5 * 60_000;
const TOKEN_BYTES = 32;

function tokenHash(token: string): string {
  return createHmac("sha256", "payment-handoff-token").update(token).digest("hex");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) return;
    return url.origin;
  } catch {
    return;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function createPaymentHandoffs({
  now = () => Date.now(),
  ttlMs = TTL_MS,
  allowedOrigins = [],
  webhookSecret,
}: {
  now?: () => number;
  ttlMs?: number;
  allowedOrigins?: readonly string[];
  webhookSecret?: string;
} = {}) {
  const records = new Map<string, Stored>();
  const allowed = new Set(allowedOrigins.map((origin) => normalizeOrigin(origin)).filter(Boolean));

  function purgeExpired() {
    const current = now();
    for (const [id, record] of records) {
      if (record.expiresAt <= current) {
        record.status = "expired";
        records.delete(id);
      }
    }
  }

  function resolve(token: string): Stored | undefined {
    purgeExpired();
    const hash = tokenHash(token);
    return [...records.values()].find((record) => safeEquals(record.tokenHash, hash));
  }

  function create(input: CreateInput) {
    purgeExpired();
    const merchantOrigin = normalizeOrigin(input.merchantOrigin);
    if (!merchantOrigin) throw new Error("merchantOrigin 必须是 HTTPS 来源");
    const resume = new URL(input.resumeUrl);
    if (resume.protocol !== "https:" || resume.origin !== merchantOrigin)
      throw new Error("resumeUrl 必须使用已验证的商户来源");
    if (allowed.size && !allowed.has(merchantOrigin))
      throw new Error("商户来源尚未加入支付交接白名单");
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const createdAt = now();
    const record: Stored = {
      id: randomUUID(),
      tokenHash: tokenHash(token),
      sid: input.sid,
      userId: input.userId,
      profileId: input.profileId,
      provider: input.provider,
      merchantOrigin,
      resumeUrl: resume.href,
      ...(input.orderRef ? { orderRef: input.orderRef } : {}),
      ...(input.amount ? { amount: input.amount } : {}),
      ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
      createdAt,
      expiresAt: createdAt + ttlMs,
      status: "pending",
    };
    records.set(record.id, record);
    return {
      token,
      record: { ...record, tokenHash: undefined } as Omit<PaymentHandoffRecord, "tokenHash">,
    };
  }

  function forUser(userId: string, sid: string, id: string): PaymentHandoffRecord | undefined {
    const record = records.get(id);
    if (!record || record.userId !== userId || record.sid !== sid) return;
    if (record.expiresAt <= now()) {
      record.status = "expired";
      records.delete(id);
      return { ...record };
    }
    return { ...record, capabilities: record.capabilities && { ...record.capabilities } };
  }

  function cancel(userId: string, sid: string, id: string): boolean {
    const record = records.get(id);
    if (!record || record.userId !== userId || record.sid !== sid) return false;
    record.status = "cancelled";
    records.delete(id);
    return true;
  }

  function markOpened(token: string): PaymentHandoffRecord | undefined {
    const record = resolve(token);
    if (!record) return;
    if (["authorized", "failed", "cancelled", "expired"].includes(record.status)) return;
    if (record.status === "pending") record.status = "opened";
    return { ...record };
  }

  function setCapabilities(token: string, capabilities: PaymentHandoffRecord["capabilities"]) {
    const record = resolve(token);
    if (!record) return;
    if (["authorized", "failed", "cancelled", "expired"].includes(record.status)) return;
    record.capabilities = capabilities;
    if (record.status === "pending") record.status = "opened";
    return { ...record };
  }

  function completeSigned(
    token: string,
    body: { status: "authorized" | "failed" | "cancelled"; providerReference?: string },
    signature: string,
  ) {
    if (!webhookSecret) return;
    const expected = createHmac("sha256", webhookSecret).update(JSON.stringify(body)).digest("hex");
    const supplied = signature.replace(/^sha256=/i, "");
    if (!/^[a-f0-9]{64}$/i.test(supplied) || !safeEquals(expected, supplied)) return;
    const record = resolve(token);
    if (!record) return;
    if (["authorized", "failed", "cancelled", "expired"].includes(record.status)) return;
    record.status = body.status;
    if (body.providerReference) record.providerReference = body.providerReference;
    return { ...record };
  }

  return { create, forUser, cancel, markOpened, setCapabilities, completeSigned, resolve };
}

interface RouteOptions {
  requireSession: preHandlerAsyncHookHandler;
  currentUserId(request: IncomingMessage): string | undefined;
  profileForSession(sid: string): string | undefined;
  allowedOrigins?: readonly string[];
  webhookSecret?: string;
  publicOrigin: string;
}

interface HandoffParams {
  sid: string;
  id: string;
}

const handoffBody = {
  type: "object",
  required: ["provider", "merchantOrigin", "resumeUrl"],
  additionalProperties: false,
  properties: {
    provider: { enum: ["apple-pay", "google-pay", "payment-request"] },
    merchantOrigin: { type: "string", maxLength: 256 },
    resumeUrl: { type: "string", maxLength: 2048 },
    orderRef: { type: "string", minLength: 1, maxLength: 200 },
    amount: { type: "string", pattern: "^[0-9]+(?:\\.[0-9]{1,2})?$", maxLength: 32 },
    currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
  },
} as const;

export function registerPaymentHandoffRoutes(app: FastifyInstance, options: RouteOptions): void {
  const handoffs = createPaymentHandoffs({
    allowedOrigins: options.allowedOrigins,
    webhookSecret: options.webhookSecret,
  });
  const route = "/api/client/session/:sid/payment/handoff";
  const publicToken = "/pay/handoff/";
  app.post<{ Params: { sid: string }; Body: CreateInput }>(
    route,
    {
      preHandler: options.requireSession,
      bodyLimit: 4096,
      schema: { body: handoffBody },
    },
    async (request, reply) => {
      const userId = options.currentUserId(request.raw);
      const profileId = options.profileForSession(request.params.sid);
      if (!userId || !profileId) return reply.code(403).send({ error: "请先连接当前浏览器" });
      try {
        const result = handoffs.create({
          ...request.body,
          sid: request.params.sid,
          userId,
          profileId,
        });
        const url = new URL(
          `${publicToken}${encodeURIComponent(result.token)}`,
          options.publicOrigin,
        );
        return {
          handoffId: result.record.id,
          url: url.href,
          expiresAt: result.record.expiresAt,
          status: result.record.status,
          provider: result.record.provider,
        };
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : "支付交接参数无效" });
      }
    },
  );
  app.get<{ Params: HandoffParams }>(
    `${route}/:id`,
    { preHandler: options.requireSession },
    async (request, reply) => {
      const userId = options.currentUserId(request.raw);
      if (!userId) return reply.code(401).send({ error: "请重新登录" });
      const status = handoffs.forUser(userId, request.params.sid, request.params.id);
      return status
        ? { ...status, tokenHash: undefined }
        : reply.code(404).send({ error: "支付交接不存在" });
    },
  );
  app.delete<{ Params: HandoffParams }>(
    `${route}/:id`,
    { preHandler: options.requireSession },
    async (request, reply) => {
      const userId = options.currentUserId(request.raw);
      if (!userId || !handoffs.cancel(userId, request.params.sid, request.params.id))
        return reply.code(404).send({ error: "支付交接不存在" });
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { token: string } }>(`${publicToken}:token`, async (request, reply) => {
    const record = handoffs.markOpened(request.params.token);
    if (!record)
      return reply.code(410).type("text/plain; charset=utf-8").send("支付交接已过期或不存在");
    allowPaymentHandoff(reply);
    const resumeUrl = escapeHtml(record.resumeUrl);
    const label =
      record.provider === "apple-pay"
        ? "Apple Pay"
        : record.provider === "google-pay"
          ? "Google Pay"
          : "支付平台";
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>在本机完成支付</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f6f0;color:#2b2520;font:16px system-ui,sans-serif}.card{width:min(420px,calc(100% - 40px));padding:28px;border:1px solid #d9d3c9;border-radius:16px;background:#fffdfa;box-shadow:0 14px 40px #2b252022}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#6e655c}.button{display:block;width:100%;padding:12px;border:0;border-radius:9px;background:#9f553d;color:white;font:inherit;cursor:pointer;text-align:center;text-decoration:none;box-sizing:border-box}</style>
<main class="card"><h1>在本机完成 ${escapeHtml(label)} 支付</h1><p>请在当前设备的 Safari 或 Chrome 中继续。支付平台会在本机检测可用的钱包和支付方式。</p><a class="button" href="${resumeUrl}">继续支付</a></main><script>
  (async () => {
    const capabilities = {
      applePay: typeof globalThis.ApplePaySession === "function"
        ? Boolean(await Promise.resolve(globalThis.ApplePaySession.canMakePayments?.()).catch(() => false))
        : false,
      googlePay: Boolean(globalThis.google?.payments?.api),
      paymentRequest: typeof globalThis.PaymentRequest === "function",
      webAuthn: Boolean(globalThis.PublicKeyCredential),
      browser: navigator.userAgent.slice(0, 80)
    };
    await fetch(${JSON.stringify(`${publicToken}${encodeURIComponent(request.params.token)}/capability`)}, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(capabilities), keepalive: true
    }).catch(() => {});
  })();
</script></html>`);
  });
  app.post<{ Params: { token: string }; Body: PaymentHandoffRecord["capabilities"] }>(
    `${publicToken}:token/capability`,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            applePay: { type: "boolean" },
            googlePay: { type: "boolean" },
            paymentRequest: { type: "boolean" },
            webAuthn: { type: "boolean" },
            browser: { type: "string", maxLength: 80 },
          },
        },
      },
    },
    async (request, reply) => {
      const updated = handoffs.setCapabilities(request.params.token, request.body);
      return updated
        ? { ok: true, capabilities: updated.capabilities }
        : reply.code(410).send({ error: "支付交接已过期或不存在" });
    },
  );
  app.post<{
    Params: { token: string };
    Body: { status: "authorized" | "failed" | "cancelled"; providerReference?: string };
  }>(
    `${publicToken}:token/result`,
    {
      schema: {
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: { enum: ["authorized", "failed", "cancelled"] },
            providerReference: { type: "string", maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const signature = String(request.headers["x-payment-signature"] ?? "");
      const updated = handoffs.completeSigned(request.params.token, request.body, signature);
      return updated
        ? { ok: true, status: updated.status }
        : reply.code(401).send({ error: "支付结果签名无效或交接已过期" });
    },
  );
}

export function isPublicPaymentHandoffPath(url: string): boolean {
  return /^\/pay\/handoff\/[A-Za-z0-9_-]+(?:\/capability|\/result)?(?:\?|$)/.test(url);
}
