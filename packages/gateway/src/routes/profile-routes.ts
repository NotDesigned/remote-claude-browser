/**
 * A user's browser profiles ("accounts" in the API): list, create, rename, choose the default,
 * check and change the exit, change the system identity, delete. Changing what a profile's Chrome
 * was started with closes its workspaces' windows first.
 */
import type { FastifyInstance } from "fastify";
import { rm } from "node:fs/promises";
import type { FrontendUser } from "../auth/users";
import { profileSignedIn } from "../claude/signed-in";
import { HttpError } from "../http-errors";
import { ClientSessionError } from "../session/clients";
import { DEFAULT_PROFILE, MAX_PROFILES } from "../session/profiles";
import type { GatewayContext } from "./context";

export type ProfileActions = ReturnType<typeof createProfileActions>;

/** Profile steps other route groups need too. The *Locked ones run inside the lifecycle lock. */
export function createProfileActions(
  ctx: Pick<
    GatewayContext,
    "userStore" | "accountStore" | "clientSessions" | "access" | "registry" | "accounts"
  >,
) {
  const { userStore, accountStore, clientSessions, access, registry, accounts } = ctx;
  return {
    /** The user's default profile, choosing or creating one when there is none. */
    async defaultFor(user: FrontendUser): Promise<string> {
      const preferred = userStore.defaultProfile(user.id);
      if (preferred) return preferred;
      const owned = accountStore.all().filter((record) => access.ownsProfile(user.id, record.id));
      if (owned[0]) {
        userStore.setDefaultProfile(user.id, owned[0].id);
        return owned[0].id;
      }
      const created = await accountStore.create("默认浏览器");
      try {
        userStore.assignProfile(created.id, user.id);
      } catch (error) {
        await accountStore.remove(created.id);
        throw error;
      }
      return created.id;
    },
    /** Moves an owner's session to another of the user's profiles. */
    async switchLocked(owner: string, sid: string, id: string): Promise<void> {
      if (!clientSessions.owns(owner, sid))
        throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话已结束");
      if (!accountStore.has(id))
        throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
      access.requireOwnProfile(access.userIdForOwner(owner), id);
      accounts.requireBrowserExit(id);
      await registry.switchProfileLocked(owner, sid, id);
    },
    /** Closes the profile's workspaces' windows and its Chrome, so they start again changed. */
    async resetRuntimeLocked(id: string): Promise<void> {
      for (const record of clientSessions.all())
        if ((record.profile ?? DEFAULT_PROFILE) === id) await registry.teardown(record.sid);
      await accounts.closeProfile(id);
    },
  };
}

