/**
 * A device's workspaces: open or resume one, switch its profile, end it, its appearance, opening
 * a CPA or remote-cc sign-in in it, the status bar's numbers, and the health check.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { performance } from "node:perf_hooks";
import { isClaudeTheme } from "../claude/theme";
import { profileForbidden, type SessionAccess } from "../auth/session-access";
import { isPhoneRequest } from "../browser/phone-identity";
import { CpaError } from "../cpa/store";
import type { registerRemoteCcRoutes } from "../remote-cc/routes";
import type { ClientRuntime } from "../session/client-runtime";
import { ClientSessionError } from "../session/clients";
import { DEFAULT_PROFILE } from "../session/profiles";
import { Timing, withTiming } from "../timing";
import type { GatewayContext } from "./context";
import type { ProfileActions } from "./profile-routes";

/** The guard of a route that serves one of the requester's workspaces (`:sid`). */
export const sessionRouteGuard =
  (access: Pick<SessionAccess<ClientRuntime>, "sessionGrant">) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const requested = (request.params as { sid?: string })?.sid;
    if (!requested || !access.sessionGrant(request.raw, requested))
      await reply.code(403).send({ error: "这个独立会话不属于当前客户端" });
  };

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  profiles: ProfileActions,
  remoteCc: Pick<ReturnType<typeof registerRemoteCcRoutes>, "openLoginIn">,
): void {
  const {
    access,
    accounts,
    accountStore,
    clientSessions,
    cpaRuntime,
    hub,
    idleReaper,
    lock,
    registry,
    workspace,
    report,
  } = ctx;
  const { currentOwner, requireLiveOwner, userIdForOwner } = access;
  const requireSession = ctx.requireSession;

  app.get<{ Querystring: { sid?: string } }>("/api/status", async (request, reply) => {
    if (!currentOwner(request.raw)) return reply.code(401).send({ error: "请重新输入访问密码" });
    const sid = request.query.sid;
    if (sid && !access.ownsSession(request.raw, sid))
      return reply.code(403).send({ error: "这个会话不属于当前客户端" });
    return reply.header("cache-control", "no-store").send(ctx.status(sid));
  });
  app.post<{ Body: { clientKey?: unknown; sid?: unknown; account?: unknown } }>(
    "/api/client/session",
    { config: workspace.config },
    async (request, reply) => {
      const owner = workspace.owner(request, 401, "请重新输入访问密码");
      const timing = new Timing();
      const queued = performance.now();
      const result = await withTiming(timing, () =>
        lock.run(async () => {
          timing.add("queue", performance.now() - queued);
          const user = requireLiveOwner(request.raw, owner);
          const chosen = request.body?.account;
          if (
            chosen !== undefined &&
            (typeof chosen !== "string" ||
              !accountStore.has(chosen) ||
              !access.ownsProfile(user.id, chosen))
          )
            throw profileForbidden();
          let previous = clientSessions.findExisting(
            owner,
            request.body?.clientKey,
            request.body?.sid,
          );
          if (previous && (await registry.expireSleepingLocked(previous))) previous = undefined;
          const existing = previous !== undefined;
          if (
            !existing &&
            user.maxSessions != null &&
            clientSessions.all().filter((record) => userIdForOwner(record.owner) === user.id)
              .length >= user.maxSessions
          )
            throw new ClientSessionError(
              409,
              "USER_SESSION_LIMIT",
              `已达到会话上限（${user.maxSessions} 个），请先结束不再使用的会话`,
            );
          const profileId =
            previous && access.ownsProfile(user.id, previous.profile ?? DEFAULT_PROFILE)
              ? (previous.profile ?? DEFAULT_PROFILE)
              : typeof chosen === "string"
                ? chosen
                : await profiles.defaultFor(user);
          accounts.requireBrowserExit(profileId);
          const record = await clientSessions.acquire(
            owner,
            request.body?.clientKey,
            request.body?.sid,
            isPhoneRequest(request.headers["user-agent"]),
          );
          try {
            if (!existing || !access.ownsProfile(user.id, clientSessions.profileOf(record.sid))) {
              if (registry.has(record.sid))
                throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "浏览器不属于当前用户");
              await clientSessions.setProfile(owner, record.sid, profileId);
            }
            idleReaper.touch(record.sid);
            hub.broadcastStatus();
            await registry.ensureLocked(record.sid);
            return {
              ...clientSessions.describe(record.sid),
              account: clientSessions.profileOf(record.sid),
              sharedAccount: true,
            };
          } catch (error) {
            if (!existing)
              await registry
                .releaseLocked(owner, record.sid)
                .catch((cleanupError) => report("new workspace rollback failed", cleanupError));
            throw error;
          }
        }),
      );
      reply.header("server-timing", timing.header());
      return result;
    },
  );
  /** Moves a session to another profile. Its windows close; the viewer reconnects to new ones. */
  app.post<{ Params: { sid: string }; Body: { account?: unknown } }>(
    "/api/client/session/:sid/account",
    { bodyLimit: 1024, config: workspace.config },
    async (request) => {
      const owner = workspace.owner(request, 403, "这个会话不属于当前客户端");
      const id = request.body?.account;
      if (typeof id !== "string")
        throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
      await lock.run(() => {
        requireLiveOwner(request.raw, owner);
        return profiles.switchLocked(owner, request.params.sid, id);
      });
      return { account: clientSessions.profileOf(request.params.sid) };
    },
  );
  app.delete<{ Params: { sid: string } }>(
    "/api/client/session/:sid",
    { config: workspace.config },
    async (request, reply) => {
      const owner = workspace.owner(request, 403, "这个会话不属于当前客户端");
      await lock.run(() => {
        requireLiveOwner(request.raw, owner);
        return registry.releaseLocked(owner, request.params.sid);
      });
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { sid: string } }>(
    "/s/:sid/theme",
    { preHandler: requireSession() },
    async (request) => ({
      theme:
        (await registry
          .get(request.params.sid)
          ?.theme.read()
          .catch(() => null)) ?? null,
    }),
  );
  app.post<{ Params: { sid: string }; Body: { theme?: unknown; systemDark?: unknown } }>(
    "/s/:sid/theme",
    { preHandler: requireSession(), bodyLimit: 1024 },
    async (request, reply) => {
      const { theme, systemDark } = request.body ?? {};
      if (!isClaudeTheme(theme)) return reply.code(400).send({ error: "未知的外观" });
      const applied =
        (await registry.get(request.params.sid)?.theme.set(theme, systemDark === true)) ?? false;
      return { applied };
    },
  );
  app.post<{ Params: { sid: string }; Body: { instanceId: string; state: string } }>(
    "/api/client/session/:sid/cpa/oauth",
    {
      config: workspace.config,
      preHandler: requireSession(),
      bodyLimit: 4096,
      schema: {
        body: {
          type: "object",
          required: ["instanceId", "state"],
          additionalProperties: false,
          properties: {
            instanceId: { type: "string", minLength: 1 },
            state: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      return await lock.run(async () => {
        // Again inside the lock: the session may have changed hands while this waited.
        const { owner } = access.authorizeSession(request.raw, request.params.sid);
        const user = requireLiveOwner(request.raw, owner);
        if (!cpaRuntime) throw new CpaError(503, "CPA_DISABLED", "CPA 未启用");
        const oauth = cpaRuntime.oauthPage(user, request.body.instanceId, request.body.state);
        const profileId = clientSessions.profileOf(request.params.sid);
        accounts.requireBrowserExit(profileId);
        if (accountStore.get(profileId)?.proxyId !== oauth.proxyId)
          throw new CpaError(
            409,
            "CPA_BROWSER_EXIT",
            "当前浏览器出口与授权节点不同，请选择出口一致的浏览器配置",
          );
        const runtime = await registry.ensureLocked(request.params.sid);
        requireLiveOwner(request.raw, owner);
        await runtime.tabs.handle({
          t: "nav",
          tab: runtime.tabs.activeTabId ?? "",
          action: "newtab",
          url: oauth.url,
        });
        return { ok: true };
      });
    },
  );
  app.post<{ Params: { sid: string; id: string } }>(
    "/api/client/session/:sid/remote-cc/logins/:id/open",
    { preHandler: requireSession(), bodyLimit: 1024, config: workspace.config },
    async (request) => {
      return await lock.run(async () => {
        // Again inside the lock: the session may have changed hands while this waited.
        const { owner } = access.authorizeSession(request.raw, request.params.sid);
        const user = requireLiveOwner(request.raw, owner);
        const sid = request.params.sid;
        const runtime = await registry.ensureLocked(sid);
        requireLiveOwner(request.raw, owner);
        await remoteCc.openLoginIn(
          user.id,
          request.params.id,
          clientSessions.profileOf(sid),
          sid,
          async (login) => {
            await runtime.tabs.handle({
              t: "nav",
              tab: runtime.tabs.activeTabId ?? "",
              action: "newtab",
              url: login.url,
            });
          },
        );
        return { ok: true };
      });
    },
  );
  app.get("/healthz", async (_request, reply) => {
    const alive = accounts.allAlive(),
      pages = [...registry.values()].flatMap((runtime) =>
        runtime.recovery.status().map(({ state }) => state),
      );
    const ok = alive && pages.length === 0;
    return reply.code(ok ? 200 : 503).send({
      ok,
      browser: alive,
      pages,
      clients: registry.size,
    });
  });
}
