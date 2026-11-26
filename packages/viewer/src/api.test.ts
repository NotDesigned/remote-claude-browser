// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, gateUrl, setAuthExpiredHandler } from "./api";

const reply = (body: string | null, status: number, type?: string) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(body, { status, headers: type === undefined ? {} : { "content-type": type } }),
  );

afterEach(() => setAuthExpiredHandler());

describe("apiRequest", () => {
  it("reads JSON answers and the server's own error message", async () => {
    await expect(
      apiRequest("/api/x", "GET", undefined, reply('{"ok":1}', 200, "application/json")),
    ).resolves.toEqual({ ok: 1 });
    await expect(
      apiRequest(
        "/api/x",
        "GET",
        undefined,
        reply('{"message":"名称已存在"}', 409, "application/json; charset=utf-8"),
      ),
    ).rejects.toMatchObject({ status: 409, message: "名称已存在" });
  });

  it("turns a proxy's HTML error page into a plain failure instead of a SyntaxError", async () => {
    const failure = apiRequest(
      "/api/x",
      "GET",
      undefined,
      reply("<html><body>502 Bad Gateway</body></html>", 502, "text/html"),
    );
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 502, message: "请求失败（502）" });
    // JSON-looking text that is not labelled JSON is not parsed either.
    await expect(
      apiRequest("/api/x", "GET", undefined, reply('{"error":"x"}', 504, "text/plain")),
    ).rejects.toMatchObject({ message: "请求失败（504）" });
    // A broken JSON body labelled as JSON does not throw a SyntaxError.
    await expect(
      apiRequest("/api/x", "GET", undefined, reply("{oops", 500, "application/json")),
    ).rejects.toMatchObject({ message: "请求失败（500）" });
  });

  it("accepts 204 and empty successful bodies", async () => {
    await expect(apiRequest("/api/x", "DELETE", undefined, reply(null, 204))).resolves.toBe(
      undefined,
    );
    await expect(
      apiRequest("/api/x", "POST", {}, reply("", 200, "application/json")),
    ).resolves.toBe(undefined);
    await expect(apiRequest("/api/x", "POST", {}, reply("ok", 200, "text/plain"))).resolves.toBe(
      undefined,
    );
  });

  it("hands every 401 to the expired sign-in handler, unless the caller expects one", async () => {
    const expired = vi.fn();
    setAuthExpiredHandler(expired);
    await expect(
      apiRequest("/api/x", "GET", undefined, reply('{"error":"请登录"}', 401, "application/json")),
    ).rejects.toMatchObject({ status: 401, message: "请登录" });
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(
      apiRequest("/logout", "POST", undefined, reply(null, 401), { allowUnauthorized: true }),
    ).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(
      apiRequest("/api/x", "GET", undefined, reply("{}", 403, "application/json")),
    ).rejects.toMatchObject({ status: 403 });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("sends same-origin, uncached requests and passes an abort signal", async () => {
    const fetcher = reply(null, 204);
    const controller = new AbortController();
    await apiRequest("/api/x", "POST", { a: 1 }, fetcher, { signal: controller.signal });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        body: '{"a":1}',
      }),
    );
  });
});

describe("gateUrl", () => {
  it("asks the gate to come back to this page after signing in again", () => {
    expect(gateUrl({ pathname: "/", search: "?sid=client-1" })).toBe(
      "/gate?return=%2F%3Fsid%3Dclient-1",
    );
  });
});
