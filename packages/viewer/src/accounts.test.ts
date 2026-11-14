// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createAccount, listAccounts, type AccountList } from "./accounts";

const list: AccountList = {
  default: "default",
  accounts: [
    { id: "default", name: "默认账号", running: true, sessions: 2 },
    { id: "p-0123456789", name: "工作", running: false, sessions: 0 },
  ],
  current: "default",
};

function fetcher(responses: Record<string, unknown>) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({
      path,
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: JSON.parse(init.body as string) }),
    });
    const key = `${init.method ?? "GET"} ${path}`;
    const value = responses[key];
    if (value instanceof Error)
      return new Response(JSON.stringify({ error: value.message }), { status: 409 });
    return new Response(value === undefined ? null : JSON.stringify(value), {
      status: value === undefined ? 204 : 200,
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("browser configuration API", () => {
  it("reads the list and which account the session uses", async () => {
    const { fn, calls } = fetcher({ "GET /api/accounts?sid=client-1": list });
    await expect(listAccounts("client-1", fn)).resolves.toEqual(list);
    expect(calls[0]?.path).toBe("/api/accounts?sid=client-1");
  });

  it("creates an unbound account without switching to it", async () => {
    const { fn, calls } = fetcher({
      "POST /api/accounts": { id: "p-aaaaaaaaaa", name: "新号" },
    });
    const made = await createAccount("新号", fn);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/accounts"]);
    expect(calls[0]?.body).toEqual({ name: "新号" });
    expect(made.proxyId).toBeUndefined();
  });
});
