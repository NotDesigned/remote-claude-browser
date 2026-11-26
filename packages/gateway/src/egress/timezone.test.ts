import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as undici from "undici";
import { detectExitMetadata, detectExitTimeZone, ExitTimeZoneError } from "./timezone";

vi.mock("undici", async (load) => {
  const actual = await load<typeof import("undici")>();
  return { ...actual, request: vi.fn(actual.request) };
});
afterEach(() => vi.restoreAllMocks());

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function withProxy(
  value: unknown,
  run: (proxyUrl: string, url: string, requests: () => number) => Promise<void>,
  status = 200,
) {
  let directRequests = 0;
  const origin = createServer((_request, response) => {
    directRequests++;
    response.end("DIRECT-LEAK");
  });
  const url = `${await listen(origin)}/geo`;
  const proxy = createServer((request, response) => {
    expect(request.url).toBe(url);
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ ip: "203.0.113.7", ...(value as object) }));
  });
  const proxyUrl = await listen(proxy);
  try {
    await run(proxyUrl, url, () => directRequests);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve())),
    ]);
  }
}

describe("exit time zone", () => {
  it.each(["高雄", "台北"])(
    "keeps the provider city %s independent of its IANA zone",
    async (city) => {
      await withProxy(
        { city: ` ${city} `, country: " 台湾 ", timezone: { id: "Asia/Taipei" } },
        async (proxyUrl, url, requests) => {
          expect(await detectExitMetadata({ proxyUrl, url })).toEqual({
            exitIp: "203.0.113.7",
            checkedAt: expect.any(Number),
            timeZone: "Asia/Taipei",
            exitCity: city,
            exitCountry: "台湾",
          });
          expect(requests()).toBe(0);
        },
      );
    },
  );

  it.each([{}, { city: " ", country: "" }, { city: null, country: 42 }])(
    "keeps valid timezone metadata without inventing missing geography: %j",
    async (geography) => {
      await withProxy({ ...geography, timezone: { id: "Asia/Taipei" } }, async (proxyUrl, url) => {
        expect(await detectExitMetadata({ proxyUrl, url })).toEqual({
          exitIp: "203.0.113.7",
          checkedAt: expect.any(Number),
          timeZone: "Asia/Taipei",
        });
      });
    },
  );

  it("keeps a provider country when the city is absent", async () => {
    await withProxy(
      { country: " 台湾 ", timezone: { id: "Asia/Taipei" } },
      async (proxyUrl, url) => {
        expect(await detectExitMetadata({ proxyUrl, url })).toEqual({
          exitIp: "203.0.113.7",
          checkedAt: expect.any(Number),
          timeZone: "Asia/Taipei",
          exitCountry: "台湾",
        });
      },
    );
  });

  it("uses the selected real HTTP proxy rather than the gateway's direct route", async () => {
    await withProxy(
      { success: true, timezone: { id: "Asia/Tokyo" } },
      async (proxyUrl, url, requests) => {
        expect(await detectExitTimeZone({ proxyUrl, url })).toBe("Asia/Tokyo");
        expect(requests()).toBe(0);
      },
    );
  });

  it.each([
    { success: false, message: "Rate limited" },
    { timezone: "Asia/Tokyo" },
    { timezone: { id: "Not/AZone" } },
    { timezone: { id: "+09:00" } },
    { ip: "not-an-ip", timezone: { id: "Asia/Tokyo" } },
    { ip: undefined, timezone: { id: "Asia/Tokyo" } },
  ])("fails for an invalid provider result instead of using the host zone: %j", async (value) => {
    await withProxy(value, async (proxyUrl, url, requests) => {
      await expect(detectExitTimeZone({ proxyUrl, url })).rejects.toBeInstanceOf(ExitTimeZoneError);
      expect(requests()).toBe(0);
    });
  });

  it("reports HTTP errors without a direct fallback", async () => {
    await withProxy(
      { timezone: { id: "Asia/Tokyo" } },
      async (proxyUrl, url, requests) => {
        await expect(detectExitTimeZone({ proxyUrl, url })).rejects.toMatchObject({
          code: "EXIT_LOOKUP",
          message: "出口地区查询服务返回 HTTP 429，请稍后重试",
        });
        expect(requests()).toBe(0);
      },
      429,
    );
  });

  /** A proxy that answers 502 itself, as Mihomo does just after it starts, the first `failures` times. */
  async function startingProxy(failures: number, status = 502) {
    let seen = 0;
    const proxy = createServer((_request, response) => {
      seen++;
      if (seen <= failures) {
        response.writeHead(status, { connection: "close", "content-length": "0" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ ip: "203.0.113.7", timezone: { id: "Asia/Tokyo" } }));
    });
    return { proxyUrl: await listen(proxy), seen: () => seen, close: () => proxy.close() };
  }

  it("tries again while a just-started proxy does not forward yet", async () => {
    const proxy = await startingProxy(2);
    try {
      const metadata = await detectExitMetadata({
        proxyUrl: proxy.proxyUrl,
        url: "http://203.0.113.1/geo",
        retryUntil: Date.now() + 5_000,
      });
      expect(metadata.timeZone).toBe("Asia/Tokyo");
      expect(proxy.seen()).toBe(3);
    } finally {
      proxy.close();
    }
  });

  it("does not retry a proxy failure without a start window, or past it", async () => {
    const proxy = await startingProxy(100);
    try {
      await expect(
        detectExitMetadata({ proxyUrl: proxy.proxyUrl, url: "http://203.0.113.1/geo" }),
      ).rejects.toMatchObject({ code: "EXIT_LOOKUP" });
      expect(proxy.seen()).toBe(1);
      const started = Date.now();
      await expect(
        detectExitMetadata({
          proxyUrl: proxy.proxyUrl,
          url: "http://203.0.113.1/geo",
          retryUntil: started + 300,
        }),
      ).rejects.toMatchObject({ code: "EXIT_LOOKUP" });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(proxy.seen()).toBeGreaterThan(2);
    } finally {
      proxy.close();
    }
  });

  it("never retries the provider's own refusal", async () => {
    const proxy = await startingProxy(1, 429);
    try {
      await expect(
        detectExitMetadata({
          proxyUrl: proxy.proxyUrl,
          url: "http://203.0.113.1/geo",
          retryUntil: Date.now() + 5_000,
        }),
      ).rejects.toMatchObject({ code: "EXIT_LOOKUP" });
      expect(proxy.seen()).toBe(1);
    } finally {
      proxy.close();
    }
  });

  it("keeps proxy URL credentials out of lookup errors", async () => {
    await expect(
      detectExitTimeZone({ proxyUrl: "invalid://private-user:private-secret@proxy.invalid" }),
    ).rejects.toMatchObject({
      name: "ExitTimeZoneError",
      code: "EXIT_CONNECT",
      message: "无法通过所选代理连接外网，请检查节点连通性",
    });
  });

  it.each([
    [{ code: "ECONNREFUSED" }, "EXIT_CONNECT"],
    [{ cause: { code: "ENOTFOUND" } }, "EXIT_DNS"],
    [{ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }, "EXIT_TIMEOUT"],
    [{ name: "TimeoutError" }, "EXIT_TIMEOUT"],
  ])(
    "distinguishes transport failures without exposing node credentials: %j",
    async (failure, code) => {
      vi.mocked(undici.request).mockRejectedValueOnce(
        Object.assign(new Error("http://private-user:private-secret@node.invalid"), failure),
      );
      await expect(detectExitMetadata()).rejects.toMatchObject({ code });
      await expect(
        detectExitMetadata({ proxyUrl: "invalid://private-user:private-secret@node.invalid" }),
      ).rejects.not.toThrow("private-secret");
    },
  );

  it("uses the process route for deployments without a broker proxy", async () => {
    const origin = createServer((_request, response) => {
      response.setHeader("connection", "close");
      response.end(JSON.stringify({ ip: "2001:db8::1", timezone: { id: "Europe/Berlin" } }));
    });
    const url = await listen(origin);
    try {
      expect(await detectExitTimeZone({ url })).toBe("Europe/Berlin");
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });
});
