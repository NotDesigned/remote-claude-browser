/**
 * Administration: users (create, change, disable, delete), the overview of every session, ending
 * any session, and assigning mailbox addresses. Disabling or deleting a user ends all of their
 * workspaces, Chrome processes, exits and remote-cc connections.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { UserStoreError } from "../auth/users";
import { accountChangeRevokesRemoteCc } from "../remote-cc/routes";
import { ClientSessionError } from "../session/clients";
import type { GatewayContext } from "./context";
import type { ProfileActions } from "./profile-routes";

export function registerAdminRoutes(
  app: FastifyInstance,
  ctx: GatewayContext,
  profiles: ProfileActions,
): void {
  const {
    access,
    accounts,
    accountStore,
    clientSessions,
    cpaRuntime,
    cpaStore,
    exits,
    hub,
    lock,
    mailbox,
    proxyCatalog,
    registry,
    remoteCcStore,
    userStore,
    workspace,
    report,
  } = ctx;
  const { currentOwner, currentUser, userIdForOwner } = access;
  const requireAdmin = (request: IncomingMessage) => {
    if (ctx.isStopping()) throw new UserStoreError(503, "SERVICE_STOPPING", "服务正在重启");
    const user = currentUser(request);
    if (!user) throw new UserStoreError(401, "LOGIN_REQUIRED", "请重新登录");
    if (user.role !== "admin") throw new UserStoreError(403, "ADMIN_REQUIRED", "需要管理员权限");
    return user;
  };
  /** Revocation must finish cleaning every Chrome even if one renderer refuses to close. */
  async function closeUserWorkspacesLocked(userId: string, profileIds: string[]) {
    const failures: unknown[] = [];
    try {
      await cpaRuntime?.suspendUser(userId);
    } catch (error) {
      failures.push(error);
    }
    for (const record of clientSessions.all()) {
      if (userIdForOwner(record.owner) !== userId) continue;
      await registry
        .teardown(record.sid, {
          release: record.owner,
          onStopError: (error) => report("revoked workspace cleanup failed", error),
        })
        .catch((error: unknown) => failures.push(error));
    }
    for (const id of profileIds) {
      const account = accounts.get(id);
      if (account) await accounts.close(account);
    }
    // A shared CPA instance may still authorize through the node; its exit stays.
    const sharedUsesNode = (nodeId: string) =>
      cpaStore
        ?.runningInstances()
        .some(
          (instance) =>
            instance.scope === "shared" &&
            [
              ...cpaStore.credentialBindings(instance.id),
              ...cpaStore.pendingOAuth(instance.id),
            ].some((binding) => binding.proxyId === nodeId),
        ) === true;
    await exits.stopUser(userId, sharedUsesNode, failures);
    hub.broadcastStatus();
    if (failures.length) throw new AggregateError(failures, "Could not persist revoked workspaces");
  }

  app.get("/api/users", { config: workspace.config }, async (request, reply) => {
    requireAdmin(request.raw);
    return reply.header("cache-control", "no-store").send({ users: userStore.listUsers() });
  });
  const mailboxUser = (request: FastifyRequest<{ Params: { id: string } }>) => {
    requireAdmin(request.raw);
    const user = userStore.getUser(request.params.id);
    if (!user) throw new UserStoreError(404, "USER_UNKNOWN", "没有这个用户");
    return user;
  };
  app.get<{ Params: { id: string } }>(
    "/api/users/:id/mailboxes",
    { config: workspace.adminMailboxConfig },
    async (request, reply) => {
      const user = mailboxUser(request);
      return reply.header("cache-control", "no-store").send({
        enabled: mailbox.enabled,
        domain: mailbox.domain,
        domains: mailbox.domains,
        addresses: mailbox.listAddresses(user.id),
      });
    },
  );
  app.post<{ Params: { id: string }; Body: { address?: unknown; label?: unknown } }>(
    "/api/users/:id/mailboxes",
    { bodyLimit: 4096, config: workspace.adminMailboxConfig },
    async (request, reply) => {
      const user = mailboxUser(request);
      if (!user.enabled) throw new UserStoreError(409, "USER_DISABLED", "请先启用这个用户");
      const address = mailbox.assignAddress(user.id, request.body?.address, request.body?.label);
      return reply.code(201).header("cache-control", "no-store").send({ address });
    },
  );
  app.get("/api/admin/overview", { config: workspace.config }, async (request, reply) => {
    requireAdmin(request.raw);
    const online = hub.onlineSessions();
    const users = userStore.listUsers();
    const sessions = clientSessions.all().map((record) => {
      const userId = userIdForOwner(record.owner);
      const profileId = clientSessions.profileOf(record.sid);
      return {
        ...clientSessions.describe(record.sid),
        userId,
        username: users.find((user) => user.id === userId)?.username ?? "已删除用户",
        profileId,
        profileName: accountStore.get(profileId)?.name ?? profileId,
        online: online.has(record.sid),
        running: registry.has(record.sid),
        currentDevice: record.owner === currentOwner(request.raw),
        createdAt: record.createdAt,
      };
    });
    return reply.header("cache-control", "no-store").send({
      users: users.map((user) => ({
        ...user,
        profileCount: userStore.listOwnedProfiles(user.id).length,
        sso: userStore.identities(user.id).map((identity) => identity.email ?? "")[0] ?? null,
        sessionCount: sessions.filter((session) => session.userId === user.id).length,
        onlineSessions: sessions.filter((session) => session.userId === user.id && session.online)
          .length,
      })),
      sessions,
      resources: ctx.status(),
      runningProfiles: accounts.size,
    });
  });
  app.delete<{ Params: { sid: string } }>(
    "/api/admin/sessions/:sid",
    { config: workspace.config },
    async (request, reply) => {
      await lock.run(async () => {
        requireAdmin(request.raw);
        const record = clientSessions.get(request.params.sid);
        if (!record) throw new ClientSessionError(404, "CLIENT_UNKNOWN", "这个会话已结束");
        await registry.releaseLocked(record.owner, record.sid);
      });
      return reply.code(204).send();
    },
  );
  app.post<{
    Body: { username?: unknown; password?: unknown; role?: unknown; maxSessions?: unknown };
  }>("/api/users", { bodyLimit: 4096, config: workspace.config }, async (request, reply) => {
    return await lock.run(async () => {
      requireAdmin(request.raw);
      const user = await userStore.createUser({
        username: request.body?.username,
        password: request.body?.password,
        role: request.body?.role,
        maxSessions: request.body?.maxSessions,
      });
      try {
        await profiles.defaultFor(user);
      } catch (error) {
        userStore.deleteUser(user.id);
        throw error;
      }
      return reply.code(201).send(user);
    });
  });
  app.patch<{
    Params: { id: string };
    Body: {
      username?: unknown;
      password?: unknown;
      role?: unknown;
      enabled?: unknown;
      maxSessions?: unknown;
    };
  }>("/api/users/:id", { bodyLimit: 4096, config: workspace.config }, async (request) => {
    return await lock.run(async () => {
      requireAdmin(request.raw);
      const previous = userStore.getUser(request.params.id);
      const user = await userStore.updateUser(request.params.id, request.body ?? {});
      if (
        request.body?.password !== undefined ||
        previous?.role !== user.role ||
        previous?.enabled !== user.enabled
      )
        hub.closeUserSessions(user.id);
      if (accountChangeRevokesRemoteCc(previous, user, request.body?.password !== undefined))
        remoteCcStore.removeUser(user.id);
      if (!user.enabled)
        await closeUserWorkspacesLocked(user.id, userStore.listOwnedProfiles(user.id));
      return user;
    });
  });
  app.delete<{ Params: { id: string } }>(
    "/api/users/:id",
    { config: workspace.config },
    async (request, reply) => {
      const id = request.params.id;
      await lock.run(async () => {
        const admin = requireAdmin(request.raw);
        if (admin.id === id)
          throw new UserStoreError(409, "USER_SELF_DELETE", "请使用另一个管理员账户删除此用户");
        await userStore.updateUser(id, { enabled: false });
        await closeUserWorkspacesLocked(id, userStore.listOwnedProfiles(id));
      });
      // Catalog invalidation owns the same lifecycle lock; run its cleanup between sections.
      await cpaRuntime?.removeUser(id);
      remoteCcStore.removeUser(id);
      await proxyCatalog.removePrivateSources(id);
      await lock.run(async () => {
        for (const profileId of userStore.listOwnedProfiles(id)) {
          await rm(accounts.accountDir(profileId), { recursive: true, force: true });
          await accountStore.remove(profileId);
          userStore.unassignProfile(profileId);
        }
        mailbox.deleteUser(id);
        userStore.deleteUser(id);
      });
      return reply.code(204).send();
    },
  );
}
