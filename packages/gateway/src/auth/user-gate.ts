/** Persisted service logins; a remembered device alone never grants another user's browser. */
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import type { IncomingMessage } from "node:http";
import { renderGatePage } from "./gate-page";
import { SESSION_COOKIE } from "./middleware";
import { USER_SESSION_TTL_MS, type FrontendUser, type UserStore } from "./users";

export const USER_COOKIE = "__Host-mirror-user";
const FORM_TYPE = "application/x-www-form-urlencoded";
const MAX_ATTEMPTS = 10000;
const RESET_MS = 15 * 60_000;
interface Attempt {
  failures: number;
  until: number;
  at: number;
  pending: boolean;
}

export function userSessionToken(request: IncomingMessage): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === USER_COOKIE) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function createUserGate(options: {
  store: UserStore;
  publicOrigin?: string;
  cookiesOnSuccess?(request: IncomingMessage): readonly string[];
  onLogout?(request: IncomingMessage, user: FrontendUser | null): Promise<void> | void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, Attempt>();
  let pendingLogins = 0;
  const currentUser = (request: IncomingMessage) =>
    options.store.session(userSessionToken(request));
  const allowedOrigin = (origin: string | undefined, site: string | undefined) =>
    site !== "cross-site" && (!origin || !options.publicOrigin || origin === options.publicOrigin);
  const page = (reply: FastifyReply, code = 200, error?: string) =>
    reply
      .code(code)
      .header("cache-control", "no-store")
      // no-referrer turns a browser's native form-navigation Origin into "null".
      // Keep same-origin form submissions verifiable without sending referrers to other sites.
      .header("referrer-policy", "same-origin")
      .type("text/html; charset=utf-8")
      .send(renderGatePage(error, { users: true }));
  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !allowedOrigin(
        request.headers.origin,
        request.headers["sec-fetch-site"] as string | undefined,
      )
    )
      return reply.code(403).send({ error: "请求来源不受信任" });
    const path = new URL(request.raw.url ?? "/", "http://local").pathname;
    if (["/gate", "/healthz", "/logout"].includes(path) || currentUser(request.raw)) return;
    if ((request.method === "GET" || request.method === "HEAD") && !/^\/(api|s)\//.test(path))
      return reply.code(302).header("location", "/gate").send();
    return reply
      .code(401)
      .header("cache-control", "no-store")
      .send({ error: "请登录工作台", gate: "/gate" });
  };
  return {
    currentUser,
    preHandler,
    hasValidDevice: (request: IncomingMessage) => currentUser(request) !== null,
    authorizeUpgrade: (request: IncomingMessage) => currentUser(request) !== null,
    registerRoutes(app: FastifyInstance) {
      if (!app.hasContentTypeParser(FORM_TYPE))
        app.addContentTypeParser(FORM_TYPE, { parseAs: "string" }, (_request, body, done) => {
          const form = new URLSearchParams(String(body));
          done(null, { username: form.get("username"), password: form.get("password") });
        });
      app.get("/gate", async (request, reply) =>
        currentUser(request.raw) ? reply.code(302).header("location", "/").send() : page(reply),
      );
      app.post<{ Body: { username?: unknown; password?: unknown } }>(
        "/gate",
        { bodyLimit: 8192 },
        async (request, reply) => {
          const at = now();
          const previous = attempts.get(request.ip);
          if ((previous && (previous.pending || previous.until > at)) || pendingLogins >= 4) {
            reply.header("retry-after", "2");
            return page(reply, 429, "尝试次数较多，请稍后再试。");
          }
          if (attempts.size >= MAX_ATTEMPTS) {
            for (const [ip, value] of attempts)
              if (!value.pending && at - value.at > RESET_MS) attempts.delete(ip);
            for (const [ip, value] of attempts) {
              if (attempts.size < MAX_ATTEMPTS) break;
              if (!value.pending) attempts.delete(ip);
            }
          }
          const attempt: Attempt = {
            failures: previous && at - previous.at < RESET_MS ? previous.failures : 0,
            until: 0,
            at,
            pending: true,
          };
          attempts.set(request.ip, attempt);
          pendingLogins++;
          try {
            const user = await options.store.authenticate(
              request.body?.username,
              request.body?.password,
            );
            if (!user) {
              attempt.failures++;
              attempt.until =
                now() + Math.min(30_000, 500 * 2 ** Math.min(attempt.failures - 1, 16));
              return page(reply, 401, "用户名或密码不正确。");
            }
            attempts.delete(request.ip);
            const session = options.store.issueSession(user.id);
            reply.header("set-cookie", [
              `${USER_COOKIE}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(USER_SESSION_TTL_MS / 1000)}`,
              ...(options.cookiesOnSuccess?.(request.raw) ?? []),
            ]);
            return reply
              .code(303)
              .header("cache-control", "no-store")
              .header("location", "/?new=1")
              .send();
          } finally {
            attempt.pending = false;
            pendingLogins--;
          }
        },
      );
      app.post("/logout", async (request, reply) => {
        const user = currentUser(request.raw);
        options.store.revokeSession(userSessionToken(request.raw));
        try {
          await options.onLogout?.(request.raw, user);
        } finally {
          reply.header(
            "set-cookie",
            [USER_COOKIE, SESSION_COOKIE].map(
              (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
            ),
          );
        }
        return reply.code(204).header("cache-control", "no-store").send();
      });
    },
  };
}
