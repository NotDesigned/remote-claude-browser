// @vitest-environment node
import Fastify, { type FastifyInstance } from "fastify";
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
  apps.push(app);
  const gate = createUserGate({ store });
  const onPasswordChanged = vi.fn();
  const stopSession = vi.fn((owner: string, sid: string) => sessions.release(owner, sid));
  app.addHook("preHandler", gate.preHandler);
  registerAccountRoutes(app, {
    store,
    sessions,
    lifecycle: createLifecycleLock(),
    currentUser: gate.currentUser,
    currentOwner: () => `${user.id}/device-one`,
    userIdForOwner: (owner) => owner.split("/")[0],
    profileName: () => "默认浏览器",
    stopSession,
    onPasswordChanged,
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
  };
}

it("lists and ends the user's sessions across devices without exposing another user", async () => {
  const { app, cookie, local, remote, other, sessions, stopSession } = await fixture();
  const response = await app.inject({ url: "/api/me/sessions", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().sessions).toEqual([
    expect.objectContaining({ sid: local.sid, currentDevice: true, profileName: "默认浏览器" }),
    expect.objectContaining({ sid: remote.sid, currentDevice: false }),
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
  const { app, store, user, cookie, onPasswordChanged } = await fixture();
  const secondLogin = store.issueSession(user.id);
  const adminLogin = store.issueSession(store.bootstrapAdmin.id);
  const change = (currentPassword: string, password: string) =>
    app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { cookie },
      payload: { currentPassword, password },
    });
  expect((await change("wrong-password", "replacement-password")).statusCode).toBe(400);
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
