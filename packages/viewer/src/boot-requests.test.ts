// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiRequest } from "./api";
import { CLIENT_KEY_STORAGE_KEY } from "./client-session";

const json = { "content-type": "application/json" };

/** index.html's own inline script, run as a page with this address and stored key would. */
function boot(search: string, storedKey: string | null | Error = null) {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const fetched: string[] = [];
  const window: { __mirrorBootRequests?: Record<string, Promise<Response>> } = {};
  runInNewContext(script, {
    window,
    location: { search },
    URLSearchParams,
    sessionStorage: {
      getItem(key: string) {
        if (storedKey instanceof Error) throw storedKey;
        return key === CLIENT_KEY_STORAGE_KEY ? storedKey : null;
      },
    },
    fetch(path: string, init: RequestInit) {
      expect(init).toEqual({ credentials: "same-origin", cache: "no-store" });
      fetched.push(path);
      return Promise.resolve(
        new Response(JSON.stringify({ path }), { status: 200, headers: json }),
      );
    },
  });
  return { fetched, requests: window.__mirrorBootRequests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the requests index.html starts before the scripts arrive", () => {
  const key = "0b0c8a3e-5f4f-4c8e-9a51-8d7e2f7f6c11";

  it("lists the profiles only on a page that shows the picker", () => {
    expect(boot("").fetched).toEqual(["/api/me", "/api/accounts"]);
    expect(boot("?new=1", key).fetched).toEqual(["/api/me", "/api/accounts"]);
    expect(boot("", new Error("blocked")).fetched).toEqual(["/api/me", "/api/accounts"]);
    // Coming back to a session: a reload of this tab or a link to the session.
    expect(boot("", key).fetched).toEqual(["/api/me"]);
    expect(boot("?sid=abc").fetched).toEqual(["/api/me"]);
    expect(boot("?fixture=/x").fetched).toEqual([]);
    expect(boot("?closed=1").fetched).toEqual([]);
  });

  it("hands each one to the first plain GET of its path, once", async () => {
    const { requests } = boot("");
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('{"path":"again"}', { status: 200, headers: json }),
    );
    vi.stubGlobal("window", { __mirrorBootRequests: requests });
    vi.stubGlobal("fetch", fetcher);
    // Not one with a signal (it could not be aborted), and not another method.
    await apiFetch("/api/me", { method: "POST" });
    await apiFetch("/api/me", {}, { signal: new AbortController().signal });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(apiRequest("/api/me")).resolves.toEqual({ path: "/api/me" });
    await expect(apiRequest("/api/accounts")).resolves.toEqual({ path: "/api/accounts" });
    await expect(apiRequest("/api/me")).resolves.toEqual({ path: "again" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("sends a request again when the early one failed", async () => {
    const failed = Promise.reject(new TypeError("offline"));
    failed.catch(() => {});
    vi.stubGlobal("window", { __mirrorBootRequests: { "/api/me": failed } });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response('{"ok":1}', { status: 200, headers: json })),
    );
    await expect(apiRequest("/api/me")).resolves.toEqual({ ok: 1 });
  });
});
