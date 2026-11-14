import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { detectExitMetadata, detectExitTimeZone, ExitTimeZoneError } from "./timezone";

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
    response.end(JSON.stringify(value));
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
        expect(await detectExitMetadata({ proxyUrl, url })).toEqual({ timeZone: "Asia/Taipei" });
      });
    },
  );

  it("keeps a provider country when the city is absent", async () => {
    await withProxy(
      { country: " 台湾 ", timezone: { id: "Asia/Taipei" } },
      async (proxyUrl, url) => {
        expect(await detectExitMetadata({ proxyUrl, url })).toEqual({
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
        await expect(detectExitTimeZone({ proxyUrl, url })).rejects.toThrow(
          "无法获取所选出口的时区，请检查代理后重试",
        );
        expect(requests()).toBe(0);
      },
      429,
    );
  });

  it("keeps proxy URL credentials out of lookup errors", async () => {
    await expect(
      detectExitTimeZone({ proxyUrl: "invalid://private-user:private-secret@proxy.invalid" }),
    ).rejects.toMatchObject({
      name: "ExitTimeZoneError",
      message: "无法获取所选出口的时区，请检查代理后重试",
    });
  });

  it("uses the process route for deployments without a broker proxy", async () => {
    const origin = createServer((_request, response) => {
      response.setHeader("connection", "close");
      response.end(JSON.stringify({ timezone: { id: "Europe/Berlin" } }));
    });
    const url = await listen(origin);
    try {
      expect(await detectExitTimeZone({ url })).toBe("Europe/Berlin");
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });
});
