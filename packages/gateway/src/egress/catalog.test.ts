// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontendUser } from "../auth/users";
import { createProxyCatalog, type ProxyCatalogOptions } from "./catalog";

const admin: FrontendUser = {
  id: "admin",
  username: "admin",
  role: "admin",
  enabled: true,
  createdAt: 1,
};
const alice: FrontendUser = {
  id: "alice",
  username: "alice",
  role: "user",
  enabled: true,
  createdAt: 1,
};
const bob = { ...alice, id: "bob", username: "bob" };
const node = (name: string, password = "private-password", server = "proxy.example") => ({
  name,
  type: "socks5",
  server,
  port: 1080,
  username: "private-login",
  password,
  udp: true,
});
const content = (...nodes: unknown[]) => JSON.stringify({ proxies: nodes });
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(extra: Partial<ProxyCatalogOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "proxy-catalog-"));
  directories.push(directory);
  const options: ProxyCatalogOptions = {
    file: join(directory, "proxies.json"),
    usernameFor: (id) => [admin, alice, bob].find((user) => user.id === id)?.username,
    usageForNodes: () => ({ profiles: 0, credentials: 0 }),
    endpointForNode: vi.fn(async () => "http://internal-token:x@runtime-egress:8781"),
    ...extra,
  };
  return { store: await createProxyCatalog(options), options };
}

