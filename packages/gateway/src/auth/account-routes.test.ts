// @vitest-environment node
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandler } from "../http-errors";
import { afterEach, expect, it, vi } from "vitest";
import { createClientSessions } from "../session/clients";
import { createLifecycleLock } from "../session/lifecycle-lock";
import { registerAccountRoutes } from "./account-routes";
import { createUserGate, USER_COOKIE } from "./user-gate";
import { createUserStore, type UserStore } from "./users";

const apps: FastifyInstance[] = [];
const stores: UserStore[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

async function fixture() {
  const store = await createUserStore({ file: ":memory:", bootstrapPassword: "admin-password" });
  stores.push(store);
  const user = await store.createUser({ username: "alice", password: "alice-password" });
  const sessions = await createClientSessions();
  const local = await sessions.acquire(`${user.id}/device-one`, "local");
  const remote = await sessions.acquire(`${user.id}/device-two`, "remote");
  const other = await sessions.acquire(`${store.bootstrapAdmin.id}/device-one`, "other");
  const login = store.issueSession(user.id);
  const cookie = `${USER_COOKIE}=${login.token}`;
  const app = Fastify();
  registerErrorHandler(app);
  apps.push(app);
  let time = 1_000_000;
  const gate = createUserGate({ store, now: () => time });
  const lifecycle = createLifecycleLock();
  const onPasswordChanged = vi.fn();
  const stopSession = vi.fn((owner: string, sid: string) => sessions.release(owner, sid));
  app.addHook("preHandler", gate.preHandler);
  registerAccountRoutes(app, {
    store,
    sessions,
    lifecycle,
    currentUser: gate.currentUser,
    currentOwner: () => `${user.id}/device-one`,
    userIdForOwner: (owner) => owner.split("/")[0],
    profileName: () => "默认浏览器",
    onlineSessions: () => new Set([local.sid]),
    stopSession,
    onPasswordChanged,
    attempts: gate.attempts,
  });
  return {
    app,
    store,
    user,
    sessions,
    local,
    remote,
    other,
    cookie,
    stopSession,
    onPasswordChanged,
    lifecycle,
    advance: (ms: number) => (time += ms),
  };
}

it("lists and ends the user's sessions across devices without exposing another user", async () => {
  const { app, cookie, local, remote, other, sessions, stopSession } = await fixture();
  const response = await app.inject({ url: "/api/me/sessions", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().sessions).toEqual([
    expect.objectContaining({
      sid: local.sid,
      currentDevice: true,
      profileName: "默认浏览器",
      online: true,
    }),
    expect.objectContaining({ sid: remote.sid, currentDevice: false, online: false }),
  ]);
  expect(response.body).not.toContain("device-one");
  expect(response.body).not.toContain("clientKey");
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/me/sessions/${other.sid}`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(403);
  expect(stopSession).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/me/sessions/${remote.sid}`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(204);
  expect(sessions.get(remote.sid)).toBeUndefined();
  expect(sessions.get(local.sid)).toBeDefined();
  expect(sessions.get(other.sid)).toBeDefined();
});

it("requires the current password and revokes all personal logins after a password change", async () => {
  const { app, store, user, cookie, onPasswordChanged, advance } = await fixture();
  const secondLogin = store.issueSession(user.id);
  const adminLogin = store.issueSession(store.bootstrapAdmin.id);
  const change = (currentPassword: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { cookie },
      payload: { currentPassword, password },
    });
  const wrong = await change("wrong-password", "replacement-password");
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json()).toEqual({ error: "当前密码不正确", code: "CURRENT_PASSWORD" });
  advance(1000);
  expect((await change("alice-password", "short")).statusCode).toBe(400);
  expect(store.session(secondLogin.token)?.id).toBe(user.id);
  expect(onPasswordChanged).not.toHaveBeenCalled();
  expect((await change("alice-password", "replacement-password")).statusCode).toBe(204);
  expect(onPasswordChanged).toHaveBeenCalledWith(user.id);
  expect(store.session(secondLogin.token)).toBeNull();
  expect(store.session(adminLogin.token)?.id).toBe(store.bootstrapAdmin.id);
  expect((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
  expect(await store.authenticate(user.username, "alice-password")).toBeNull();
  expect((await store.authenticate(user.username, "replacement-password"))?.id).toBe(user.id);
});

it("rejects anonymous and disabled users without ending a session", async () => {
  const { app, store, user, cookie, remote, stopSession } = await fixture();
  expect((await app.inject({ url: "/api/me/sessions" })).statusCode).toBe(401);
  await store.updateUser(user.id, { enabled: false });
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/me/sessions/${remote.sid}`,
        headers: { cookie },
      })
    ).statusCode,
  ).toBe(401);
  expect(stopSession).not.toHaveBeenCalled();
});

it("limits password checks per user and IP, and checks outside the lifecycle lock", async () => {
  const { app, cookie, lifecycle, advance, onPasswordChanged } = await fixture();
  const change = (currentPassword: string) =>
    app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { cookie },
      payload: { currentPassword, password: "replacement-password" },
    });
  // Another lifecycle step holds the lock throughout; a wrong password is still answered.
  let releaseLock!: () => void;
  const held = lifecycle.run(() => new Promise<void>((resolve) => (releaseLock = resolve)));
  expect((await change("wrong-password")).statusCode).toBe(400);
  const busy = await change("wrong-password");
  expect(busy.statusCode).toBe(429);
  expect(busy.json()).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
  advance(600);
  expect((await change("wrong-password")).statusCode).toBe(400);
  expect((await change("alice-password")).statusCode).toBe(429);
  advance(1100);
  // The right password waits only for the update itself.
  const pending = change("alice-password");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onPasswordChanged).not.toHaveBeenCalled();
  releaseLock();
  await held;
  expect((await pending).statusCode).toBe(204);
  expect(onPasswordChanged).toHaveBeenCalledOnce();
});
