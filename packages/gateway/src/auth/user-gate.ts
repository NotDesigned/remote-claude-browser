/** Persisted service logins; a remembered device alone never grants another user's browser. */
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import type { IncomingMessage } from "node:http";
import { readCookie } from "./cookies";
import { renderGatePage } from "./gate-page";
import { isOwnOrigin } from "./origin";
import { SESSION_COOKIE } from "./middleware";
import { OidcError, type Oidc } from "./oidc";
import { USER_SESSION_TTL_MS, UserStoreError, type FrontendUser, type UserStore } from "./users";

export const USER_COOKIE = "__Host-mirror-user";
const FORM_TYPE = "application/x-www-form-urlencoded";
const MAX_ATTEMPTS = 10000;
/** One password check in flight per client IP, and a bound on scrypt work across all clients. */
export const MAX_PENDING_LOGINS = 16;
const RESET_MS = 15 * 60_000;
interface Attempt {
  failures: number;
  until: number;
  at: number;
  pending: boolean;
}

export function userSessionToken(request: IncomingMessage): string | undefined {
  return readCookie(request, USER_COOKIE);
}

const OIDC_STATE_COOKIE = "mirror-oidc-state";
function oidcMessage(error: unknown): string {
  if (error instanceof OidcError) return error.message;
  console.error("OIDC sign-in failed:", error instanceof Error ? error.message : error);
  return "单点登录失败，请重试";
}

/** A remote-cc approval code carried across the login page. */
const REMOTE_CC_COOKIE = "mirror-remote-cc";
const REMOTE_CC_CODE = /^[A-Z2-9]{4}-?[A-Z2-9]{4}$/;
function remoteCcCode(request: IncomingMessage): string | undefined {
  const value = readCookie(request, REMOTE_CC_COOKIE);
  return value !== undefined && REMOTE_CC_CODE.test(value) ? value : undefined;
}

export function createUserGate(options: {
  store: UserStore;
  publicOrigin?: string;
  cookiesOnSuccess?(request: IncomingMessage): readonly string[];
  onLogout?(request: IncomingMessage, user: FrontendUser | null): Promise<void> | void;
  /** Sign-in through an OpenID Connect provider, next to username and password. */
  oidc?: Oidc;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, Attempt>();
  let pendingLogins = 0;
  const currentUser = (request: IncomingMessage) =>
    options.store.session(userSessionToken(request));
  // A request without Origin is not a browser's cross-site form or fetch. Otherwise the Origin
  // must be the configured public origin, or this request's own host when none is configured.
  const allowedOrigin = (
    origin: string | undefined,
    site: string | undefined,
    host: string | undefined,
  ) => site !== "cross-site" && (!origin || isOwnOrigin(origin, host, options.publicOrigin));
  const page = (reply: FastifyReply, code = 200, error?: string) =>
    reply
      .code(code)
      .header("cache-control", "no-store")
      // no-referrer turns a browser's native form-navigation Origin into "null".
      // Keep same-origin form submissions verifiable without sending referrers to other sites.
      .header("referrer-policy", "same-origin")
      .type("text/html; charset=utf-8")
      .send(renderGatePage(error, options.oidc?.settings.label));
  /** Starts a workbench session for user and leaves the gate (keeping a remote-cc code). */
  const signedIn = (
    request: IncomingMessage,
    reply: FastifyReply,
    user: FrontendUser,
    ttlMs = USER_SESSION_TTL_MS,
    extraCookies: string[] = [],
  ) => {
    const session = options.store.issueSession(user.id, ttlMs);
    const pending = remoteCcCode(request);
    reply.header("set-cookie", [
      `${USER_COOKIE}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`,
      ...(options.cookiesOnSuccess?.(request) ?? []),
      ...extraCookies,
      ...(pending
        ? [`${REMOTE_CC_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]
        : []),
    ]);
    return reply
      .code(303)
      .header("cache-control", "no-store")
      .header("location", pending ? `/?new=1&remote-cc=${pending}` : "/?new=1")
      .send();
  };
  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !allowedOrigin(
        request.headers.origin,
        request.headers["sec-fetch-site"] as string | undefined,
        request.headers.host,
      )
    )
      return reply.code(403).send({ error: "请求来源不受信任" });
    const url = new URL(request.raw.url ?? "/", "http://local");
    const path = url.pathname;
    if (
      ["/gate", "/healthz", "/logout"].includes(path) ||
      (options.oidc && path.startsWith("/gate/oidc/")) ||
      currentUser(request.raw)
    )
      return;
    if ((request.method === "GET" || request.method === "HEAD") && !/^\/(api|s)\//.test(path)) {
      // A remote-cc approval link survives the login (?remote-cc=CODE).
      const code = url.searchParams.get("remote-cc");
      if (code && REMOTE_CC_CODE.test(code))
        reply.header(
          "set-cookie",
          `${REMOTE_CC_COOKIE}=${code}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        );
      return reply.code(302).header("location", "/gate").send();
    }
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
          if (
            (previous && (previous.pending || previous.until > at)) ||
            pendingLogins >= MAX_PENDING_LOGINS
          ) {
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
            return signedIn(request.raw, reply, user);
          } finally {
            attempt.pending = false;
            pendingLogins--;
          }
        },
      );
      const oidc = options.oidc;
      if (oidc) {
        // The state cookie binds a callback to the browser that started the sign-in.
        const stateCookie = (state: string, maxAge: number) =>
          `${OIDC_STATE_COOKIE}=${state}; Path=/gate/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
        const begin = async (reply: FastifyReply, purpose: "login" | "link", userId?: string) => {
          try {
            const started = await oidc.start(purpose, userId);
            return reply
              .code(302)
              .header("cache-control", "no-store")
              .header("set-cookie", stateCookie(started.state, 600))
              .header("location", started.url)
              .send();
          } catch (error) {
            return page(
              reply,
              error instanceof OidcError ? error.statusCode : 502,
              oidcMessage(error),
            );
          }
        };
        app.get("/gate/oidc/start", async (_request, reply) => begin(reply, "login"));
        // A signed-in user attaches their external account (then may sign in either way).
        app.get("/gate/oidc/link", async (request, reply) => {
          const user = currentUser(request.raw);
          if (!user) return reply.code(302).header("location", "/gate").send();
          return begin(reply, "link", user.id);
        });
        app.get("/gate/oidc/callback", async (request, reply) => {
          const clear = stateCookie("", 0);
          try {
            const url = new URL(request.raw.url ?? "/", oidc.settings.redirectUri);
            const done = await oidc.finish(url, readCookie(request.raw, OIDC_STATE_COOKIE));
            if (done.purpose === "link") {
              const user = currentUser(request.raw);
              if (!user || user.id !== done.userId)
                throw new OidcError(400, "绑定已过期，请登录后重新绑定");
              options.store.linkIdentity(
                user.id,
                done.profile.issuer,
                done.profile.subject,
                done.profile.email,
              );
              return reply
                .code(303)
                .header("cache-control", "no-store")
                .header("set-cookie", clear)
                .header("location", "/?account=linked")
                .send();
            }
            const user = await oidc.signIn(done.profile);
            return signedIn(request.raw, reply, user, oidc.settings.sessionTtlMs, [clear]);
          } catch (error) {
            reply.header("set-cookie", clear);
            if (error instanceof UserStoreError)
              return page(reply, error.statusCode, error.message);
            return page(
              reply,
              error instanceof OidcError ? error.statusCode : 500,
              oidcMessage(error),
            );
          }
        });
      }
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
