import { Readable } from "node:stream";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import { createCpaStore, type CpaInstance, type CpaStore } from "./store";
import { createCpaRuntime } from "./runtime";
import type { ExitHealth as CpaExitHealth } from "../egress/timezone";
import type { CpaDriver, CpaRequest } from "./broker-client";
import { cpaInferencePath, registerCpaInferenceRoutes, registerCpaRoutes } from "./routes";
import { registerCpaManagementRoutes } from "./management";

const alice: FrontendUser = {
  id: "alice",
  username: "alice",
  role: "user",
  enabled: true,
  createdAt: 1,
};
const bob: FrontendUser = { ...alice, id: "bob", username: "bob" };
const admin: FrontendUser = { ...alice, id: "admin", username: "admin", role: "admin" };
const response = (body: unknown, statusCode = 200) =>
  Object.assign(Readable.from([JSON.stringify(body)]), {
    statusCode,
    headers: { "content-type": "application/json" },
  }) as unknown as IncomingMessage;
const stores: CpaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
async function fixture() {
  const store = await createCpaStore({ file: ":memory:" });
  stores.push(store);
  const calls: { instance: CpaInstance; input: CpaRequest }[] = [];
  const states = new Map<string, "running" | "stopped" | "missing">();
  const removed: string[] = [];
  const proxies: { userId: string; proxyId: string | undefined }[] = [];
  const users = new Map([alice, bob, admin].map((user) => [user.id, user]));
  let health: CpaExitHealth = {
    status: "healthy",
    timeZone: "Asia/Tokyo",
    exitIp: "203.0.113.1",
    checkedAt: 1,
  };
  let upstream: (instance: CpaInstance, input: CpaRequest) => IncomingMessage = () =>
    response({ status: "ok", files: [] });
  const driver: CpaDriver = {
    async ensure(value) {
      states.set(value.id, "running");
    },
    async stop(value) {
      states.set(value.id, "stopped");
    },
    async remove(value) {
      removed.push(value.id);
      states.delete(value.id);
    },
    async status(value) {
      return states.get(value.id) ?? "missing";
    },
    async request(instance, input) {
      calls.push({ instance, input });
      return upstream(instance, input);
    },
  };
  const runtime = createCpaRuntime({
    store,
    driver,
    userEnabled: (id) => users.get(id)?.enabled === true,
    userName: (id) => users.get(id)?.username,
    async proxyStatusForInstance() {
      return health;
    },
    async checkProxyForUser(user, proxyId) {
      health = {
        status: "healthy",
        timeZone: "Pacific/Honolulu",
        exitIp: "203.0.113.2",
        checkedAt: 2,
      };
      return {
        id: proxyId,
        name: "Private node",
        url: `http://${user.id}:x@runtime-egress:8781`,
        timeZone: "Pacific/Honolulu",
        health,
      };
    },
    async resolveProxyForUser(user, proxyId) {
      proxies.push({ userId: user.id, proxyId });
      if (proxyId === "bobs-proxy" && user.id !== bob.id) throw new Error("not owned");
      if (proxyId === "removed") throw new Error("removed node");
      return {
        id: proxyId ?? "deployment-default",
        name: "Private node",
        timeZone: "Asia/Tokyo",
        health: { status: "healthy", timeZone: "Asia/Tokyo", exitIp: "203.0.113.1", checkedAt: 1 },
        url: `http://${user.id}:x@runtime-egress:8781`,
      };
    },
  });
  return {
    store,
    runtime,
    calls,
    driver,
    users,
    states,
    removed,
    proxies,
    setHealth(value: CpaExitHealth) {
      health = value;
    },
    setUpstream(value: typeof upstream) {
      upstream = value;
    },
  };
}

