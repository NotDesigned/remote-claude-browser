import { Readable } from "node:stream";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import type { CdpSend } from "../types";
import { createAssetFetcher, type DirectRequest, type DirectResponse } from "./fetch";
import type { AssetRef } from "./token";

const ref: AssetRef = {
  url: "https://assets.example/not-really-an-image.png",
  sessionId: "session-a",
  tabId: "tab-a",
};

describe("asset fetch lanes", () => {
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
    const send = vi.fn<CdpSend>(async (_sessionId, method) => {
      if (method === "Network.getCookies") return { cookies: [] };
      if (method === "Browser.getVersion") return { userAgent: "Range UA" };
      throw new Error(`Lane A must not run for Range: ${method}`);
    });
    const directRequest = vi.fn<DirectRequest>(async (_url, options) => {
      expect(options.headers.range).toBe("bytes=500-999");
      return directResponse(
        "partial",
        {
          "content-type": "video/mp4",
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

    const response = await fetcher.fetch({ ref, range: "bytes=500-999" });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 500-999/2000");
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "Network.getCookies",
      "Browser.getVersion",
    ]);
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