export function registerProfileRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  profiles: ProfileActions,
): void {
  const {
    access,
    accounts,
    accountStore,
    clientSessions,
    hub,
    lock,
    networkRuntime,
    platforms,
    proxyCatalog,
    userStore,
    workspace,
    profileSystem,
    requirePlatform,
  } = ctx;
  const { currentOwner, currentUser, requireLiveOwner } = access;
  const defaultPlatform = platforms[0]!;
  const describeAccounts = (user: FrontendUser) => {
    const nodes = new Map(proxyCatalog.listNodes(user).map((node) => [node.id, node]));
    return accountStore
      .all()
      .filter((record) => access.ownsProfile(user.id, record.id))
      .map((record) => {
        const account = accounts.get(record.id);
        const node = record.proxyId ? nodes.get(record.proxyId) : undefined;
        const live = account?.login.current();
        const exit = account ?? record;
        const hasCookie = live ? live.signedIn : profileSignedIn(accounts.accountDir(record.id));
        const unavailable = live ? !!live.unavailable : hasCookie && !!record.unavailable;
        const signedIn =
          hasCookie && !unavailable && (live ? live.signedIn : record.signedIn !== false);
        const sessions = clientSessions
          .all()
          .filter((session) => (session.profile ?? DEFAULT_PROFILE) === record.id);
        const online = hub.onlineSessions();
        return {
          id: record.id,
          name: record.name,
          ...profileSystem(record.id),
          proxyId: record.proxyId ?? null,
          proxyName: node?.name ?? null,
          proxyVisibility: node?.visibility,
          timeZone: exit.timeZone,
          exitCity: exit.exitCity,
          exitCountry: exit.exitCountry,
          exitIp: exit.exitIp,
          checkedAt: exit.checkedAt,
          running: accounts.has(record.id),
          signedIn,
          unavailable,
          email: signedIn ? (live ? live.email : (record.email ?? null)) : null,
          sessions: sessions.length,
          onlineSessions: sessions.filter((session) => online.has(session.sid)).length,
        };
      });
  };
  app.get<{ Querystring: { sid?: string } }>("/api/accounts", async (request, reply) => {
    const owner = currentOwner(request.raw);
    const user = currentUser(request.raw);
    if (!owner || !user) return reply.code(401).send({ error: "请重新登录" });
    const sid = request.query.sid;
    return reply.header("cache-control", "no-store").send({
      accounts: describeAccounts(user),
      platforms,
      defaultPlatform,
      default: userStore.defaultProfile(user.id),
      current: sid && clientSessions.owns(owner, sid) ? clientSessions.profileOf(sid) : null,
    });
  });
  app.post<{ Body: { name?: unknown; proxyId?: unknown; platform?: unknown } }>(
    "/api/accounts",
    { bodyLimit: 1024, config: workspace.exitConfig },
    async (request) => {
      const owner = workspace.owner(request, 401, "请重新登录");
      const user = currentUser(request.raw);
      if (!user) throw new HttpError(401, { error: "请重新登录" });
      return await lock.run(async () => {
        requireLiveOwner(request.raw, owner);
        if (userStore.listOwnedProfiles(user.id).length >= MAX_PROFILES)
          throw new ClientSessionError(
            409,
            "PROFILE_LIMIT",
            `每个用户最多 ${MAX_PROFILES} 个浏览器配置`,
          );
        const platform =
          request.body?.platform === undefined
            ? defaultPlatform
            : requirePlatform(request.body.platform);
        const proxyId = request.body?.proxyId;
        if (proxyId !== undefined) {
          if (typeof proxyId !== "string" || !proxyId)
            throw new ClientSessionError(400, "PROXY_REQUIRED", "请选择出口节点");
          if (!process.env.MIRROR_RUNTIME_SOCKET)
            throw new ClientSessionError(
              503,
              "PROXY_RUNTIME_DISABLED",
              "请在部署中启用独立出口运行时",
            );
          proxyCatalog.getNodeConfig(user, proxyId);
        }
        const created = await accountStore.create(request.body?.name, platform);
        try {
          if (typeof proxyId === "string") await accountStore.setProxy(created.id, proxyId);
          userStore.assignProfile(created.id, user.id);
        } catch (error) {
          await accountStore.remove(created.id);
          throw error;
        }
        return { ...created, ...profileSystem(created.id) };
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/api/accounts/:id",
    { bodyLimit: 1024, config: workspace.config },
    async (request) => {
      const owner = workspace.owner(request, 401, "请重新输入访问密码");
      return await lock.run(async () => {
        const user = requireLiveOwner(request.raw, owner);
        access.requireOwnProfile(user.id, request.params.id);
        return accountStore.rename(request.params.id, request.body?.name);
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/default",
    { config: workspace.config },
    async (request) => {
      const owner = workspace.owner(request, 401, "请重新登录");
      return await lock.run(() => {
        const user = requireLiveOwner(request.raw, owner);
        userStore.setDefaultProfile(user.id, request.params.id);
        return { account: request.params.id };
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/exit/check",
    { config: workspace.exitConfig },
    async (request, reply) => {
      const owner = workspace.owner(request, 401, "请重新登录");
      const snapshot = await lock.run(() => {
        const user = requireLiveOwner(request.raw, owner);
        const id = request.params.id;
        access.requireOwnProfile(user.id, id);
        const record = accountStore.get(id)!;
        if (!record.proxyId)
          throw new ClientSessionError(409, "PROXY_REQUIRED", "请先为浏览器配置选择出口");
        proxyCatalog.getNodeConfig(user, record.proxyId);
        return { user, id, proxyId: record.proxyId, account: accounts.get(id) };
      });
      const health = snapshot.account
        ? await networkRuntime.checkBrowser(snapshot.id)
        : await ctx.checkProxy(snapshot.user, snapshot.proxyId);
      return await lock.run(() => {
        requireLiveOwner(request.raw, owner);
        if (
          accountStore.get(snapshot.id)?.proxyId !== snapshot.proxyId ||
          accounts.get(snapshot.id) !== snapshot.account
        )
          throw new ClientSessionError(409, "EXIT_CHANGED", "配置在检测期间已变化，请重新检查");
        return reply.header("cache-control", "no-store").send({
          scope: snapshot.account ? "browser" : "node",
          health,
        });
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { proxyId: string | null } }>(
    "/api/accounts/:id/proxy",
    {
      config: workspace.exitConfig,
      schema: {
        body: {
          type: "object",
          required: ["proxyId"],
          additionalProperties: false,
          properties: {
            proxyId: {
              anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 128 }],
            },
          },
        },
      },
    },
    async (request) => {
      const owner = workspace.owner(request, 401, "请重新登录");
      return await lock.run(async () => {
        const user = requireLiveOwner(request.raw, owner);
        const id = request.params.id;
        access.requireOwnProfile(user.id, id);
        const proxyId = request.body.proxyId;
        if (proxyId !== null) {
          if (!process.env.MIRROR_RUNTIME_SOCKET)
            throw new ClientSessionError(
              503,
              "PROXY_RUNTIME_DISABLED",
              "请在部署中启用独立出口运行时",
            );
          proxyCatalog.getNodeConfig(user, proxyId);
        }
        if ((accountStore.get(id)!.proxyId ?? null) !== proxyId) {
          await profiles.resetRuntimeLocked(id);
          await accountStore.setProxy(id, proxyId);
        }
        return { proxyId };
      });
    },
  );
  app.patch<{ Params: { id: string }; Body: { platform?: unknown } }>(
    "/api/accounts/:id/platform",
    { bodyLimit: 1024, config: workspace.config },
    async (request) => {
      const owner = workspace.owner(request, 401, "请重新登录");
      return await lock.run(async () => {
        const user = requireLiveOwner(request.raw, owner);
        const id = request.params.id;
        access.requireOwnProfile(user.id, id);
        const platform = requirePlatform(request.body?.platform);
        if (profileSystem(id).platform !== platform) {
          await profiles.resetRuntimeLocked(id);
          await accountStore.setPlatform(id, platform);
        }
        return { platform };
      });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    { config: workspace.config },
    async (request, reply) => {
      const owner = workspace.owner(request, 401, "请重新输入访问密码");
      const id = request.params.id;
      return await lock.run(async () => {
        const user = requireLiveOwner(request.raw, owner);
        access.requireOwnProfile(user.id, id);
        if (!accountStore.has(id))
          throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
        if (userStore.listOwnedProfiles(user.id).length === 1)
          throw new ClientSessionError(409, "PROFILE_LAST", "需要保留至少一个浏览器配置");
        if (id === userStore.defaultProfile(user.id))
          throw new ClientSessionError(409, "PROFILE_DEFAULT", "默认账号不能删除");
        const using = clientSessions
          .all()
          .filter((record) => (record.profile ?? DEFAULT_PROFILE) === id);
        if (using.some((record) => record.owner !== owner))
          throw new ClientSessionError(
            409,
            "PROFILE_IN_USE",
            "别的设备正在用这个账号，请先在那边切换或结束",
          );
        const fallback = userStore.defaultProfile(user.id)!;
        for (const record of using) await profiles.switchLocked(owner, record.sid, fallback);
        await accounts.closeProfile(id, true);
        await accountStore.remove(id);
        userStore.unassignProfile(id);
        await rm(accounts.accountDir(id), { recursive: true, force: true });
        return reply.code(204).send();
      });
    },
  );
}
