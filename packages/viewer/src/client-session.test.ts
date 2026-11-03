// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_KEY_STORAGE_KEY,
  ClientSessionError,
  clientGatewayUrl,
  clientPageMode,
  clientReturnUrl,
  endClientSession,
  prepareClientSession,
  preferredViewMode,
  rememberViewMode,
  requestClientSession,
} from "./client-session";

const FIRST_KEY = "11111111-1111-4111-8111-111111111111";
const SECOND_KEY = "22222222-2222-4222-8222-222222222222";
const SESSION = {
  sid: "client-1",
  label: "独立会话 1",
  maxClients: 5,
  available: 4,
  sharedAccount: true,
};

function storage(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(CLIENT_KEY_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function fetchResponse(body: unknown, status = 200) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("client session bootstrap", () => {
  it("preserves the per-tab UUID across reloads and forwards an explicit session hint", () => {
    const saved = storage();
    const uuid = vi.fn(() => FIRST_KEY);
    const replaceUrl = vi.fn();
    const url = new URL("https://viewer.test/?sid=client-1");
    expect(prepareClientSession(url, saved, replaceUrl, uuid)).toEqual({
      clientKey: FIRST_KEY,
      sid: "client-1",
    });
    expect(prepareClientSession(new URL(url.href), saved, replaceUrl, uuid)).toEqual({
      clientKey: FIRST_KEY,
      sid: "client-1",
    });
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it("rotates a new-session key once and removes new and the previous session hint", () => {
    const saved = storage(FIRST_KEY);
    const uuid = vi.fn(() => SECOND_KEY);
    const replaceUrl = vi.fn();
    const url = new URL("https://viewer.test/?sid=client-1&new=1#page");
    expect(prepareClientSession(url, saved, replaceUrl, uuid)).toEqual({ clientKey: SECOND_KEY });
    expect(replaceUrl).toHaveBeenCalledWith("/#page");
    expect(url.searchParams.has("new")).toBe(false);
    expect(prepareClientSession(new URL(url.href), saved, replaceUrl, uuid)).toEqual({
      clientKey: SECOND_KEY,
    });
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(saved.getItem(CLIENT_KEY_STORAGE_KEY)).toBe(SECOND_KEY);
  });

  it("keeps ended pages and local fixtures outside the normal allocation path", () => {
    expect(clientPageMode(new URL("https://viewer.test/?closed=1"))).toBe("closed");
    expect(clientPageMode(new URL("https://viewer.test/?fixture=/demo.json"))).toBe("fixture");
    expect(clientPageMode(new URL("https://viewer.test/?fixture=/demo.json&closed=1"))).toBe(
      "closed",
    );
    expect(clientPageMode(new URL("https://viewer.test/?sid=client-2"))).toBe("session");
  });

  it("posts the stable key with the existing cookie and returns validated session metadata", async () => {
    const fetcher = fetchResponse(SESSION);
    const controller = new AbortController();
    await expect(
      requestClientSession(
        { clientKey: FIRST_KEY, sid: "client-1" },
        {
          fetcher,
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual(SESSION);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/client/session",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: FIRST_KEY, sid: "client-1" }),
        signal: controller.signal,
      }),
    );
  });

  it.each([
    [401, "登录已失效"],
    [403, "当前设备无权"],
    [503, "会话服务暂时不可用"],
  ])("provides a retryable explanation for HTTP %i", async (status, expected) => {
    const fetcher = fetchResponse({ code: "UNAVAILABLE" }, status as number);
    await expect(requestClientSession({ clientKey: FIRST_KEY }, { fetcher })).rejects.toMatchObject(
      {
        status,
        message: expect.stringContaining(expected as string),
      },
    );
  });

  it("exposes only valid owned-session return links when capacity is full", async () => {
    const fetcher = fetchResponse(
      {
        code: "CLIENT_CAPACITY",
        ownedSessions: [
          { sid: "client-1", label: "独立会话 1" },
          { sid: "client-2", label: "独立会话 2" },
          { sid: "javascript:bad", label: "invalid" },
        ],
      },
      503,
    );
    await expect(
      requestClientSession({ clientKey: SECOND_KEY }, { fetcher }),
    ).rejects.toMatchObject({
      code: "CLIENT_CAPACITY",
      status: 503,
      ownedSessions: [
        { sid: "client-1", label: "独立会话 1" },
        { sid: "client-2", label: "独立会话 2" },
      ],
    });
  });

  it("keeps an aborted bootstrap aborted rather than converting it into a retry state", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted on unmount");
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(reason), { once: true });
        }),
    );
    const pending = requestClientSession(
      { clientKey: FIRST_KEY },
      { fetcher, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBe(reason);
  });

  it("deletes only the requested session and accepts an empty 204 response", async () => {
    const fetcher = fetchResponse(null, 204);
    await expect(endClientSession("client-2", { fetcher })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/client/session/client-2",
      expect.objectContaining({
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it("rejects invalid API data and reports unavailable storage without allocating", async () => {
    const fetcher = fetchResponse({ ...SESSION, sid: "other-session" });
    await expect(
      requestClientSession({ clientKey: FIRST_KEY }, { fetcher }),
    ).rejects.toBeInstanceOf(ClientSessionError);
    expect(() =>
      prepareClientSession(
        new URL("https://viewer.test/"),
        {
          getItem: () => {
            throw new Error("disabled");
          },
          setItem: vi.fn(),
        },
        vi.fn(),
        () => FIRST_KEY,
      ),
    ).toThrow("浏览器无法保存");
  });

  it("accepts sixteen sessions and validates dynamic capacity bounds", async () => {
    const fifth = { ...SESSION, sid: "client-5", label: "独立会话 5", available: 0 };
    await expect(
      requestClientSession({ clientKey: FIRST_KEY }, { fetcher: fetchResponse(fifth) }),
    ).resolves.toEqual(fifth);
    for (const fields of [
      { sid: "client-17" },
      { maxClients: 0 },
      { maxClients: 1.5 },
      { available: -1 },
      { available: 6 },
    ]) {
      await expect(
        requestClientSession(
          { clientKey: FIRST_KEY },
          {
            fetcher: fetchResponse({ ...SESSION, ...fields }),
          },
        ),
      ).rejects.toMatchObject({ code: "CLIENT_RESPONSE" });
    }
  });

  it.each(["client-9", "client-10", "client-16"])("restores and accepts %s", async (sid) => {
    expect(
      prepareClientSession(
        new URL(`https://viewer.test/?sid=${sid}`),
        storage(),
        vi.fn(),
        () => FIRST_KEY,
      ),
    ).toMatchObject({ sid });
    await expect(
      requestClientSession(
        { clientKey: FIRST_KEY },
        { fetcher: fetchResponse({ ...SESSION, sid, maxClients: 16, available: 0 }) },
      ),
    ).resolves.toMatchObject({ sid });
  });

  it("retries a recycled forbidden sid once using only this tab's key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "CLIENT_FORBIDDEN" }), { status: 403 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(SESSION), { status: 200 }));
    await expect(
      requestClientSession({ clientKey: FIRST_KEY, sid: "client-5" }, { fetcher }),
    ).resolves.toEqual(SESSION);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toEqual({
      clientKey: FIRST_KEY,
      sid: "client-5",
    });
    expect(JSON.parse(fetcher.mock.calls[1]![1]?.body as string)).toEqual({ clientKey: FIRST_KEY });
    const forbidden = fetchResponse({ code: "CLIENT_FORBIDDEN" }, 403);
    await expect(
      requestClientSession({ clientKey: FIRST_KEY, sid: "client-5" }, { fetcher: forbidden }),
    ).rejects.toMatchObject({ status: 403 });
    expect(forbidden).toHaveBeenCalledTimes(2);
  });

  it("keeps independent sessions in WebSocket, chat, and return URLs", () => {
    expect(clientGatewayUrl("https://viewer.test/?new=1", "client-2")).toBe(
      "wss://viewer.test/ws?sid=client-2",
    );
    expect(clientGatewayUrl("http://127.0.0.1:3010/?fixture=demo")).toBe("ws://127.0.0.1:3010/ws");
    expect(clientReturnUrl("client-1")).toBe("/?sid=client-1");
  });

  it("prefers text chat and remembers an explicitly chosen browser view", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(preferredViewMode(storage)).toBe("chat");
    rememberViewMode(storage, "px");
    expect(preferredViewMode(storage)).toBe("px");
    store.set("mirror.view-mode", "nonsense");
    expect(preferredViewMode(storage)).toBe("chat");
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(preferredViewMode(blocked)).toBe("chat");
  });
});