describe("CPA instance and key boundaries", () => {
  it("persists instance keys and binding metadata in a private database across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cpa-store-test-"));
    try {
      const file = join(dir, "cpa.sqlite");
      const first = await createCpaStore({ file });
      const value = first.create(alice);
      const key = first.issueKey(value.id, "saved-client", alice.id);
      first.setDesiredState(value.id, "running");
      first.setCredentialProxy(value.id, "claude.json", "node-a");
      first.recordOAuth(value.id, "saved-state", "claude", "node-a");
      first.close();
      const reopened = await createCpaStore({ file });
      try {
        expect(reopened.get(value.id)).toEqual({ ...value, desiredState: "running" });
        expect(reopened.resolveKey(key.token)?.instance.id).toBe(value.id);
        expect(reopened.credentialBindings(value.id)).toEqual([
          { name: "claude.json", proxyId: "node-a" },
        ]);
        expect(reopened.oauth(value.id, "saved-state")).toEqual({
          provider: "claude",
          proxyId: "node-a",
        });
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("restores running tenants and persisted credential egress without failing other tenants", async () => {
    const { store, runtime, users, states, proxies, calls } = await fixture();
    const a = store.create(alice),
      b = store.create(bob),
      shared = store.create(admin, "shared");
    for (const value of [a, b, shared]) store.setDesiredState(value.id, "running");
    store.setCredentialProxy(a.id, "a.json", "node-a");
    store.setCredentialProxy(a.id, "removed.json", "removed");
    store.recordOAuth(a.id, "removed-pending", "claude", "removed");
    store.setCredentialProxy(b.id, "b.json", "bobs-proxy");
    store.setCredentialProxy(shared.id, "shared.json", "deployment-default");
    let sharedAdmin = admin;
    const lookup = (value: CpaInstance) =>
      value.ownerId === null ? sharedAdmin : users.get(value.ownerId);
    const result = await runtime.restore(lookup);
    expect(result.restored.sort()).toEqual([a.id, b.id, shared.id].sort());
    expect(result.failures).toEqual([
      { instanceId: a.id, proxyId: "removed", code: "CPA_OAUTH_PROXY_RESTORE" },
      { instanceId: a.id, proxyId: "removed", code: "CPA_PROXY_RESTORE" },
    ]);
    expect(states.get(a.id)).toBe("running");
    expect(proxies).toContainEqual({ userId: bob.id, proxyId: "bobs-proxy" });
    expect(proxies.some((entry) => entry.proxyId === undefined)).toBe(false);
    sharedAdmin = { ...admin, id: "another-admin" };
    calls.length = 0;
    await runtime.restoreBindings(["deployment-default"], lookup);
    expect(calls.some((call) => call.input.path.endsWith("/credentials/fields"))).toBe(false);
    proxies.length = 0;
    await runtime.restoreBindings(["node-a"], lookup);
    expect(proxies).toEqual([{ userId: alice.id, proxyId: "node-a" }]);
    await runtime.stop(alice, a.id);
    proxies.length = 0;
    const started = await runtime.start(alice, a.id);
    expect(proxies).toContainEqual({ userId: alice.id, proxyId: "node-a" });
    expect(started.proxyFailures).toHaveLength(2);
    users.set(bob.id, { ...bob, enabled: false });
    states.delete(b.id);
    const disabled = await runtime.restore(lookup);
    expect(disabled.restored).not.toContain(b.id);
    expect(states.has(b.id)).toBe(false);
  });
  it("creates independent owners and shared storage identities with no key fallback", async () => {
    const { store, runtime } = await fixture();
    const ownA = store.create(alice),
      ownB = store.create(bob),
      shared = store.create(admin, "shared");
    expect(store.create(alice).id).toBe(ownA.id);
    expect(new Set([ownA.id, ownB.id, shared.id]).size).toBe(3);
    expect(ownA.apiKey).not.toBe(ownB.apiKey);
    expect(ownA.managementKey).not.toBe(ownB.managementKey);
    expect(store.listFor(alice).map((value) => value.id)).toEqual(
      [ownA.id, shared.id].sort((a, b) => {
        const first = store.get(a)!,
          second = store.get(b)!;
        return first.createdAt - second.createdAt || a.localeCompare(b);
      }),
    );
    expect(() => store.create(alice, "shared")).toThrow();
    expect(() => store.requireManaged(alice, ownB.id)).toThrow();
    expect(() => store.requireManaged(alice, shared.id)).toThrow();
    expect(() => store.requireManaged(admin, ownA.id)).toThrow();
    const key = store.issueKey(ownA.id, "laptop", alice.id);
    expect(key.token).toMatch(/^rcpa_[A-Za-z0-9_-]{43}$/);
    store.setDesiredState(ownA.id, "running");
    expect(runtime.inference(key.token).id).toBe(ownA.id);
    expect(() => runtime.inference("invalid")).toThrow("调用密钥无效");
    expect(JSON.stringify(store.listKeys(ownA.id))).not.toContain(key.token);
    store.revokeKey(ownB.id, key.id);
    expect(runtime.inference(key.token).id).toBe(ownA.id);
    store.revokeKey(ownA.id, key.id);
    expect(() => runtime.inference(key.token)).toThrow();
    const listed = await runtime.list(alice);
    expect(JSON.stringify(listed)).not.toContain(ownA.apiKey);
    expect(JSON.stringify(listed)).not.toContain(ownA.managementKey);
  });
  it("lets shared-pool users manage only their own keys and revokes use with their workspace account", async () => {
    const { store, runtime, users } = await fixture();
    const shared = store.create(admin, "shared");
    await runtime.start(admin, shared.id);
    const app = Fastify();
    registerCpaRoutes(app, {
      runtime,
      currentUser: (req) => users.get(String(req.headers["x-test-user"])),
    });
    registerCpaInferenceRoutes(app, runtime);
    const keysPath = `/api/cpa/instances/${shared.id}/keys`;
    const request = (
      user: FrontendUser,
      method: "GET" | "POST" | "DELETE",
      url: string,
      payload?: object,
    ) => app.inject({ method, url, headers: { "x-test-user": user.id }, payload });
    try {
      const created = await request(alice, "POST", keysPath, { name: "Alice client" });
      expect(created.statusCode).toBe(200);
      const key = created.json().key;
      expect(key).toMatchObject({ userId: alice.id, username: alice.username });
      const bobsKey = runtime.issueKey(bob, shared.id, "Bob client");
      expect((await request(alice, "GET", keysPath)).json().keys).toEqual([
        expect.objectContaining({ id: key.id, userId: alice.id }),
      ]);
      expect((await request(admin, "GET", keysPath)).json().keys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: key.id, username: alice.username }),
          expect.objectContaining({ id: bobsKey.id, username: bob.username }),
        ]),
      );
      expect((await request(bob, "DELETE", `${keysPath}/${key.id}`)).statusCode).toBe(403);
      for (const [method, suffix] of [
        ["GET", "credentials"],
        ["POST", "start"],
        ["POST", "stop"],
      ] as const)
        expect(
          (await request(alice, method, `/api/cpa/instances/${shared.id}/${suffix}`)).statusCode,
        ).toBe(403);
      expect(runtime.inference(key.token).id).toBe(shared.id);
      users.set(alice.id, { ...alice, enabled: false });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/models",
            headers: { authorization: `Bearer ${key.token}` },
          })
        ).statusCode,
      ).toBe(401);
      expect((await request(alice, "POST", keysPath, { name: "disabled" })).statusCode).toBe(401);
      expect(runtime.inference(bobsKey.token).id).toBe(shared.id);
      users.delete(alice.id);
      expect(() => runtime.inference(key.token)).toThrow("调用密钥无效");
      expect(
        runtime.listKeys(admin, shared.id).find((entry) => entry.id === key.id)?.username,
      ).toBeNull();
      expect((await request(admin, "DELETE", `${keysPath}/${key.id}`)).statusCode).toBe(200);
      expect((await request(bob, "DELETE", `${keysPath}/${bobsKey.id}`)).statusCode).toBe(200);
      expect(() => runtime.inference(bobsKey.token)).toThrow("调用密钥无效");
    } finally {
      await app.close();
    }
  });
  it("disabling or deleting an owner invalidates existing API keys", async () => {
    const { store, runtime, users } = await fixture();
    const value = store.create(alice);
    store.setDesiredState(value.id, "running");
    const key = store.issueKey(value.id, "client", alice.id);
    users.set(alice.id, { ...alice, enabled: false });
    expect(() => runtime.inference(key.token)).toThrow();
    users.delete(alice.id);
    expect(() => runtime.inference(key.token)).toThrow();
    users.set(alice.id, alice);
    expect(runtime.inference(key.token).id).toBe(value.id);
    store.revokeUserKeys(alice.id);
    expect(() => runtime.inference(key.token)).toThrow();
  });
  it("removes only a deleted user's CPA data after its container and volumes are removed", async () => {
    const { store, runtime, driver, removed, users } = await fixture();
    const own = store.create(alice),
      other = store.create(bob),
      shared = store.create(admin, "shared");
    const privateKey = store.issueKey(own.id, "private", alice.id);
    const sharedKey = store.issueKey(shared.id, "shared", alice.id);
    const otherKey = store.issueKey(shared.id, "other", bob.id);
    store.setCredentialProxy(own.id, "private.json", "node-a");
    store.recordOAuth(own.id, "private-oauth", "claude", "node-a");
    store.setCredentialProxy(shared.id, "shared.json", "node-shared");
    users.set(alice.id, { ...alice, enabled: false });
    const remove = driver.remove;
    driver.remove = async () => {
      throw new Error("volume still in use");
    };
    await expect(runtime.removeUser(alice.id)).rejects.toThrow("volume still in use");
    expect(store.get(own.id)).toEqual(own);
    expect(store.resolveKey(sharedKey.token)?.userId).toBe(alice.id);
    driver.remove = remove;
    await runtime.removeUser(alice.id);
    expect(removed).toEqual([own.id]);
    expect(store.get(own.id)).toBeUndefined();
    expect(store.credentialBindings(own.id)).toEqual([]);
    expect(store.pendingOAuth(own.id)).toEqual([]);
    expect(store.resolveKey(privateKey.token)).toBeUndefined();
    expect(store.resolveKey(sharedKey.token)).toBeUndefined();
    expect(store.resolveKey(otherKey.token)?.userId).toBe(bob.id);
    expect(store.get(other.id)).toEqual(other);
    expect(store.credentialProxy(shared.id, "shared.json")).toBe("node-shared");
    await runtime.removeUser(alice.id);
    expect(removed).toEqual([own.id]);
  });
});

