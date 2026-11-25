// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteCcApi } from "./network-api";
import {
  formatAge,
  lookupAction,
  normalizeRemoteCcCode,
  shortUserAgent,
  takeRemoteCcLink,
} from "./network-remote-cc-panel";

afterEach(() => vi.unstubAllGlobals());

describe("remote-cc approval links", () => {
  it("reads the code and gives the address without it", () => {
    expect(takeRemoteCcLink("https://rcb.example/?new=1&remote-cc=abcd-efgh&mode=page#x")).toEqual({
      code: "ABCD-EFGH",
      url: "/?new=1&mode=page#x",
    });
    expect(takeRemoteCcLink("https://rcb.example/?remote-cc=ABCD-EFGH")).toEqual({
      code: "ABCD-EFGH",
      url: "/",
    });
  });

  it("ignores addresses without a link and strips an empty one", () => {
    expect(takeRemoteCcLink("https://rcb.example/?sid=1")).toBeNull();
    expect(takeRemoteCcLink("https://rcb.example/?remote-cc=&sid=1")).toEqual({
      code: "",
      url: "/?sid=1",
    });
  });

  it("normalizes typed codes", () => {
    expect(normalizeRemoteCcCode("  abcd-efgh ")).toBe("ABCD-EFGH");
  });
});

describe("remote-cc code lookups", () => {
  it("looks a code up once and never again after a decision", () => {
    const decided = new Set<string>();
    expect(lookupAction("ABCD-EFGH", null, decided)).toBe("lookup");
    expect(lookupAction("ABCD-EFGH", "ABCD-EFGH", decided)).toBe("shown");
    expect(lookupAction("WXYZ-2345", "ABCD-EFGH", decided)).toBe("lookup");
    decided.add("ABCD-EFGH");
    expect(lookupAction("ABCD-EFGH", null, decided)).toBe("decided");
    expect(lookupAction("ABCD-EFGH", "ABCD-EFGH", decided)).toBe("decided");
  });
});

describe("remote-cc approval card", () => {
  it("shortens user agents to the product and platform", () => {
    expect(shortUserAgent(null)).toBeNull();
    expect(shortUserAgent("   ")).toBeNull();
    expect(shortUserAgent("Go-http-client/1.1")).toBe("Go-http-client/1.1");
    expect(
      shortUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0",
      ),
    ).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    const long = shortUserAgent(`remote-cc/${"9".repeat(80)}`);
    expect(long).toHaveLength(60);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("says how long ago a request was created", () => {
    const now = 1_700_000_000_000;
    expect(formatAge(now - 3_000, now)).toBe("刚刚");
    expect(formatAge(now + 5_000, now)).toBe("刚刚");
    expect(formatAge(now - 42_000, now)).toBe("42 秒前");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3 小时前");
  });
});

describe("remote-cc logins API", () => {
  it("cancels a pending sign-in with DELETE", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(remoteCcApi.cancelLogin("login/1")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/remote-cc/logins/login%2F1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces a cancel of a sign-in that is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(remoteCcApi.cancelLogin("x")).rejects.toThrow("not found");
  });
});
