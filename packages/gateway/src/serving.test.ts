import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUserGate, USER_COOKIE } from "./auth/user-gate";
import { createUserStore } from "./auth/users";
import {
  gatewayHost,
  registerViewerStatic,
  staticCacheControl,
  trustedProxies,
  VIEWER_BUILD_FILE,
  viewerBuildId,
} from "./serving";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("gateway production serving", () => {
  it("serves the viewer index at root behind the access gate when dist exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-viewer-dist-test-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>Mirror viewer</title>");

    const app = Fastify();
    const store = await createUserStore({
      file: ":memory:",
      bootstrapPassword: "correct-password",
    });
    app.addHook("onClose", async () => store.close());
    const gate = createUserGate({ store });
    app.addHook("preHandler", gate.preHandler);
    gate.registerRoutes(app);
    expect(await registerViewerStatic(app, root)).toBe(true);
    app.get("/healthz", async () => ({ ok: true }));

    const blocked = await app.inject({ url: "/" });
    expect(blocked.statusCode).toBe(302);
    expect(blocked.headers.location).toBe("/gate");

    const granted = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=admin&password=correct-password",
    });
    const setCookie = granted.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    expect(cookie).toContain(`${USER_COOKIE}=`);

    const response = await app.inject({ url: "/", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>Mirror viewer</title>");
    expect(response.headers["cache-control"]).toBe("private, no-cache");
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });

  it("starts normally without registering static routes when dist is absent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mirror-missing-viewer-test-"));
    roots.push(parent);
    const app = Fastify();

    expect(await registerViewerStatic(app, join(parent, "dist"))).toBe(false);
    await app.ready();
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
    await app.close();
  });

  it("reads the served viewer's build, and has none without a well-formed one", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-viewer-build-test-"));
    roots.push(root);
    expect(viewerBuildId(root)).toBeUndefined();
    await writeFile(join(root, VIEWER_BUILD_FILE), "0.4.0+abc1234.m3k9x2\n");
    expect(viewerBuildId(root)).toBe("0.4.0+abc1234.m3k9x2");
    await writeFile(join(root, VIEWER_BUILD_FILE), "<script>");
    expect(viewerBuildId(root)).toBeUndefined();
  });

  it("uses GATEWAY_HOST when configured and keeps the loopback default", () => {
    expect(gatewayHost({})).toBe("127.0.0.1");
    expect(gatewayHost({ GATEWAY_HOST: "172.19.0.1" })).toBe("172.19.0.1");
  });

  it("caches hashed assets for good and makes pages revalidate", () => {
    expect(staticCacheControl("/opt/viewer/assets/browser-CmJBMSbW.js")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(staticCacheControl("/opt/viewer/assets/KaTeX_Main-Regular-ypZvNtVU.ttf")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(staticCacheControl("/opt/viewer/index.html")).toBe("private, no-cache");
  });
});

describe("trustedProxies", () => {
  it("trusts only the loopback addresses by default", () => {
    expect(trustedProxies({})).toEqual(["127.0.0.1", "::1"]);
  });

  it("adds the networks it is told to", () => {
    expect(trustedProxies({ MIRROR_TRUSTED_PROXIES: " 172.31.66.0/24, 10.1.0.0/16,," })).toEqual([
      "127.0.0.1",
      "::1",
      "172.31.66.0/24",
      "10.1.0.0/16",
    ]);
  });
});