describe("CPA authorization lifecycle", () => {
  it("restores pending forms only to the manager and captures the matching browser callback once", async () => {
    const { store, runtime, setUpstream, calls } = await fixture();
    const value = store.create(alice);
    store.setDesiredState(value.id, "running");
    const url =
      "https://claude.ai/oauth/authorize?state=capture-state&redirect_uri=" +
      encodeURIComponent("http://localhost:54545/callback");
    const callback = "http://localhost:54545/callback?code=one-time-code&state=capture-state";
    let finished = false;
    setUpstream((_instance, input) => {
      if (input.path.endsWith("/oauth/auth-url")) return response({ state: "capture-state", url });
      if (input.path.endsWith("/oauth/callback")) {
        finished = true;
        return response({ status: "ok" });
      }
      if (input.path.includes("/oauth/status?"))
        return response(finished ? { status: "ok", auth_id: "capture-auth" } : { status: "wait" });
      return response({ files: finished ? [{ id: "capture-auth", name: "captured.json" }] : [] });
    });
    await runtime.startOAuth(alice, value.id, "node-a");
    const app = Fastify();
    registerCpaRoutes(app, {
      runtime,
      currentUser: (req) =>
        req.headers.cookie === "user=alice"
          ? alice
          : req.headers.cookie === "user=bob"
            ? bob
            : null,
    });
    try {
      const path = `/api/cpa/instances/${value.id}/oauth`;
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      expect((await app.inject({ url: path, headers: { cookie: "user=bob" } })).statusCode).toBe(
        403,
      );
      const restored = await app.inject({ url: path, headers: { cookie: "user=alice" } });
      expect(restored.json()).toEqual({
        sessions: [{ state: "capture-state", proxyId: "node-a", url }],
      });
      expect(runtime.browserAuthorizing(alice, "node-a", url)).toBe(true);
      expect(runtime.browserAuthorizing(alice, "node-a", callback)).toBe(true);
      expect(runtime.browserAuthorizing(alice, "node-a", "https://claude.ai/new")).toBe(false);
      for (const [user, proxy, address] of [
        [bob, "node-a", callback],
        [admin, "node-a", callback],
        [alice, "node-b", callback],
        [alice, "node-a", callback.replace("localhost", "evil.example")],
        [alice, "node-a", callback.replace("/callback?", "/other?")],
        [alice, "node-a", callback.replace("capture-state", "foreign-state")],
        [alice, "node-a", url],
      ] as const)
        expect(await runtime.captureBrowserCallback(user, proxy, address)).toBe(false);
      expect(calls.filter((call) => call.input.path.endsWith("/oauth/callback"))).toHaveLength(0);
      expect(
        await Promise.all([
          runtime.captureBrowserCallback(alice, "node-a", callback),
          runtime.captureBrowserCallback(alice, "node-a", callback),
        ]),
      ).toEqual([true, true]);
      const submitted = calls.filter((call) => call.input.path.endsWith("/oauth/callback"));
      expect(submitted).toHaveLength(1);
      expect(JSON.parse(String(submitted[0]!.input.body))).toEqual({
        provider: "claude",
        state: "capture-state",
        redirect_url: callback,
      });
      await runtime.reconcileOAuth(() => alice);
      expect(store.credentialBindings(value.id)).toEqual([
        { name: "captured.json", proxyId: "node-a" },
      ]);
      expect(runtime.pendingOAuth(alice, value.id)).toEqual([]);
      expect(runtime.browserAuthorizing(alice, "node-a", callback)).toBe(false);
      expect(await runtime.captureBrowserCallback(alice, "node-a", callback)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("saves completed authorization without any browser status request", async () => {
    const { store, runtime, setUpstream } = await fixture();
    const value = store.create(alice);
    store.setDesiredState(value.id, "running");
    let finished = false;
    setUpstream((_instance, input) => {
      if (input.path.endsWith("/oauth/auth-url"))
        return response({ state: "background-state", url: "https://claude.ai/oauth" });
      if (input.path.endsWith("/oauth/callback")) {
        finished = true;
        return response({ status: "ok" });
      }
      if (input.path.includes("/oauth/status?"))
        return response(finished ? { status: "ok", auth_id: "auth-a" } : { status: "wait" });
      if (input.path.includes("/credentials/download?"))
        return response({
          proxy_url: "http://alice:x@runtime-egress:8781",
          access_token: "never-return-this",
        });
      return response({ files: finished ? [{ id: "auth-a", name: "a.json" }] : [] });
    });
    await runtime.startOAuth(alice, value.id, "node-a");
    expect(runtime.oauthPage(alice, value.id, "background-state")).toEqual({
      url: "https://claude.ai/oauth",
      proxyId: "node-a",
    });
    await runtime.oauthCallback(alice, value.id, {
      state: "background-state",
      code: "fixture-code",
    });
    expect(store.credentialBindings(value.id)).toEqual([]);
    expect((await runtime.reconcileOAuth(() => alice)).failures).toEqual([]);
    expect(store.credentialBindings(value.id)).toEqual([{ name: "a.json", proxyId: "node-a" }]);
    expect(store.pendingOAuth(value.id)).toEqual([]);
    expect(() => runtime.oauthPage(alice, value.id, "background-state")).toThrow(
      "请重新生成授权链接",
    );
    await runtime.credentialProxy(alice, value.id, "a.json", "node-b");
    await runtime.oauthStatus(alice, value.id, "background-state");
    expect(store.credentialProxy(value.id, "a.json")).toBe("node-b");
  });
  it.each(["restore", "status"])(
    "recovers reauthorization after CPA loses OAuth state via %s",
    async (mode) => {
      const { store, runtime, proxies, setUpstream } = await fixture();
      const value = store.create(alice);
      store.setDesiredState(value.id, "running");
      store.recordOAuth(value.id, "lost-state", "claude", "node-a", "https://claude.ai/oauth");
      store.setCredentialProxy(value.id, "a.json", "old-node");
      setUpstream((_instance, input) => {
        if (input.path.includes("/oauth/status?"))
          return response({ status: "error", error: "unknown or expired state" });
        if (input.path.includes("/credentials/download?name=legacy.json"))
          return response({ proxy_url: "http://legacy.invalid:8782" });
        if (input.path.includes("/credentials/download?"))
          return response({ proxy_url: "http://alice:x@runtime-egress:8781" });
        return response({ files: [{ name: "a.json" }, { name: "legacy.json" }] });
      });
      if (mode === "restore") expect((await runtime.restore(() => alice)).failures).toEqual([]);
      else await runtime.oauthStatus(alice, value.id, "lost-state");
      expect(proxies).toContainEqual({ userId: alice.id, proxyId: "node-a" });
      expect(store.credentialBindings(value.id)).toEqual([{ name: "a.json", proxyId: "node-a" }]);
      await runtime.reconcileOAuth(() => alice);
      expect(store.pendingOAuth(value.id)).toEqual([]);
    },
  );
  it("stops a suspended user's CPA, preserving credentials and other instances", async () => {
    const { store, runtime, users, states } = await fixture();
    const own = store.create(alice),
      other = store.create(bob),
      shared = store.create(admin, "shared");
    for (const [user, value] of [
      [alice, own],
      [bob, other],
      [admin, shared],
    ] as const)
      await runtime.start(user, value.id);
    store.setCredentialProxy(own.id, "saved.json", "node-a");
    users.set(alice.id, { ...alice, enabled: false });
    await runtime.suspendUser(alice.id);
    expect(states.get(own.id)).toBe("stopped");
    expect(store.get(own.id)?.desiredState).toBe("stopped");
    expect(store.credentialBindings(own.id)).toEqual([{ name: "saved.json", proxyId: "node-a" }]);
    expect(states.get(other.id)).toBe("running");
    expect(states.get(shared.id)).toBe("running");
    await expect(runtime.start(alice, own.id)).rejects.toMatchObject({ code: "USER_DISABLED" });
  });
});

describe("CPA v8 contract", () => {
  it.each([undefined, null, "", " ", "deployment-default", " deployment-default "])(
    "rejects a missing or implicit public exit before resolving a proxy or creating OAuth state: %j",
    async (proxyId) => {
      const { store, runtime, calls, proxies, setUpstream } = await fixture();
      const value = store.create(alice);
      store.setDesiredState(value.id, "running");
      store.setCredentialProxy(value.id, "claude.json", "existing-node");
      setUpstream(() => response({ state: "must-not-exist", url: "https://login.example" }));

      await expect(runtime.startOAuth(alice, value.id, proxyId as never)).rejects.toMatchObject({
        statusCode: 400,
        code: "CPA_PROXY_REQUIRED",
      });
      await expect(
        runtime.credentialProxy(alice, value.id, "claude.json", proxyId as never),
      ).rejects.toMatchObject({ statusCode: 400, code: "CPA_PROXY_REQUIRED" });
      expect(proxies).toEqual([]);
      expect(calls).toEqual([]);
      expect(store.oauth(value.id, "must-not-exist")).toBeUndefined();
      expect(store.credentialProxy(value.id, "claude.json")).toBe("existing-node");
    },
  );

  it("checks instance ownership before public exit validation or proxy resolution", async () => {
    const { store, runtime, calls, proxies } = await fixture();
    const other = store.create(bob);
    const shared = store.create(admin, "shared");
    for (const value of [other, shared]) {
      for (const proxyId of [undefined, null, "", "deployment-default", "my-node"]) {
        await expect(runtime.startOAuth(alice, value.id, proxyId as never)).rejects.toMatchObject({
          statusCode: 403,
          code: "CPA_FORBIDDEN",
        });
        await expect(
          runtime.credentialProxy(alice, value.id, "claude.json", proxyId as never),
        ).rejects.toMatchObject({ statusCode: 403, code: "CPA_FORBIDDEN" });
      }
    }
    expect(proxies).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("disables unbound credentials and starts without selecting an implicit exit", async () => {
    const { store, runtime, calls, proxies, setUpstream } = await fixture();
    const value = store.create(admin);
    setUpstream(() => response({ files: [{ name: "migrated-claude.json", provider: "claude" }] }));
    await runtime.start(admin, value.id);
    expect((await runtime.credentials(admin, value.id))[0]).toMatchObject({
      name: "migrated-claude.json",
      proxyId: null,
    });
    expect(await runtime.restore(() => admin)).toEqual({ restored: [value.id], failures: [] });
    expect(proxies).toEqual([]);
    expect(store.credentialBindings(value.id)).toEqual([]);
    expect(
      calls
        .filter((call) => call.input.method === "PATCH")
        .map((call) => JSON.parse(String(call.input.body))),
    ).toEqual([
      { name: "migrated-claude.json", disabled: true },
      { name: "migrated-claude.json", disabled: true },
    ]);
    expect(
      calls
        .filter((call) => call.input.method === "PUT")
        .every(
          (call) =>
            JSON.parse(String(call.input.body)) === "http://cpa-unbound:x@runtime-egress:8781",
        ),
    ).toBe(true);
    await expect(
      runtime.credentialStatus(admin, value.id, "migrated-claude.json", false),
    ).rejects.toMatchObject({ code: "CPA_PROXY_REQUIRED" });
  });

  it("requires explicit node IDs on public OAuth and credential proxy routes", async () => {
    const { store, runtime, calls, proxies, setUpstream } = await fixture();
    const value = store.create(alice);
    const other = store.create(bob);
    store.setDesiredState(value.id, "running");
    setUpstream((_instance, input) =>
      input.path === "/v8/management/oauth/auth-url"
        ? response({ state: "explicit-state", url: "https://login.example" })
        : response({ status: "ok" }),
    );
    const app = Fastify();
    registerCpaRoutes(app, {
      runtime,
      currentUser: (req) => (req.headers.cookie === "user=alice" ? alice : null),
    });
    try {
      for (const proxyId of [
        undefined,
        null,
        "",
        " ",
        "deployment-default",
        " deployment-default ",
      ]) {
        const node = proxyId === undefined ? {} : { proxyId };
        for (const [method, path, body] of [
          ["POST", "/oauth", { provider: "claude", ...node }],
          ["PATCH", "/credentials/proxy", { name: "claude.json", ...node }],
        ] as const) {
          const result = await app.inject({
            method,
            url: `/api/cpa/instances/${value.id}${path}`,
            headers: { cookie: "user=alice" },
            payload: body,
          });
          expect(result.statusCode).toBe(400);
        }
      }
      expect(proxies).toEqual([]);
      expect(calls).toEqual([]);
      expect(store.oauth(value.id, "explicit-state")).toBeUndefined();
      expect(store.credentialBindings(value.id)).toEqual([]);

      for (const [method, path, body] of [
        ["POST", "/oauth", { provider: "claude", proxyId: "explicit-node" }],
        ["PATCH", "/credentials/proxy", { name: "claude.json", proxyId: "explicit-node" }],
      ] as const) {
        const denied = await app.inject({
          method,
          url: `/api/cpa/instances/${other.id}${path}`,
          headers: { cookie: "user=alice" },
          payload: body,
        });
        expect(denied.statusCode).toBe(403);
        const anonymous = await app.inject({
          method,
          url: `/api/cpa/instances/${value.id}${path}`,
          payload: body,
        });
        expect(anonymous.statusCode).toBe(401);
      }
      expect(proxies).toEqual([]);
      expect(calls).toEqual([]);

      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/cpa/instances/${value.id}/oauth`,
            headers: { cookie: "user=alice" },
            payload: { provider: "claude", proxyId: "explicit-node" },
          })
        ).statusCode,
      ).toBe(200);
      expect(store.oauth(value.id, "explicit-state")?.proxyId).toBe("explicit-node");
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/cpa/instances/${value.id}/credentials/proxy`,
            headers: { cookie: "user=alice" },
            payload: { name: "claude.json", proxyId: "different-node" },
          })
        ).statusCode,
      ).toBe(200);
      expect(store.credentialProxy(value.id, "claude.json")).toBe("different-node");
      expect(proxies.map((proxy) => proxy.proxyId)).toEqual(["explicit-node", "different-node"]);
      expect(calls.map((call) => call.input.path)).toEqual([
        "/v8/management/oauth/auth-url",
        "/v8/management/credentials/fields",
      ]);
    } finally {
      await app.close();
    }
  });

  it("forwards proxy selection through supported body fields without exposing URLs", async () => {
    const { store, runtime, calls, setUpstream } = await fixture();
    const value = store.create(alice);
    await runtime.start(alice, value.id);
    setUpstream((_instance, input) =>
      input.path === "/v8/management/credentials"
        ? response({
            files: [
              {
                id: "credential-id",
                name: "claude.json",
                provider: "claude",
                email: "alice@example.test",
                disabled: false,
                proxy_url: "http://secret:x@runtime-egress:8781",
                path: "/auth/claude.json",
                access_token: "secret-token",
                id_token: { secret: "value" },
              },
            ],
          })
        : input.path === "/v8/management/oauth/auth-url"
          ? response({
              status: "ok",
              state: "state-a",
              url: "https://claude.ai/oauth?state=state-a",
            })
          : response({ status: "ok", auth_id: "credential-id" }),
    );
    await runtime.credentialProxy(alice, value.id, "claude.json", "my-proxy");
    expect(calls.at(-1)?.input.path).toBe("/v8/management/credentials/fields");
    expect(JSON.parse(String(calls.at(-1)?.input.body))).toEqual({
      name: "claude.json",
      proxy_url: "http://alice:x@runtime-egress:8781",
      timezone: "Asia/Tokyo",
    });
    const items = await runtime.credentials(alice, value.id);
    expect(items[0]?.proxyId).toBe("my-proxy");
    expect(items[0]?.email).toBe("alice@example.test");
    expect(JSON.stringify(items)).not.toMatch(/opaque|secret|\/auth|id_token/);
    await runtime.startOAuth(alice, value.id, "oauth-node");
    expect(calls.at(-1)?.input.path).toBe("/v8/management/oauth/auth-url");
    expect(JSON.parse(String(calls.at(-1)?.input.body))).toEqual({
      provider: "claude",
      proxy_url: "http://alice:x@runtime-egress:8781",
    });
    await runtime.oauthStatus(alice, value.id, "state-a");
    expect(
      calls.some((call) => call.input.path === "/v8/management/oauth/status?state=state-a"),
    ).toBe(true);
    expect(store.credentialProxy(value.id, "claude.json")).toBe("oauth-node");
    await runtime.oauthCallback(alice, value.id, { state: "state-a", code: "code-a" });
    expect(JSON.parse(String(calls.at(-1)?.input.body))).toEqual({
      provider: "claude",
      state: "state-a",
      code: "code-a",
    });
    const other = store.create(bob);
    await runtime.start(bob, other.id);
    await expect(runtime.oauthStatus(bob, other.id, "state-a")).rejects.toThrow("没有这个登录会话");
    const count = calls.length;
    await expect(
      runtime.credentialProxy(alice, other.id, "claude.json", "my-proxy"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(count);
    await expect(
      runtime.credentialProxy(alice, value.id, "claude.json", "bobs-proxy"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(count);
  });
  it("refreshes a credential timezone from a free exit check without exposing shared-pool details", async () => {
    const { store, runtime, calls, setUpstream } = await fixture();
    const shared = store.create(admin, "shared");
    await runtime.start(admin, shared.id);
    setUpstream((_value, input) =>
      input.path.endsWith("/credentials")
        ? response({
            files: [{ name: "shared.json", email: "private@example.test", provider: "claude" }],
          })
        : response({ status: "ok" }),
    );
    await runtime.credentialProxy(admin, shared.id, "shared.json", "node-a");
    expect((await runtime.credentials(admin, shared.id))[0]?.timeZone).toBe("Asia/Tokyo");
    const checked = await runtime.check(admin, shared.id);
    expect(checked).toMatchObject({ authorization: "ready", egress: "healthy" });
    expect((await runtime.credentials(admin, shared.id))[0]).toMatchObject({
      timeZone: "Pacific/Honolulu",
      exitHealth: { exitIp: "203.0.113.2" },
    });
    const patch = calls.filter((call) => call.input.path.endsWith("/credentials/fields")).at(-1);
    expect(JSON.parse(String(patch?.input.body))).toMatchObject({ timezone: "Pacific/Honolulu" });
    expect(calls.some((call) => call.input.path.startsWith("/v1/"))).toBe(false);
    await expect(runtime.check(alice, shared.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(JSON.stringify(await runtime.list(alice))).not.toMatch(
      /private@example|203\.0\.113|Honolulu|node-a/,
    );
  });

  it("reports a dead exit immediately and synchronizes recovered timezone without changing its proxy", async () => {
    const { store, runtime, calls, proxies, setHealth, setUpstream } = await fixture();
    const value = store.create(alice);
    await runtime.start(alice, value.id);
    setUpstream((_value, input) =>
      input.path.endsWith("/credentials")
        ? response({ files: [{ name: "a.json", provider: "claude" }] })
        : response({ status: "ok" }),
    );
    await runtime.credentialProxy(alice, value.id, "a.json", "node-a");
    setHealth({ status: "error", error: "Exit process stopped" });
    const resolved = proxies.length;
    expect((await runtime.list(alice))[0]?.egress).toBe("error");
    expect((await runtime.credentials(alice, value.id))[0]?.exitHealth.status).toBe("error");
    setHealth({ status: "healthy", timeZone: "Pacific/Honolulu", exitIp: "203.0.113.2" });
    calls.length = 0;
    expect((await runtime.reconcileOAuth(() => alice)).failures).toEqual([]);
    expect(calls.map((call) => JSON.parse(String(call.input.body)))).toEqual([
      { name: "a.json", timezone: "Pacific/Honolulu" },
    ]);
    calls.length = 0;
    await runtime.reconcileOAuth(() => alice);
    expect(calls).toEqual([]);
    expect(proxies.length).toBe(resolved);
  });

  it("keeps shared-pool inference available while an administrator adds another authorization", async () => {
    const { store, runtime, calls, setUpstream } = await fixture();
    const value = store.create(admin, "shared");
    await runtime.start(admin, value.id);
    store.setCredentialProxy(value.id, "existing.json", "node-existing");
    const key = runtime.issueKey(alice, value.id, "client");
    let expired = false;
    setUpstream((_value, input) => {
      if (input.path.endsWith("/oauth/auth-url"))
        return response({ state: expired ? "expired" : "pending", url: "https://claude.ai/oauth" });
      if (input.path.includes("/oauth/status?")) return response({ status: "error" });
      if (input.path.endsWith("/credentials"))
        return response({ files: [{ name: "existing.json" }] });
      return response({ status: "ok" });
    });
    await runtime.startOAuth(admin, value.id, "node-a");
    expect(runtime.inference(key.token).id).toBe(value.id);
    expect(store.credentialProxy(value.id, "existing.json")).toBe("node-existing");
    expect(JSON.parse(String(calls.at(-1)?.input.body))).toEqual({
      provider: "claude",
      proxy_url: "http://admin:x@runtime-egress:8781",
    });
    await runtime.cancelOAuth(admin, value.id);
    expect(runtime.inference(key.token).id).toBe(value.id);
    expired = true;
    await runtime.startOAuth(admin, value.id, "node-a");
    await runtime.reconcileOAuth(() => admin);
    expect(runtime.inference(key.token).id).toBe(value.id);
  });

  it("cookie-protected management and API-key inference enforce separate authorization", async () => {
    const { store, runtime, calls, setUpstream } = await fixture();
    const value = store.create(alice);
    await runtime.start(alice, value.id);
    const key = store.issueKey(value.id, "client", alice.id);
    const other = store.create(bob);
    const app = Fastify();
    registerCpaRoutes(app, {
      runtime,
      currentUser: (req) => (req.headers.cookie === "user=alice" ? alice : null),
    });
    registerCpaInferenceRoutes(app, runtime);
    const denied = await app.inject({
      method: "GET",
      url: `/api/cpa/instances/${other.id}/keys`,
      headers: { cookie: "user=alice" },
    });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/cpa/instances" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/v1/models", headers: { cookie: "user=alice" } }))
        .statusCode,
    ).toBe(401);
    setUpstream(
      () =>
        Object.assign(Readable.from(['data: {"part":1}\n\n', "data: [DONE]\n\n"]), {
          statusCode: 429,
          headers: {
            "content-type": "text/event-stream",
            "retry-after": "13",
            "x-request-id": "upstream-a",
          },
        }) as unknown as IncomingMessage,
    );
    const result = await app.inject({
      method: "POST",
      url: "/v1/messages?beta=true",
      headers: {
        "x-api-key": key.token,
        cookie: "user=bob",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      payload: { model: "claude", stream: true },
    });
    expect(result.statusCode).toBe(429);
    expect(result.headers["retry-after"]).toBe("13");
    expect(result.body).toBe('data: {"part":1}\n\ndata: [DONE]\n\n');
    expect(calls.at(-1)?.instance.id).toBe(value.id);
    expect(calls.at(-1)?.input.path).toBe("/v1/messages?beta=true");
    expect(calls.at(-1)?.input.headers?.authorization).toBe(`Bearer ${value.apiKey}`);
    expect(calls.at(-1)?.input.headers).not.toHaveProperty("cookie");
    expect(calls.at(-1)?.input.headers).not.toHaveProperty("x-api-key");
    const before = calls.length;
    // inject() resolves dot segments itself, so send the raw request line over real HTTP.
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const rawStatus = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest(`${address}/`, {
          path,
          headers: { "x-api-key": key.token },
        });
        outgoing.on("response", (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
    for (const path of [
      "/v1/../v0/management/config",
      "/v1/%2e%2e/v0/management/config",
      "/v1/..%2Fv0/management/config",
      "/v1/%2E%2E%2Fv8/management/config",
    ])
      expect(await rawStatus(path), path).toBe(400);
    expect(calls.length).toBe(before);
    setUpstream(
      () =>
        Object.assign(Readable.from(["{}"]), {
          statusCode: 200,
          headers: { "content-type": "application/json" },
        }) as unknown as IncomingMessage,
    );
    const normalized = await app.inject({
      method: "GET",
      url: "/v1/models/./x/../list?limit=1",
      headers: { "x-api-key": key.token },
    });
    expect(normalized.statusCode).toBe(200);
    expect(calls.at(-1)?.input.path).toBe("/v1/models/list?limit=1");
    await app.close();
  });

  it("normalizes inference paths and keeps them under /v1/", () => {
    expect(cpaInferencePath("/v1/messages?beta=true")).toBe("/v1/messages?beta=true");
    expect(cpaInferencePath("/v1/a/./b/../c")).toBe("/v1/a/c");
    for (const raw of [
      "/v1/../v0/management/x",
      "/v1/%2e%2e/admin",
      "/v1/..%2fadmin",
      "/v1/a%5c..%5cb",
      "/v1\\..\\v0/management/x",
      "//evil.example/v1/x",
      "/v2/x",
      "v1/x",
    ])
      expect(cpaInferencePath(raw), raw).toBeUndefined();
  });
});

it("opens instance-scoped native management using workbench authorization without exposing management keys", async () => {
  const { store, runtime, calls, setUpstream } = await fixture();
  const own = store.create(alice),
    other = store.create(bob),
    shared = store.create(admin, "shared");
  for (const value of [own, other, shared]) store.setDesiredState(value.id, "running");
  const dir = await mkdtemp(join(tmpdir(), "native-cpa-"));
  const panelFile = join(dir, "management.html");
  await writeFile(panelFile, "<!doctype html><html><head></head><body>Native panel</body></html>");
  const app = Fastify();
  registerCpaManagementRoutes(app, {
    runtime,
    panelFile,
    currentUser: (req) =>
      [alice, bob, admin].find((user) => req.headers.cookie === `user=${user.id}`),
  });
  const get = (url: string, user = alice) =>
    app.inject({ url, headers: { cookie: `user=${user.id}` } });
  const root = `/api/cpa/instances/${own.id}/manage`;
  try {
    const page = await get(root + "/management.html");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Native panel");
    expect(page.body).toContain(root);
    expect(page.body).not.toContain(own.managementKey);
    expect((await get(root + "/management.html", bob)).statusCode).toBe(403);
    expect((await get(root + "/management.html", admin)).statusCode).toBe(403);
    expect((await app.inject({ url: root + "/management.html" })).statusCode).toBe(401);
    expect(
      (await get(`/api/cpa/instances/${shared.id}/manage/management.html`, admin)).statusCode,
    ).toBe(200);
    expect(
      (await get(`/api/cpa/instances/${shared.id}/manage/management.html`, bob)).statusCode,
    ).toBe(403);
    expect((await get("/management.html")).headers.location).toBe(root + "/management.html");
    const proxied = await app.inject({
      method: "PUT",
      url: root + "/v8/management/config/observability/logs/debug",
      headers: {
        cookie: "user=alice",
        authorization: "Bearer browser-value",
        "content-type": "application/json",
      },
      payload: "true",
    });
    expect(proxied.statusCode).toBe(200);
    expect(calls.at(-1)?.input).toMatchObject({
      path: "/v8/management/config/observability/logs/debug",
      headers: { authorization: `Bearer ${own.managementKey}` },
    });
    expect(calls.at(-1)?.input.headers?.cookie).toBeUndefined();
    expect(String(calls.at(-1)?.input.body)).toBe("true");
    const listing = { files: [{ name: "claude-fixture.json" }] };
    setUpstream(
      () =>
        Object.assign(Readable.from([gzipSync(JSON.stringify(listing))]), {
          statusCode: 200,
          headers: { "content-encoding": "gzip", vary: "Accept-Encoding" },
        }) as unknown as IncomingMessage,
    );
    const files = await get(root + "/v8/management/credentials");
    expect(files.headers["content-encoding"]).toBe("gzip");
    expect(files.headers.vary).toBe("Accept-Encoding");
    expect(JSON.parse(gunzipSync(files.rawPayload).toString())).toEqual(listing);
    expect((await get(root + "/containers/json")).statusCode).toBe(404);
    store.setDesiredState(own.id, "stopped");
    expect((await get(root + "/management.html")).statusCode).toBe(409);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
