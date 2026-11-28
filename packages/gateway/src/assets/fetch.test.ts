import { Readable } from "node:stream";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";

import type { CdpSend } from "../types";
import {
  assetDirectFallback,
  createAssetFetcher,
  type AssetDirectFallback,
  type DirectRequest,
  type DirectResponse,
} from "./fetch";
import type { AssetRef } from "./token";

const ref: AssetRef = {
  url: "https://assets.example/not-really-an-image.png",
  sessionId: "session-a",
  tabId: "tab-a",
};

describe("asset fetch lanes", () => {
  it("loads protected iframe resources in their owning frame and keeps Referer in fallback", async () => {
    const documentUrl = "https://appleid.example/widget/account/?private=1#form";
    const send = vi.fn<CdpSend>(async (_session, method, params) => {
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: "top", url: "https://icloud.example/" },
            childFrames: [{ frame: { id: "registration", url: documentUrl } }],
          },
        };
      if (method === "Network.loadNetworkResource") {
        expect(params?.frameId).toBe("registration");
        throw new Error("CDP unavailable");
      }
      if (method === "Network.getCookies") return { cookies: [] };
      throw new Error(method);
    });
    const directRequest = vi.fn<DirectRequest>(async (_url, options) => {
      expect(options.headers.referer).toBe("https://appleid.example/");
      return directResponse("@font-face{}", { "content-type": "text/css" });
    });
    const fetcher = createAssetFetcher({
      // The earlier fallback to the gateway's own client, kept with MIRROR_ASSET_DIRECT_FALLBACK=all.
      directFallback: "all",
      send,
      sessionFor: () => "cdp",
      userAgentFor: () => "UA",
      directRequest,
    });
    try {
      const result = await fetcher.fetch({ ref: { ...ref, documentUrl } });
      expect(result.headers["content-type"]).toBe("text/css");
      expect(await readBody(result.body)).toBe("@font-face{}");
      expect(directRequest).toHaveBeenCalledOnce();
    } finally {
      await fetcher.close();
    }
  });

  it("sends range and CDP fallback bytes through the profile's actual HTTP proxy", async () => {
    const seen: string[] = [];
    const proxy = createServer((request, response) => {
      seen.push(request.rawHeaders.join(": "));
      response.writeHead(206, { "content-length": "4", connection: "close" });
      response.end("exit");
    });
    proxy.on("connect", (request, socket) => {
      expect(request.url).toBe("egress-fixture.invalid:80");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      let headers = "";
      socket.on("data", (chunk) => {
        headers += chunk.toString();
        if (!headers.includes("\r\n\r\n")) return;
        seen.push(headers);
        socket.end(
          "HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nConnection: close\r\n\r\nexit",
        );
      });
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const address = proxy.address() as import("node:net").AddressInfo;
    const fetcher = createAssetFetcher({
      // The earlier fallback to the gateway's own client, kept with MIRROR_ASSET_DIRECT_FALLBACK=all.
      directFallback: "all",
      proxyFor: () => `http://127.0.0.1:${address.port}`,
      sessionFor: () => "cdp-fixture",
      userAgentFor: () => "profile UA",
      send: async (_session, method) => {
        if (method === "Network.getCookies")
          return { cookies: [{ name: "session", value: "own-profile" }] };
        throw new Error("CDP resource unavailable");
      },
    });
    try {
      const asset = { ...ref, url: "http://egress-fixture.invalid/asset" };
      expect(await readBody((await fetcher.fetch({ ref: asset, range: "bytes=0-3" })).body)).toBe(
        "exit",
      );
      expect(await readBody((await fetcher.fetch({ ref: asset })).body)).toBe("exit");
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatch(/range: bytes=0-3/i);
      expect(seen.every((headers) => /cookie: session=own-profile/i.test(headers))).toBe(true);
    } finally {
      await fetcher.close();
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });
  it("never reuses an upstream connection across sessions or a released session generation", async () => {
    const ids = new WeakMap<Socket, number>();
    let nextId = 0;
    const server = createServer((request, response) => {
      let id = ids.get(request.socket);
      if (!id) ids.set(request.socket, (id = ++nextId));
      response.end(JSON.stringify({ id, cookie: request.headers.cookie }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const fetcher = createAssetFetcher({
      sessionFor: (ref) => ref.sessionId,
      userAgentFor: () => "local fixture",
      // The loopback fixture is exactly what the default public-only dispatcher refuses.
      directDispatcher: () => new Agent(),
      send: async (session, method) => {
        if (method === "Network.getCookies")
          return { cookies: [{ name: "profile", value: session }] };
        throw new Error(method);
      },
    });
    const request = async (sessionId: string) => {
      const response = await fetcher.fetch({
        ref: { url: `http://127.0.0.1:${address.port}/fixture`, sessionId, tabId: "tab" },
        range: "bytes=0-3",
      });
      const result = JSON.parse(await readBody(response.body)) as { id: number; cookie: string };
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.cookie).toBe(`profile=${sessionId}`);
      return result.id;
    };
    try {
      const a = await request("a");
      const b = await request("b");
      expect(a).not.toBe(b);
      expect(await request("a")).toBe(a);
      expect(await request("b")).toBe(b);
      await fetcher.closeSession("a");
      expect(await request("a")).not.toBe(a);
      expect(await request("b")).toBe(b);
    } finally {
      await fetcher.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a private address on the proxy-less direct lane at connect time", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits++;
      response.end("internal");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const fetcher = createAssetFetcher({
      sessionFor: (ref) => ref.sessionId,
      userAgentFor: () => "local fixture",
      send: async (_session, method) => {
        if (method === "Network.getCookies") return { cookies: [] };
        throw new Error(method);
      },
    });
    try {
      for (const host of ["127.0.0.1", "localhost"]) {
        await expect(
          fetcher.fetch({
            ref: { url: `http://${host}:${address.port}/x`, sessionId: "a", tabId: "tab" },
            range: "bytes=0-3",
          }),
        ).rejects.toMatchObject({ code: "EPRIVATETARGET" });
      }
      expect(hits).toBe(0);
    } finally {
      await fetcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not start a direct request when its session is revoked during credential lookup", async () => {
    let releaseCookies!: (value: unknown) => void;
    const cookies = new Promise((resolve) => (releaseCookies = resolve));
    const directRequest = vi.fn<DirectRequest>();
    const send = vi.fn<CdpSend>(async (_session, method) => {
      if (method === "Network.getCookies") return cookies;
      throw new Error(method);
    });
    const fetcher = createAssetFetcher({
      sessionFor: () => "cdp",
      userAgentFor: () => "fixture",
      send,
      directRequest,
    });
    const pending = fetcher.fetch({ ref, range: "bytes=0-3" });
    const rejected = expect(pending).rejects.toThrow("Asset session was closed");
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await fetcher.closeSession(ref.sessionId);
    releaseCookies({ cookies: [] });
    await rejected;
    expect(directRequest).not.toHaveBeenCalled();
    await fetcher.close();
  });

  it("reads object URLs in bounded slices and releases the browser handle", async () => {
    const payload = Buffer.alloc(140000, 42);
    const send = vi.fn<CdpSend>(async (_session, method, params) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") return { result: { objectId: "blob" } };
      if (method === "Runtime.releaseObject") return {};
      if (method === "Runtime.callFunctionOn") {
        if (!params?.arguments)
          return { result: { value: { size: payload.length, type: "image/png" } } };
        const args = params.arguments as { value: number }[];
        expect(args[1]!.value).toBe(65536);
        return {
          result: {
            value: payload
              .subarray(args[0]!.value, args[0]!.value + args[1]!.value)
              .toString("base64"),
          },
        };
      }
      throw new Error(method);
    });
    const fetcher = createAssetFetcher({ send, sessionFor: () => "cdp", frameFor: () => "frame" });
    const response = await fetcher.fetch({
      ref: { ...ref, url: "blob:https://reader.example/id" },
    });
    const chunks: Buffer[] = [];
    for await (const bytes of response.body) chunks.push(bytes);
    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(send.mock.calls.at(-1)?.[1]).toBe("Runtime.releaseObject");
  });

  it("never sends browser-owned object URLs to the direct HTTP fallback", async () => {
    const directRequest = vi.fn<DirectRequest>();
    const fetcher = createAssetFetcher({
      sessionFor: () => "cdp",
      frameFor: () => "frame",
      send: async () => {
        throw new Error("object was revoked");
      },
      directRequest,
    });
    await expect(
      fetcher.fetch({ ref: { ...ref, url: "blob:https://reader.example/id" } }),
    ).rejects.toThrow("revoked");
    expect(directRequest).not.toHaveBeenCalled();
  });

  it("falls back from any Lane-A setup error to Lane B with browser cookies and UA", async () => {
    const methods: string[] = [];
    const send: CdpSend = async (_sessionId, method) => {
      methods.push(method);
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-a" } } };
      }
      if (method === "Network.loadNetworkResource") throw new Error("experimental failure");
      if (method === "Network.getCookies") {
        return { cookies: [{ name: "gate", value: "open" }] };
      }
      if (method === "Browser.getVersion") return { userAgent: "Browser UA" };
      throw new Error(`Unexpected CDP method ${method}`);
    };
    const directRequest = vi.fn<DirectRequest>(async (_url, options) => {
      expect(options.headers).toMatchObject({
        cookie: "gate=open",
        "user-agent": "Browser UA",
      });
      return directResponse("fallback", { "content-type": "text/plain" });
    });
    const fetcher = createAssetFetcher({
      // The earlier fallback to the gateway's own client, kept with MIRROR_ASSET_DIRECT_FALLBACK=all.
      directFallback: "all",
      send,
      sessionFor: () => "cdp-session-a",
      directRequest,
    });

    const response = await fetcher.fetch({ ref });

    expect(response.lane).toBe("direct");
    expect(await readBody(response.body)).toBe("fallback");
    expect(methods).toContain("Network.loadNetworkResource");
    expect(directRequest).toHaveBeenCalledOnce();
  });

  it("sends Range straight through Lane B and never attempts Lane A", async () => {
    const chromeUa =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
    const send = vi.fn<CdpSend>(async (_sessionId, method) => {
      if (method === "Network.getCookies") return { cookies: [] };
      if (method === "Browser.getVersion") return { userAgent: chromeUa };
      throw new Error(`Lane A must not run for Range: ${method}`);
    });
    const directRequest = vi.fn<DirectRequest>(async (_url, options) => {
      expect(options.headers.range).toBe("bytes=500-999");
      expect(options.headers["accept-encoding"]).toBe("identity;q=1, *;q=0");
      expect(options.headers["sec-fetch-mode"]).toBe("no-cors");
      expect(options.headers["sec-fetch-dest"]).toBe("audio");
      expect(options.headers["sec-fetch-site"]).toBe("same-origin");
      expect(options.headers["sec-ch-ua"]).toContain('"Chromium";v="134"');
      expect(options.headers["sec-ch-ua"]).toContain('"Google Chrome";v="134"');
      expect(options.headers["sec-ch-ua"]).toContain('"Not:A-Brand";v="24"');
      expect(options.headers["sec-ch-ua-platform"]).toBe('"macOS"');
      expect(options.headers["accept-language"]).toBe("en-US,en;q=0.9");
      return directResponse(
        "partial",
        {
          "content-type": "audio/mpeg",
          "content-range": "bytes 500-999/2000",
        },
        206,
      );
    });
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp-session-a",
      directRequest,
    });

    const response = await fetcher.fetch({
      ref: {
        ...ref,
        url: "https://claude.ai/assets/clip.mp3",
        documentUrl: "https://claude.ai/chat/1",
      },
      range: "bytes=500-999",
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 500-999/2000");
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "Network.getCookies",
      "Browser.getVersion",
    ]);
  });

  it("rotates the session dispatcher immediately when a workspace switches proxy URL", async () => {
    let currentProxy: string | undefined = "http://10.253.0.2:8780";
    const dispatchers: unknown[] = [];
    const send = vi.fn<CdpSend>(async (_sessionId, method) => {
      if (method === "Network.getCookies") return { cookies: [] };
      if (method === "Browser.getVersion") return { userAgent: "Chrome/134.0.0.0" };
      throw new Error(`Unexpected: ${method}`);
    });
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp-session-a",
      proxyFor: () => currentProxy,
      directRequest: async (_url, options) => {
        dispatchers.push(options.dispatcher);
        return directResponse("ok", { "content-type": "audio/mpeg" }, 206);
      },
    });
    try {
      await fetcher.fetch({ ref, range: "bytes=0-1" });
      await fetcher.fetch({ ref, range: "bytes=0-1" });
      expect(dispatchers[0]).toBe(dispatchers[1]);

      currentProxy = "http://10.253.0.6:8780";
      await fetcher.fetch({ ref, range: "bytes=0-1" });
      expect(dispatchers[2]).not.toBe(dispatchers[0]);
    } finally {
      await fetcher.close();
    }
  });

  it("streams decoded CDP chunks without stale upstream encoding or length headers", async () => {
    const chunks = [Buffer.from("first-"), Buffer.from("second")];
    let readIndex = 0;
    const send: CdpSend = async (_sessionId, method, params) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "frame-a" } } };
      }
      if (method === "Network.loadNetworkResource") {
        return {
          resource: {
            success: true,
            httpStatusCode: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Encoding": "br",
              "Content-Length": "5",
            },
            stream: "stream-a",
          },
        };
      }
      if (method === "IO.read") {
        expect(params?.size).toBe(64 * 1024);
        const chunk = chunks[readIndex++]!;
        return {
          data: chunk.toString("base64"),
          base64Encoded: true,
          eof: readIndex === chunks.length,
        };
      }
      if (method === "IO.close") return {};
      throw new Error(`Unexpected CDP method ${method}`);
    };
    const directRequest = vi.fn<DirectRequest>();
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp-session-a",
      directRequest,
    });

    const response = await fetcher.fetch({ ref });

    expect(response.lane).toBe("cdp");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    expect(await readBody(response.body)).toBe("first-second");
    expect(directRequest).not.toHaveBeenCalled();
  });
});

