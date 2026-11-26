// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiRequest } from "./api";
import { CLIENT_KEY_STORAGE_KEY, prepareClientSession } from "./client-session";

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
    JSON,
    sessionStorage: {
      getItem(key: string) {
        if (storedKey instanceof Error) throw storedKey;
        return key === CLIENT_KEY_STORAGE_KEY ? storedKey : null;
      },
    },
    fetch(path: string, init: RequestInit) {
      const { method = "GET", headers, body, ...rest } = init;
      expect(rest).toEqual({ credentials: "same-origin", cache: "no-store" });
      if (method !== "GET") expect(headers).toEqual(json);
      fetched.push(`${method} ${path}${body ? ` ${String(body)}` : ""}`);
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

  it("lists the profiles on a page that shows the picker, and resumes a tab's own session", () => {
    expect(boot("").fetched).toEqual(["GET /api/me", "GET /api/accounts"]);
    expect(boot("?new=1", key).fetched).toEqual(["GET /api/me", "GET /api/accounts"]);
    expect(boot("", new Error("blocked")).fetched).toEqual(["GET /api/me", "GET /api/accounts"]);
    // Coming back to a session: a reload of this tab, or a link to the session.
    expect(boot("", key).fetched).toEqual([
      "GET /api/me",
      `POST /api/client/session {"clientKey":"${key}"}`,
    ]);
    expect(boot("?sid=client-3", key).fetched).toEqual([
      "GET /api/me",
      `POST /api/client/session {"clientKey":"${key}","sid":"client-3"}`,
    ]);
    // A link without this tab's key: the page makes a key first, so nothing to start.
    expect(boot("?sid=abc").fetched).toEqual(["GET /api/me"]);
    expect(boot("?fixture=/x").fetched).toEqual([]);
    expect(boot("?closed=1").fetched).toEqual([]);
  });

  it("starts exactly the session request the page then makes", () => {
    for (const search of ["", "?sid=client-3", "?sid="]) {
      const storage = { getItem: () => key, setItem: () => {} };
      const request = prepareClientSession(new URL(`https://rcb.test/${search}`), storage, () => {
        throw new Error("a resumed tab keeps its address");
      });
      expect(boot(search, key).fetched).toContain(
        `POST /api/client/session ${JSON.stringify(request)}`,
      );
    }
  });

  it("hands each one to the first call with its method, path and body, once", async () => {
    const { requests } = boot("?sid=client-3", key);
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('{"path":"again"}', { status: 200, headers: json }),
    );
    vi.stubGlobal("window", { __mirrorBootRequests: requests });
    vi.stubGlobal("fetch", fetcher);
    await apiFetch("/api/me", { method: "POST" });
    await apiFetch("/api/client/session", {
      method: "POST",
      body: JSON.stringify({ clientKey: key, sid: "client-4" }),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const session = await apiFetch(
      "/api/client/session",
      { method: "POST", body: JSON.stringify({ clientKey: key, sid: "client-3" }) },
      { signal: new AbortController().signal },
    );
    await expect(session.json()).resolves.toEqual({ path: "/api/client/session" });
    await expect(apiRequest("/api/me")).resolves.toEqual({ path: "/api/me" });
    await expect(apiRequest("/api/me")).resolves.toEqual({ path: "again" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops waiting for an early request when its caller aborts", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("window", { __mirrorBootRequests: { "GET /api/me": pending } });
    const controller = new AbortController();
    const waiting = apiFetch("/api/me", {}, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("sends a request again when the early one failed", async () => {
    const failed = Promise.reject(new TypeError("offline"));
    failed.catch(() => {});
    vi.stubGlobal("window", { __mirrorBootRequests: { "GET /api/me": failed } });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response('{"ok":1}', { status: 200, headers: json })),
    );
    await expect(apiRequest("/api/me")).resolves.toEqual({ ok: 1 });
  });
});
