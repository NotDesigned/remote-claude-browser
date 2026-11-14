import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ClientSessionError, type createClientSessions } from "../session/clients";
import type { createLifecycleLock } from "../session/lifecycle-lock";
import { UserStoreError, type FrontendUser, type UserStore } from "./users";

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
    stopSession(owner: string, sid: string): Promise<void>;
    onPasswordChanged(userId: string): void;
  },
) {
  const userFor = (request: IncomingMessage) => {
    const user = options.currentUser(request);
    if (!user?.enabled) throw new UserStoreError(401, "LOGIN_REQUIRED", "请重新登录");
    return user;
  };
  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof UserStoreError || error instanceof ClientSessionError)
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    throw error;
  };
  app.get("/api/me", async (request, reply) => {
    try {
      return reply.header("cache-control", "no-store").send({ user: userFor(request.raw) });
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.post<{ Body: { currentPassword?: unknown; password?: unknown } }>(
    "/api/me/password",
    { bodyLimit: 4096 },
    async (request, reply) => {
      try {
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
      } catch (error) {
        return failed(reply, error);
      }
    },
  );
  app.get("/api/me/sessions", async (request, reply) => {
    try {
      const user = userFor(request.raw);
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
            createdAt: record.createdAt,
          };
        });
      return reply.header("cache-control", "no-store").send({ sessions });
    } catch (error) {
      return failed(reply, error);
    }
  });
  app.delete<{ Params: { sid: string } }>("/api/me/sessions/:sid", async (request, reply) => {
    try {
      await options.lifecycle.run(async () => {
        const user = userFor(request.raw);
        const record = options.sessions.get(request.params.sid);
        if (!record || options.userIdForOwner(record.owner) !== user.id)
          throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前用户或已结束");
        await options.stopSession(record.owner, record.sid);
      });
      return reply.code(204).send();
    } catch (error) {
      return failed(reply, error);
    }
  });
}
