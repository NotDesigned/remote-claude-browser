import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import { registerErrorHandler } from "../http-errors";
import { ProxyCatalogError, type ProxyCatalog } from "./catalog";
import { registerProxyRoutes } from "./routes";
import { parseSubscription } from "./subscription";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const user = { id: "user-1", username: "alice", role: "user", enabled: true } as FrontendUser;

function fixture(catalog: Partial<ProxyCatalog>) {
  const app = Fastify();
  apps.push(app);
  registerErrorHandler(app, () => undefined);
  registerProxyRoutes(app, {
    catalog: catalog as ProxyCatalog,
    currentUser: () => user,
    checkProxy: async () => ({ status: "healthy", checkedAt: 0 }),
  });
  return app;
}

it("shows the person why their subscription text is unusable", async () => {
  const app = fixture({
    importSource: async (_user, input) => {
      parseSubscription(String(input.content));
      throw new Error("unreachable");
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/proxy-sources",
    payload: { name: "x", visibility: "private", content: "proxies: []" },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
    error: "订阅需要包含 proxies 节点列表",
    code: "PROXY_SOURCE_INVALID",
  });
});

it("keeps the catalog's own errors and hides unexpected ones", async () => {
  const app = fixture({
    listSources: () => {
      throw new Error("EACCES: permission denied, open '/data/profile/proxy-sources.json'");
    },
    listNodes: () => {
      throw new ProxyCatalogError(403, "USER_DISABLED", "这个用户已停用");
    },
  });
  const unexpected = await app.inject({ url: "/api/proxy-sources" });
  expect(unexpected.statusCode).toBe(500);
  expect(unexpected.body).not.toContain("proxy-sources.json");
  expect(unexpected.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  const typed = await app.inject({ url: "/api/proxies" });
  expect(typed.statusCode).toBe(403);
  expect(typed.json()).toEqual({ error: "这个用户已停用", code: "USER_DISABLED" });
});
