// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { listAccounts, runAccountAction, type AccountList } from "./accounts";

const list: AccountList = {
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

function dialogs(answers: { confirm?: boolean[]; prompt?: (string | null)[] } = {}) {
  const confirms = [...(answers.confirm ?? [])];
  const prompts = [...(answers.prompt ?? [])];
  return {
    confirm: vi.fn(() => confirms.shift() ?? false),
    prompt: vi.fn(() => (prompts.length > 0 ? prompts.shift()! : null)),
    alert: vi.fn(),
    reload: vi.fn(),
  };
}

describe("accounts in the menu", () => {
  it("reads the list and which account the session uses", async () => {
    const { fn, calls } = fetcher({ "GET /api/accounts?sid=client-1": list });
    await expect(listAccounts("client-1", fn)).resolves.toEqual(list);
    expect(calls[0]?.path).toBe("/api/accounts?sid=client-1");
  });

  it("switches only after confirming, then reloads to reach the other Chrome", async () => {
    const { fn, calls } = fetcher({
      "POST /api/client/session/client-1/account": { account: "p-0123456789" },
    });
    const declined = dialogs({ confirm: [false] });
    await runAccountAction(
      { kind: "switch", id: "p-0123456789" },
      { sid: "client-1", list, dialogs: declined, refresh() {}, fetcher: fn },
    );
    expect(calls).toHaveLength(0);

    const accepted = dialogs({ confirm: [true] });
    await runAccountAction(
      { kind: "switch", id: "p-0123456789" },
      { sid: "client-1", list, dialogs: accepted, refresh() {}, fetcher: fn },
    );
    expect(calls).toEqual([
      {
        path: "/api/client/session/client-1/account",
        method: "POST",
        body: { account: "p-0123456789" },
      },
    ]);
    expect(accepted.reload).toHaveBeenCalledOnce();
  });

  it("creates an account and offers to move there", async () => {
    const { fn, calls } = fetcher({
      "POST /api/accounts": { id: "p-aaaaaaaaaa", name: "新号" },
      "POST /api/client/session/client-1/account": { account: "p-aaaaaaaaaa" },
    });
    const answers = dialogs({ prompt: [" 新号 "], confirm: [true] });
    await runAccountAction(
      { kind: "create" },
      { sid: "client-1", list, dialogs: answers, refresh() {}, fetcher: fn },
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/accounts",
      "POST /api/client/session/client-1/account",
    ]);
    expect(calls[0]?.body).toEqual({ name: "新号" });
    expect(answers.reload).toHaveBeenCalledOnce();
  });

  it("never deletes the default account, and shows what the server refused", async () => {
    const { fn, calls } = fetcher({
      "DELETE /api/accounts/p-0123456789": new Error("别的设备正在用这个账号"),
    });
    await runAccountAction(
      { kind: "delete" },
      { sid: "client-1", list, dialogs: dialogs({ confirm: [true] }), refresh() {}, fetcher: fn },
    );
    expect(calls).toHaveLength(0);

    const onOther = { ...list, current: "p-0123456789" };
    const answers = dialogs({ confirm: [true] });
    const refresh = vi.fn();
    await runAccountAction(
      { kind: "delete" },
      { sid: "client-1", list: onOther, dialogs: answers, refresh, fetcher: fn },
    );
    expect(answers.alert).toHaveBeenCalledWith("别的设备正在用这个账号");
    expect(answers.reload).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });
});
