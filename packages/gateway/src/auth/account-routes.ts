import type { IncomingMessage } from "node:http";
import type { FastifyInstance } from "fastify";
import { messageAnswer, type ErrorStyle } from "../http-errors";
import { ClientSessionError, type createClientSessions } from "../session/clients";
import type { createLifecycleLock } from "../session/lifecycle-lock";
import { UserStoreError, type FrontendUser, type UserStore } from "./users";

/** Account routes answer `{ error: message, code }`; anything else is Fastify's default 500. */
export const accountErrors: ErrorStyle = (error) =>
  error instanceof UserStoreError || error instanceof ClientSessionError
    ? messageAnswer(error)
    : undefined;

export function registerAccountRoutes(
  app: FastifyInstance,
  options: {
    store: UserStore;
    sessions: Awaited<ReturnType<typeof createClientSessions>>;
    lifecycle: ReturnType<typeof createLifecycleLock>;
    currentUser(request: IncomingMessage): FrontendUser | null | undefined;
    currentOwner(request: IncomingMessage): string | undefined;
    userIdForOwner(owner: string): string | undefined;
    profileName(id: string): string;
    onlineSessions(): ReadonlySet<string>;
    stopSession(owner: string, sid: string): Promise<void>;
    onPasswordChanged(userId: string): void;
    /** Single sign-on, when configured: shown on the account page for linking. */
    oidc?: { label: string; issuer: string };
  },
) {
  const userFor = (request: IncomingMessage) => {
    const user = options.currentUser(request);
    if (!user?.enabled) throw new UserStoreError(401, "LOGIN_REQUIRED", "请重新登录");
    return user;
  };
  const config = { errors: accountErrors };
  app.get("/api/me", { config }, async (request, reply) => {
    const user = userFor(request.raw);
    return reply.header("cache-control", "no-store").send({
      user,
      hasPassword: options.store.hasPassword(user.id),
      sso: options.oidc
        ? {
            label: options.oidc.label,
            linked: options.store
              .identities(user.id)
              .filter((identity) => identity.issuer === options.oidc!.issuer)
              .map((identity) => ({ email: identity.email, lastLoginAt: identity.lastLoginAt })),
          }
        : null,
    });
  });
  app.post<{ Body: { currentPassword?: unknown; password?: unknown } }>(
    "/api/me/password",
    { bodyLimit: 4096, config },
    async (request, reply) => {
      await options.lifecycle.run(async () => {
        const user = userFor(request.raw);
        if (!(await options.store.authenticate(user.username, request.body?.currentPassword)))
          throw new UserStoreError(400, "CURRENT_PASSWORD", "当前密码不正确");
        if (request.body?.password === undefined)
          throw new UserStoreError(400, "USER_PASSWORD", "请输入新密码");
        await options.store.updateUser(user.id, { password: request.body.password });
        options.onPasswordChanged(user.id);
      });
      return reply.code(204).send();
    },
  );
  app.get("/api/me/sessions", { config }, async (request, reply) => {
    const user = userFor(request.raw);
    const online = options.onlineSessions();
    const sessions = options.sessions
      .all()
      .filter((record) => options.userIdForOwner(record.owner) === user.id)
      .map((record) => {
        const profileId = options.sessions.profileOf(record.sid);
        return {
          ...options.sessions.describe(record.sid),
          profileId,
          profileName: options.profileName(profileId),
          currentDevice: record.owner === options.currentOwner(request.raw),
          online: online.has(record.sid),
          createdAt: record.createdAt,
        };
      });
    return reply.header("cache-control", "no-store").send({ sessions });
  });
  app.delete<{ Params: { sid: string } }>(
    "/api/me/sessions/:sid",
    { config },
    async (request, reply) => {
      await options.lifecycle.run(async () => {
        const user = userFor(request.raw);
        const record = options.sessions.get(request.params.sid);
        if (!record || options.userIdForOwner(record.owner) !== user.id)
          throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前用户或已结束");
        await options.stopSession(record.owner, record.sid);
      });
      return reply.code(204).send();
    },
  );
}
