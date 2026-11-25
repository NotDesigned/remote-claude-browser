import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAssetCache } from "./cache";
import type { AssetFetcher } from "./fetch";
import {
  ASSET_CONTENT_SECURITY_POLICY,
  assetContentType,
  registerAssetRoutes,
  rejectPrivateAssetTarget,
} from "./route";
import { registerSecurityHeaders, SECURITY_HEADERS } from "../security-headers";
import { openAssetToken, sealAssetToken } from "./token";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("asset route policy boundary", () => {
  it.each(["icons.woff2", "site.css", "image.png", "favicon.ico"])(
    "checks %s through its own session resolver and still rejects private addresses",
    async (asset) => {
      const app = Fastify();
      const key = randomBytes(32);
      const ref = { url: `https://assets.example/${asset}`, sessionId: "owned", tabId: "*" };
      const dir = await mkdtemp(join(tmpdir(), "mirror-asset-resolver-"));
      dirs.push(dir);
      let address = "203.0.113.8";
      const lookup = vi.fn(async () => [{ address, family: 4 }]);
      const fetchAsset = vi.fn<AssetFetcher["fetch"]>(async () => ({
        statusCode: 200,
        headers: { "content-type": "application/octet-stream" },
        body: Readable.from(["fixture"]),
        lane: "cdp",
      }));
      registerAssetRoutes(app, {
        serverKey: key,
        lookup,
        cache: createAssetCache(dir),
        fetcher: { fetch: fetchAsset },
      });
      const url = `/s/owned/a/${sealAssetToken(ref, key)}`;
      try {
        expect((await app.inject({ url })).statusCode).toBe(200);
        expect(lookup).toHaveBeenCalledWith("assets.example", ref);
        address = "192.168.1.1";
        expect((await app.inject({ url })).statusCode).toBe(403);
        expect(fetchAsset).toHaveBeenCalledOnce();
      } finally {
        await app.close();
      }
    },
  );

  it("isolates cached private assets and CSS child tokens when a session is reused", async () => {
    const app = Fastify();
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    let currentKey: Buffer | undefined = keyA;
    let currentBody = "A-private";
    const ref = { url: "https://assets.example/private.css", sessionId: "reused", tabId: "*" };
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-runtime-isolation-"));
    dirs.push(dir);
    const fetchAsset = vi.fn<AssetFetcher["fetch"]>(async () => ({
      statusCode: 200,
      headers: { "content-type": "text/css" },
      body: Readable.from([`/* ${currentBody} */ .avatar { background: url(./private.png); }`]),
      lane: "cdp",
    }));
    registerAssetRoutes(app, {
      // An absent hook result must never fall back to this otherwise valid static key.
      serverKey: keyA,
      serverKeyForSession: (sid) => (sid === ref.sessionId ? currentKey : undefined),
      cache: createAssetCache(dir),
      fetcher: { fetch: fetchAsset },
      lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    });
    const tokenA = sealAssetToken(ref, keyA);
    const tokenB = sealAssetToken(ref, keyB);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = (token: string) => fetch(`${origin}/s/${ref.sessionId}/a/${token}`);
    try {
      const first = await request(tokenA);
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("A-private");
      const cachedA = await request(tokenA);
      expect(await cachedA.text()).toContain("A-private");
      expect(fetchAsset).toHaveBeenCalledTimes(1);

      // The SID, wildcard tab and source URL are identical; only the runtime identity changes.
      currentKey = keyB;
      currentBody = "B-private";
      const obsolete = await request(tokenA);
      expect(obsolete.status).toBe(400);
      await obsolete.text();
      expect(fetchAsset).toHaveBeenCalledTimes(1);
      const replacement = await request(tokenB);
      expect(replacement.status).toBe(200);
      const css = await replacement.text();
      expect(css).toContain("B-private");
      expect(css).not.toContain("A-private");
      const childToken = /\/s\/reused\/a\/([A-Za-z0-9_-]+)/.exec(css)?.[1];
      expect(childToken).toBeDefined();
      expect(openAssetToken(childToken!, keyB)).toEqual({
        ...ref,
        url: "https://assets.example/private.png",
      });
      expect(() => openAssetToken(childToken!, keyA)).toThrow();
      const cachedB = await request(tokenB);
      expect(await cachedB.text()).toContain("B-private");
      expect(fetchAsset).toHaveBeenCalledTimes(2);

      currentKey = undefined;
      for (const token of [tokenA, tokenB]) {
        const disconnected = await request(token);
        expect(disconnected.status).toBe(404);
        await disconnected.text();
      }
      expect(fetchAsset).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it.each(["dns", "fetch"])(
    "rejects an in-flight asset if the runtime changes during %s",
    async (phase) => {
      const app = Fastify();
      const keyA = randomBytes(32);
      const keyB = randomBytes(32);
      let currentKey = keyA;
      const body = Readable.from(["must-not-leak"]);
      const dir = await mkdtemp(join(tmpdir(), "mirror-asset-key-race-"));
      dirs.push(dir);
      const fetchAsset = vi.fn<AssetFetcher["fetch"]>(async () => {
        if (phase === "fetch") currentKey = keyB;
        return { statusCode: 200, headers: { "content-type": "image/png" }, body, lane: "cdp" };
      });
      registerAssetRoutes(app, {
        serverKey: keyA,
        serverKeyForSession: () => currentKey,
        cache: createAssetCache(dir),
        fetcher: { fetch: fetchAsset },
        lookup: async () => {
          if (phase === "dns") currentKey = keyB;
          return [{ address: "203.0.113.8", family: 4 }];
        },
      });
      const token = sealAssetToken(
        { url: "https://assets.example/private.png", sessionId: "reused", tabId: "*" },
        keyA,
      );
      try {
        const response = await app.inject({ method: "GET", url: `/s/reused/a/${token}` });
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain("must-not-leak");
        expect(fetchAsset).toHaveBeenCalledTimes(phase === "dns" ? 0 : 1);
        if (phase === "fetch") expect(body.destroyed).toBe(true);
      } finally {
        body.destroy();
        await app.close();
      }
    },
  );

  it.each([200, 206])(
    "survives CDP LF headers on real HTTP for status %i, including cache hits",
    async (statusCode) => {
      const app = Fastify();
      const serverKey = randomBytes(32);
      const dir = await mkdtemp(join(tmpdir(), "mirror-header-regression-"));
      dirs.push(dir);
      const fetchAsset = vi.fn<AssetFetcher["fetch"]>(async () => ({
        statusCode,
        headers: {
          "content-type": "image/png",
          "cache-control": "public\nmax-age=60",
          "x-malformed": "bad\u0000value",
          "set-cookie": "remote=credential",
        },
        body: Readable.from(["fixture-image"]),
        lane: "cdp",
      }));
      registerAssetRoutes(app, {
        serverKey,
        cache: createAssetCache(dir),
        fetcher: { fetch: fetchAsset },
        lookup: async () => [{ address: "203.0.113.8", family: 4 }],
      });
      const token = sealAssetToken(
        { url: "https://assets.example/image", sessionId: "s", tabId: "t" },
        serverKey,
      );
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        for (let index = 0; index < 2; index++) {
          const response = await fetch(
            `${origin}/s/s/a/${token}`,
            statusCode === 206 ? { headers: { range: "bytes=0-12" } } : undefined,
          );
          expect(response.status).toBe(statusCode);
          expect(response.headers.get("cache-control")).toBe("public, max-age=60");
          expect(response.headers.has("x-malformed")).toBe(false);
          expect(response.headers.has("set-cookie")).toBe(false);
          expect(await response.text()).toBe("fixture-image");
        }
        expect(fetchAsset).toHaveBeenCalledTimes(statusCode === 200 ? 1 : 2);
      } finally {
        await app.close();
      }
    },
  );
  it("routes browser objects without DNS and rejects unsupported schemes", async () => {
    const lookup = vi.fn(async () => []);
    await rejectPrivateAssetTarget("blob:https://reader.example/object", lookup);
    expect(lookup).not.toHaveBeenCalled();
    await expect(rejectPrivateAssetTarget("file:///etc/passwd", lookup)).rejects.toThrow();
  });
  it("decrypts the token and rejects private/cloud-metadata targets before fetching", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>();
    const preHandler = vi.fn(async () => undefined);
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      preHandler,
    });
    const token = sealAssetToken(
      {
        url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        sessionId: "session-a",
        tabId: "tab-a",
      },
      serverKey,
    );

    const response = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Private asset target rejected" });
    expect(preHandler).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("checks every resolved address before fetching a hostname", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>();
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      lookup: async () => [
        { address: "203.0.113.8", family: 4 },
        { address: "10.0.0.8", family: 4 },
      ],
    });
    const token = sealAssetToken(
      { url: "https://rebind.example/asset", sessionId: "session-a", tabId: "tab-a" },
      serverKey,
    );

    const response = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(response.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    await app.close();
  });

  it("serves a full response from the content cache on the next request", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>(async () => ({
      statusCode: 200,
      headers: { "content-type": "image/webp" },
      body: Readable.from(["asset-body"]),
      lane: "cdp",
    }));
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    });
    const token = sealAssetToken(
      {
        url: "https://public.example/misleading.txt",
        sessionId: "session-a",
        tabId: "tab-a",
      },
      serverKey,
    );

    const first = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });
    const second = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/webp");
    expect(first.body).toBe("asset-body");
    expect(second.body).toBe("asset-body");
    expect(fetch).toHaveBeenCalledOnce();
    await app.close();
  });

  it.each(["font/woff2", "font/woff", "font/ttf", "font/otf"])(
    "serves %s with immutable long-lived browser caching",
    async (contentType) => {
      const app = Fastify();
      const serverKey = randomBytes(32);
      const fetch = vi.fn<AssetFetcher["fetch"]>(async () => ({
        statusCode: 200,
        headers: {
          "content-type": contentType,
          "cache-control": "private, max-age=0",
        },
        body: Readable.from([Buffer.from([0x77, 0x4f, 0x46, 0x32])]),
        lane: "cdp",
      }));
      const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
      dirs.push(dir);
      registerAssetRoutes(app, {
        serverKey,
        cache: createAssetCache(dir),
        fetcher: { fetch },
        lookup: async () => [{ address: "203.0.113.8", family: 4 }],
      });
      const token = sealAssetToken(
        {
          url: "https://fonts.example/server-font",
          sessionId: "session-a",
          tabId: "tab-a",
        },
        serverKey,
      );

      const first = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });
      const cached = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

      expect(first.statusCode).toBe(200);
      expect(first.headers["content-type"]).toBe(contentType);
      expect(first.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(cached.headers["content-type"]).toBe(contentType);
      expect(cached.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(fetch).toHaveBeenCalledOnce();
      await app.close();
    },
  );

  it("does not add immutable caching to non-font responses", async () => {
    const app = Fastify();
    const serverKey = randomBytes(32);
    const fetch = vi.fn<AssetFetcher["fetch"]>(async () => ({
      statusCode: 200,
      headers: { "content-type": "image/webp" },
      body: Readable.from(["image"]),
      lane: "cdp",
    }));
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-route-test-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: { fetch },
      lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    });
    const token = sealAssetToken(
      {
        url: "https://public.example/image",
        sessionId: "session-a",
        tabId: "tab-a",
      },
      serverKey,
    );

    const response = await app.inject({ method: "GET", url: `/s/session-a/a/${token}` });

    expect(response.headers["cache-control"]).toBeUndefined();
    await app.close();
  });
});

