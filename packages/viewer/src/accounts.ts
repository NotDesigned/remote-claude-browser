/**
 * The accounts a session can use. Each is a Chrome of its own on the server, so their logins never
 * mix; switching moves this session to another one, closing the pages it had open.
 */

export interface AccountInfo {
  id: string;
  name: string;
  /** Whether its Chrome is running now. */
  running: boolean;
  /** How many sessions, on any device, use it. */
  sessions: number;
}

export interface AccountList {
  accounts: AccountInfo[];
  /** The account this session uses. */
  current: string | null;
}

export const DEFAULT_ACCOUNT = "default";

async function call(path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch) {
  const response = await fetcher(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: init.body === undefined ? init.headers : { "content-type": "application/json" },
  });
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `请求失败（${response.status}）`;
  throw new Error(message);
}

function isAccount(value: unknown): value is AccountInfo {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.running === "boolean" &&
    Number.isSafeInteger(item.sessions)
  );
}

export async function listAccounts(
  sid: string | null,
  fetcher?: typeof fetch,
): Promise<AccountList> {
  const query = sid === null ? "" : `?sid=${encodeURIComponent(sid)}`;
  const value: unknown = await (await call(`/api/accounts${query}`, {}, fetcher)).json();
  const list = (value as { accounts?: unknown })?.accounts;
  const current = (value as { current?: unknown })?.current;
  if (!Array.isArray(list) || !list.every(isAccount)) throw new Error("账号列表无法读取");
  return { accounts: list, current: typeof current === "string" ? current : null };
}

export async function createAccount(name: string, fetcher?: typeof fetch): Promise<AccountInfo> {
  const response = await call(
    "/api/accounts",
    { method: "POST", body: JSON.stringify({ name }) },
    fetcher,
  );
  const made = (await response.json()) as { id: string; name: string };
  return { id: made.id, name: made.name, running: false, sessions: 0 };
}

export async function renameAccount(
  id: string,
  name: string,
  fetcher?: typeof fetch,
): Promise<void> {
  await call(
    `/api/accounts/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
    fetcher,
  );
}

export async function deleteAccount(id: string, fetcher?: typeof fetch): Promise<void> {
  await call(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }, fetcher);
}

export async function switchAccount(
  sid: string,
  id: string,
  fetcher?: typeof fetch,
): Promise<void> {
  await call(
    `/api/client/session/${encodeURIComponent(sid)}/account`,
    { method: "POST", body: JSON.stringify({ account: id }) },
    fetcher,
  );
}

export type AccountAction =
  { kind: "switch"; id: string } | { kind: "create" } | { kind: "rename" } | { kind: "delete" };

export interface AccountDialogs {
  confirm(message: string): boolean;
  prompt(message: string, value?: string): string | null;
  alert(message: string): void;
  reload(): void;
}

/**
 * Carries out one action from the menu. Anything that moves this session to another account
 * reloads the page, which reconnects it to that account's Chrome.
 */
export async function runAccountAction(
  action: AccountAction,
  context: {
    sid: string;
    list: AccountList;
    dialogs: AccountDialogs;
    refresh(): void;
    fetcher?: typeof fetch;
  },
): Promise<void> {
  const { sid, list, dialogs } = context;
  const current = list.accounts.find((account) => account.id === list.current);
  const move = async (id: string) => {
    await switchAccount(sid, id, context.fetcher);
    dialogs.reload();
  };
  try {
    if (action.kind === "switch") {
      if (action.id === list.current) return;
      const target = list.accounts.find((account) => account.id === action.id);
      if (!target) return;
      if (!dialogs.confirm(`切换到「${target.name}」？这个会话现在打开的页面会关闭。`)) return;
      await move(target.id);
    } else if (action.kind === "create") {
      const name = dialogs.prompt("新账号的名字")?.trim();
      if (!name) return;
      const made = await createAccount(name, context.fetcher);
      if (dialogs.confirm(`已新建「${made.name}」。现在把这个会话切换过去吗？`))
        await move(made.id);
      else context.refresh();
    } else if (action.kind === "rename") {
      if (!current) return;
      const name = dialogs.prompt("账号的名字", current.name)?.trim();
      if (!name || name === current.name) return;
      await renameAccount(current.id, name, context.fetcher);
      context.refresh();
    } else {
      if (!current || current.id === DEFAULT_ACCOUNT) return;
      if (
        !dialogs.confirm(
          `删除「${current.name}」？它的登录状态和浏览数据都会被清除，不能恢复。这个会话会先切换到默认账号。`,
        )
      )
        return;
      await deleteAccount(current.id, context.fetcher);
      dialogs.reload();
    }
  } catch (error) {
    dialogs.alert(error instanceof Error ? error.message : String(error));
    context.refresh();
  }
}