function directResponse(
  body: string,
  headers: DirectResponse["headers"],
  statusCode = 200,
): DirectResponse {
  return { statusCode, headers, body: Readable.from([body]) };
}

async function readBody(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("MIRROR_ASSET_DIRECT_FALLBACK", () => {
  /** A browser that cannot load anything, and a direct lane that records what it was asked. */
  function failingBrowser(directFallback?: AssetDirectFallback) {
    const send = vi.fn<CdpSend>(async (_sessionId, method) => {
      if (method === "Network.getCookies") return { cookies: [] };
      if (method === "Browser.getVersion") return { userAgent: "UA" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
      throw new Error("CDP unavailable");
    });
    const directRequest = vi.fn<DirectRequest>(async () =>
      directResponse("direct", { "content-type": "text/plain" }),
    );
    const fetcher = createAssetFetcher({
      send,
      sessionFor: () => "cdp",
      directRequest,
      ...(directFallback === undefined ? {} : { directFallback }),
    });
    return { fetcher, directRequest };
  }

  it("reads the mode, range unless set, and refuses anything else", () => {
    expect(assetDirectFallback(undefined)).toBe("range");
    expect(assetDirectFallback("")).toBe("range");
    expect(assetDirectFallback("all")).toBe("all");
    expect(assetDirectFallback(" off ")).toBe("off");
    expect(() => assetDirectFallback("yes")).toThrow(/all, range or off/);
  });

  it("range (default): no direct fetch for an asset the browser could not load; Range still direct", async () => {
    vi.stubEnv("MIRROR_ASSET_DIRECT_FALLBACK", "");
    try {
      const { fetcher, directRequest } = failingBrowser();
      try {
        await expect(fetcher.fetch({ ref })).rejects.toThrow(/browser could not load/);
        expect(directRequest).not.toHaveBeenCalled();
        const range = await fetcher.fetch({ ref, range: "bytes=0-3" });
        expect(range.lane).toBe("direct");
        expect(directRequest).toHaveBeenCalledOnce();
        expect(fetcher.lanes()).toEqual({
          cdp: 0,
          blob: 0,
          direct: { range: 1, "cdp-failed": 0 },
          refused: { range: 0, "cdp-failed": 1 },
        });
      } finally {
        await fetcher.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("off: Range requests are refused too", async () => {
    const { fetcher, directRequest } = failingBrowser("off");
    try {
      await expect(fetcher.fetch({ ref, range: "bytes=0-3" })).rejects.toThrow(/=off/);
      await expect(fetcher.fetch({ ref })).rejects.toThrow();
      expect(directRequest).not.toHaveBeenCalled();
      expect(fetcher.lanes().refused).toEqual({ range: 1, "cdp-failed": 1 });
    } finally {
      await fetcher.close();
    }
  });

  it("all: the earlier fallback, counted", async () => {
    vi.stubEnv("MIRROR_ASSET_DIRECT_FALLBACK", "all");
    try {
      const { fetcher, directRequest } = failingBrowser();
      try {
        expect((await fetcher.fetch({ ref })).lane).toBe("direct");
        expect((await fetcher.fetch({ ref, range: "bytes=0-3" })).lane).toBe("direct");
        expect(directRequest).toHaveBeenCalledTimes(2);
        expect(fetcher.lanes().direct).toEqual({ range: 1, "cdp-failed": 1 });
      } finally {
        await fetcher.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