describe("proxy directory", () => {
  it("separates shared and private sources without exposing server settings or subscription credentials", async () => {
    const { store } = await fixture({
      fetcher: vi.fn(async () => Response.json({ proxies: [node("Shared")] })),
    });
    const shared = await store.importSource(admin, {
      name: "Shared source",
      visibility: "shared",
      url: "https://subscribe.example/private-token",
    });
    const privateSource = await store.importSource(alice, {
      name: "Alice source",
      visibility: "private",
      content: content(node("Alice")),
    });
    expect(store.listNodes(alice).map((item) => item.name)).toEqual(["Shared", "Alice"]);
    expect(store.listNodes(bob).map((item) => item.name)).toEqual(["Shared"]);
    expect(store.listSources(bob)[0]).toMatchObject({
      id: shared.id,
      ownerName: "admin",
      subscription: true,
      canManage: false,
    });
    expect(
      store.listSources(alice).find((source) => source.id === privateSource.id)?.canManage,
    ).toBe(true);
    const exposed = JSON.stringify([store.listSources(admin), store.listNodes(admin)]);
    for (const secret of ["proxy.example", "private-password", "private-login", "private-token"])
      expect(exposed).not.toContain(secret);
    const privateNode = store.listNodes(alice).find((item) => item.sourceId === privateSource.id)!;
    expect(() => store.getNodeConfig(bob, privateNode.id)).toThrow("不属于当前用户");
    await expect(
      store.importSource(alice, {
        name: "forbidden",
        visibility: "shared",
        content: content(node("x")),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(store.removeSource(bob, shared.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(() => store.listNodes({ ...alice, enabled: false })).toThrow("停用");
    await store.removeSource(admin, privateSource.id);
    expect(store.listNodes(alice)).toHaveLength(1);
  });

  it("only source managers can inspect binding counts, including a deleted owner's retained source", async () => {
    const usageForNodes = vi.fn(() => ({ profiles: 2, credentials: 3 }));
    const { store } = await fixture({ usageForNodes });
    const shared = await store.importSource(admin, {
      name: "Team",
      visibility: "shared",
      content: content(node("Shared")),
    });
    const privateSource = await store.importSource(alice, {
      name: "Alice",
      visibility: "private",
      content: content(node("Private")),
    });
    expect(() => store.sourceUsage(bob, shared.id)).toThrow("无权管理");
    expect(() => store.sourceUsage(bob, privateSource.id)).toThrow("没有这个代理源");
    expect(usageForNodes).not.toHaveBeenCalled();
    expect(store.sourceUsage(admin, privateSource.id)).toEqual({ profiles: 2, credentials: 3 });
    expect(usageForNodes).toHaveBeenCalledWith([
      store.listNodes(alice).find((item) => item.sourceId === privateSource.id)!.id,
    ]);
    expect(store.sourceUsage(alice, privateSource.id)).toEqual({ profiles: 2, credentials: 3 });
    expect(() => store.sourceUsage({ ...alice, enabled: false }, privateSource.id)).toThrow("停用");
    const { store: retired } = await fixture({ usernameFor: () => undefined });
    const source = await retired.importSource(alice, {
      name: "Retained source",
      visibility: "private",
      content: content(node("Retained")),
    });
    expect(retired.listSources(admin)[0]).toMatchObject({ id: source.id, ownerName: null });
  });

  it("persists privately, retains IDs across reorder and credential rotation, and invalidates removed nodes", async () => {
    const onRemovedNodes = vi.fn(async () => {}),
      onChangedNodes = vi.fn(async () => {});
    const { store, options } = await fixture({ onRemovedNodes, onChangedNodes });
    const source = await store.importSource(alice, {
      name: "mine",
      visibility: "private",
      content: content(node("A"), node("B", "b-password", "b.example")),
    });
    const before = store.listNodes(alice);
    await store.updateSource(alice, source.id, {
      content: content(node("B", "b-password", "b.example"), node("A", "rotated-password")),
    });
    const rotated = store.listNodes(alice).find((item) => item.name === "A")!;
    expect(rotated.id).toBe(before.find((item) => item.name === "A")!.id);
    expect(onChangedNodes).toHaveBeenCalledExactlyOnceWith([rotated.id]);
    expect(onRemovedNodes).not.toHaveBeenCalled();
    await store.updateSource(alice, source.id, {
      content: content(node("Renamed", "rotated-password"), node("B", "b-password", "b.example")),
    });
    expect(store.listNodes(alice).find((item) => item.name === "Renamed")!.id).toBe(rotated.id);
    expect(onChangedNodes).toHaveBeenCalledTimes(1);
    await store.updateSource(alice, source.id, {
      content: content(node("Renamed", "rotated-password")),
    });
    expect(onRemovedNodes).toHaveBeenCalledWith([before.find((item) => item.name === "B")!.id]);
    await expect(
      store.resolveProxyForUser(alice, before.find((item) => item.name === "B")!.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await stat(options.file)).mode & 0o777).toBe(0o600);
    const reopened = await createProxyCatalog(options);
    expect(reopened.listNodes(alice)).toEqual(store.listNodes(alice));
    expect(JSON.parse(await readFile(options.file, "utf8")).version).toBe(1);
    await expect(reopened.resolveProxyForUser(alice, rotated.id)).resolves.toEqual({
      id: rotated.id,
      name: "Renamed",
      url: "http://internal-token:x@runtime-egress:8781",
    });
    expect(options.endpointForNode).toHaveBeenCalledWith(
      rotated.id,
      expect.objectContaining({ password: "rotated-password" }),
      alice,
    );
  });

  it("refreshes subscriptions explicitly and leaves the existing source intact on an invalid response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ proxies: [node("A")] }))
      .mockResolvedValueOnce(Response.json({ rules: ["MATCH,DIRECT"] }))
      .mockResolvedValueOnce(Response.json({ proxies: [node("A", "new-password")] }));
    const { store } = await fixture({ fetcher });
    const source = await store.importSource(alice, {
      name: "subscription",
      visibility: "private",
      url: "https://subscription.example/secret",
    });
    const id = store.listNodes(alice)[0]!.id;
    await expect(store.refreshSource(alice, source.id)).rejects.toThrow("proxies");
    expect(store.getNodeConfig(alice, id).password).toBe("private-password");
    await store.refreshSource(alice, source.id);
    expect(store.getNodeConfig(alice, id).password).toBe("new-password");
    expect(fetcher).toHaveBeenCalledWith(
      "https://subscription.example/secret",
      expect.objectContaining({ redirect: "error" }),
    );
    await expect(
      store.importSource(alice, {
        name: "invalid-url",
        visibility: "private",
        url: "file:///etc/passwd",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("invalidates running connections when a shared source becomes private", async () => {
    const onChangedNodes = vi.fn(async () => {});
    const { store } = await fixture({ onChangedNodes });
    const source = await store.importSource(admin, {
      name: "Team",
      visibility: "shared",
      content: content(node("Node")),
    });
    const id = store.listNodes(alice)[0]!.id;
    await store.resolveProxyForUser(alice, id);
    await store.updateSource(admin, source.id, { visibility: "private" });
    expect(onChangedNodes).toHaveBeenCalledExactlyOnceWith([id]);
    expect(store.listNodes(alice)).toEqual([]);
    await expect(store.resolveProxyForUser(alice, id)).rejects.toMatchObject({ statusCode: 404 });
    expect(store.listNodes(admin)[0]!.id).toBe(id);
  });
});
