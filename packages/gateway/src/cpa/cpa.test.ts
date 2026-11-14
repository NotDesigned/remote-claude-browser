import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import { createCpaStore, type CpaInstance, type CpaStore } from "./store";
import { createCpaRuntime } from "./runtime";
import type { CpaDriver, CpaRequest } from "./broker-client";
import { registerCpaInferenceRoutes, registerCpaRoutes } from "./routes";

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
  const proxies: { userId: string; proxyId: string | undefined }[] = [];
  const users = new Map([alice, bob, admin].map((user) => [user.id, user]));
  let upstream: (instance: CpaInstance, input: CpaRequest) => IncomingMessage = () =>
    response({ status: "ok" });
  const driver: CpaDriver = {
    async ensure(value) {
      states.set(value.id, "running");
    },
    async stop(value) {
      states.set(value.id, "stopped");
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
    async resolveProxyForUser(user, proxyId) {
      proxies.push({ userId: user.id, proxyId });
      if (proxyId === "bobs-proxy" && user.id !== bob.id) throw new Error("not owned");
      if (proxyId === "removed") throw new Error("removed node");
      return {
        id: proxyId ?? "deployment-default",
        name: "Private node",
        url: `http://${user.id}:x@runtime-egress:8781`,
      };
    },
  });
  return {
    store,
    runtime,
    calls,
    users,
    states,
    proxies,
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
      const key = first.issueKey(value.id, "saved-client");
      first.setDesiredState(value.id, "running");
      first.setCredentialProxy(value.id, "claude.json", "node-a");
      first.recordOAuth(value.id, "saved-state", "claude", "node-a");
      first.close();
      const reopened = await createCpaStore({ file });
      try {
        expect(reopened.get(value.id)).toEqual({ ...value, desiredState: "running" });
        expect(reopened.resolveKey(key.token)?.id).toBe(value.id);
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
    store.setCredentialProxy(b.id, "b.json", "bobs-proxy");
    store.setCredentialProxy(shared.id, "shared.json", "deployment-default");
    let sharedAdmin = admin;
    const lookup = (value: CpaInstance) =>
      value.ownerId === null ? sharedAdmin : users.get(value.ownerId);
    const result = await runtime.restore(lookup);
    expect(result.restored.sort()).toEqual([a.id, b.id, shared.id].sort());
    expect(result.failures).toEqual([
      { instanceId: a.id, proxyId: "removed", code: "CPA_PROXY_RESTORE" },
    ]);
    expect(states.get(a.id)).toBe("running");
    expect(proxies).toContainEqual({ userId: bob.id, proxyId: "bobs-proxy" });
    expect(proxies).toContainEqual({ userId: admin.id, proxyId: undefined });
    sharedAdmin = { ...admin, id: "another-admin" };
    calls.length = 0;
    await runtime.restoreBindings(["deployment-default"], lookup);
    expect(
      calls
        .filter((call) => call.instance.id === shared.id)
        .map((call) => JSON.parse(String(call.input.body))),
    ).toContainEqual({
      name: "shared.json",
      proxy_url: "http://another-admin:x@runtime-egress:8781",
    });
    proxies.length = 0;
    await runtime.restoreBindings(["node-a"], lookup);
    expect(proxies).toEqual([
      { userId: alice.id, proxyId: undefined },
      { userId: alice.id, proxyId: "node-a" },
    ]);
    await runtime.stop(alice, a.id);
    proxies.length = 0;
    const started = await runtime.start(alice, a.id);
    expect(proxies).toContainEqual({ userId: alice.id, proxyId: "node-a" });
    expect(started.proxyFailures).toHaveLength(1);
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
    const key = store.issueKey(ownA.id, "laptop");
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
  it("disabling or deleting an owner invalidates existing API keys", async () => {
    const { store, runtime, users } = await fixture();
    const value = store.create(alice);
    store.setDesiredState(value.id, "running");
    const key = store.issueKey(value.id, "client");
    users.set(alice.id, { ...alice, enabled: false });
    expect(() => runtime.inference(key.token)).toThrow();
    users.delete(alice.id);
    expect(() => runtime.inference(key.token)).toThrow();
    users.set(alice.id, alice);
    expect(runtime.inference(key.token).id).toBe(value.id);
    store.revokeUserKeys(alice.id);
    expect(() => runtime.inference(key.token)).toThrow();
  });
});

describe("CPA v8 contract", () => {
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
    });
    const items = await runtime.credentials(alice, value.id);
    expect(items[0]?.proxyId).toBe("my-proxy");
    expect(items[0]?.email).toBe("alice@example.test");
    expect(JSON.stringify(items)).not.toMatch(/opaque|secret|\/auth|id_token/);
    await runtime.credentialProxy(alice, value.id, "claude.json", null);
    expect(store.credentialProxy(value.id, "claude.json")).toBe("deployment-default");
    expect((await runtime.credentials(alice, value.id))[0]?.proxyId).toBeNull();
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
  it("cookie-protected management and API-key inference enforce separate authorization", async () => {
    const { store, runtime, calls, setUpstream } = await fixture();
    const value = store.create(alice);
    await runtime.start(alice, value.id);
    const key = store.issueKey(value.id, "client");
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
    await app.close();
  });
});