describe("asset response header policy", () => {
  async function serveAsset(headers: Record<string, string>, range?: string) {
    const app = Fastify();
    registerSecurityHeaders(app);
    const serverKey = randomBytes(32);
    const dir = await mkdtemp(join(tmpdir(), "mirror-asset-headers-"));
    dirs.push(dir);
    registerAssetRoutes(app, {
      serverKey,
      cache: createAssetCache(dir),
      fetcher: {
        fetch: async () => ({
          statusCode: range === undefined ? 200 : 206,
          headers,
          body: Readable.from(["<svg onload=alert(1)></svg>"]),
          lane: "direct",
        }),
      },
      lookup: async () => [{ address: "203.0.113.8", family: 4 }],
    });
    const token = sealAssetToken(
      { url: "https://evil.example/asset", sessionId: "s", tabId: "t" },
      serverKey,
    );
    try {
      const url = `/s/s/a/${token}`;
      const first = await app.inject({ url, ...(range ? { headers: { range } } : {}) });
      const second = await app.inject({ url, ...(range ? { headers: { range } } : {}) });
      return [first, second];
    } finally {
      await app.close();
    }
  }

  it.each([undefined, "bytes=0-4"])(
    "replaces upstream origin controls with the gateway's own (range %s, including cache hits)",
    async (range) => {
      const responses = await serveAsset(
        {
          "content-type": "image/png",
          "content-security-policy": "default-src *; script-src * 'unsafe-inline'",
          "content-security-policy-report-only": "default-src *",
          "x-frame-options": "ALLOWALL",
          "cross-origin-resource-policy": "cross-origin",
          "cross-origin-opener-policy": "unsafe-none",
          "cross-origin-embedder-policy": "require-corp",
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          refresh: "0; url=https://evil.example/",
          link: "<https://evil.example/x.js>; rel=preload; as=script",
          location: "https://evil.example/",
          "content-disposition": "inline; filename=x.html",
          "x-content-type-options": "none",
          "referrer-policy": "unsafe-url",
          "service-worker-allowed": "/",
          etag: '"abc"',
        },
        range,
      );
      for (const response of responses) {
        const headers = response!.headers;
        expect(headers["content-security-policy"]).toBe(ASSET_CONTENT_SECURITY_POLICY);
        expect(headers["content-security-policy"]).toMatch(/^sandbox; default-src 'none'/);
        expect(headers["x-frame-options"]).toBe(SECURITY_HEADERS["x-frame-options"]);
        expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
        expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
        expect(headers["x-content-type-options"]).toBe("nosniff");
        expect(headers["referrer-policy"]).toBe("no-referrer");
        for (const name of [
          "content-security-policy-report-only",
          "cross-origin-embedder-policy",
          "access-control-allow-origin",
          "access-control-allow-credentials",
          "strict-transport-security",
          "refresh",
          "link",
          "location",
          "content-disposition",
          "service-worker-allowed",
        ]) {
          expect(headers[name], name).toBeUndefined();
        }
        expect(headers.etag).toBe('"abc"');
        expect(headers["content-type"]).toBe("image/png");
      }
    },
  );

  it.each([
    ["text/html; charset=utf-8", "text/plain; charset=utf-8"],
    ["application/xhtml+xml", "text/plain; charset=utf-8"],
    ["text/xml", "text/plain; charset=utf-8"],
    ["application/xml", "text/plain; charset=utf-8"],
    ["application/rss+xml", "text/plain; charset=utf-8"],
    ["text/xsl", "text/plain; charset=utf-8"],
    ["text/javascript", "text/plain; charset=utf-8"],
    ["application/javascript", "text/plain; charset=utf-8"],
    ["application/json", "text/plain; charset=utf-8"],
    ["application/pdf", "application/octet-stream"],
    ["multipart/x-mixed-replace; boundary=x", "application/octet-stream"],
    ["image/svg+xml; charset=utf-8", "image/svg+xml"],
  ])("neutralizes document and script type %s", async (upstream, served) => {
    const [response] = await serveAsset({ "content-type": upstream });
    expect(response!.statusCode).toBe(200);
    expect(response!.headers["content-type"]).toBe(served);
    expect(response!.headers["content-security-policy"]).toBe(ASSET_CONTENT_SECURITY_POLICY);
    expect(response!.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each([
    "image/png",
    "image/webp",
    "image/x-icon",
    "image/avif",
    "font/woff2",
    "application/font-woff",
    "application/vnd.ms-fontobject",
    "text/css; charset=utf-8",
    "video/mp4",
    "audio/mpeg",
    "text/vtt",
    "application/octet-stream",
  ])("keeps subresource type %s", (contentType) => {
    expect(assetContentType(contentType)).toBe(contentType);
  });
});
