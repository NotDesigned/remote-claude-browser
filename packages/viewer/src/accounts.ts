import type { ExitHealth } from "./network-api";
/**
 * The accounts a session can use. Each is a Chrome of its own on the server, so their logins never
 * mix; switching moves this session to another one, closing the pages it had open.
 */

export type BrowserPlatform = "windows" | "macos" | "linux";

export interface AccountInfo {
  id: string;
  name: string;
  platform: BrowserPlatform;
  browserEngine: "aliasmode" | "chromium";
  /** Whether its Chrome is running now. */
  running: boolean;
  /** How many sessions, on any device, use it. */
  sessions: number;
  /** Whether it is signed in to Claude. */
  signedIn?: boolean;
  /** The Claude account it is signed in as, once seen. */
  email?: string | null;
  /** Latest verification status for the signed-in account's current organization. */
  kyc?: { status: string; organizationId: string; checkedAt: number };
  /** Claude explicitly rejected the account, for example because it was disabled. */
  unavailable?: boolean;
  proxyId?: string | null;
  proxyName?: string | null;
  timeZone?: string;
  exitCity?: string;
  exitCountry?: string;
  exitIp?: string;
  checkedAt?: number;
}

export interface AccountList {
  accounts: AccountInfo[];
  platforms: BrowserPlatform[];
  defaultPlatform: BrowserPlatform;
  /** This user's default configuration. */
  default: string;
  /** The account this session uses. */
  current: string | null;
}

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
  if (!Array.isArray(list) || !list.every(isAccount)) throw new Error("浏览器配置列表无法读取");
  return {
    accounts: list,
    platforms: (value as AccountList).platforms,
    defaultPlatform: (value as AccountList).defaultPlatform,
    default: (value as { default: string }).default,
    current: typeof current === "string" ? current : null,
  };
}

export async function createAccount(
  name: string,
  proxyId?: string,
  fetcher?: typeof fetch,
  platform?: BrowserPlatform,
): Promise<AccountInfo> {
  const response = await call(
    "/api/accounts",
    { method: "POST", body: JSON.stringify({ name, proxyId, platform }) },
    fetcher,
  );
  const made = (await response.json()) as AccountInfo;
  return {
    id: made.id,
    name: made.name,
    platform: made.platform,
    browserEngine: made.browserEngine,
    proxyId: made.proxyId,
    running: false,
    sessions: 0,
    signedIn: false,
    email: null,
  };
}

export async function renameAccount(
  id: string,
  name: string,
  fetcher?: typeof fetch,
): Promise<{ name: string }> {
  const response = await call(
    `/api/accounts/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
    fetcher,
  );
  return response.json();
}

export async function setDefaultAccount(id: string): Promise<void> {
  await call(`/api/accounts/${encodeURIComponent(id)}/default`, { method: "POST" });
}

export async function deleteAccount(id: string, fetcher?: typeof fetch): Promise<void> {
  await call(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }, fetcher);
}

export interface ProxyChoice {
  id: string;
  name: string;
  visibility: "shared" | "private";
}

export async function listProxyChoices(): Promise<ProxyChoice[]> {
  return (await (await call("/api/proxies")).json()).proxies;
}

export async function setAccountProxy(id: string, proxyId: string | null): Promise<void> {
  await call(`/api/accounts/${encodeURIComponent(id)}/proxy`, {
    method: "PATCH",
    body: JSON.stringify({ proxyId }),
  });
}

export async function setAccountPlatform(
  id: string,
  platform: BrowserPlatform,
  fetcher?: typeof fetch,
): Promise<void> {
  await call(
    `/api/accounts/${encodeURIComponent(id)}/platform`,
    {
      method: "PATCH",
      body: JSON.stringify({ platform }),
    },
    fetcher,
  );
}

export async function checkAccountExit(
  id: string,
): Promise<{ scope: "browser" | "node"; health: ExitHealth }> {
  return (
    await call(`/api/accounts/${encodeURIComponent(id)}/exit/check`, { method: "POST" })
  ).json();
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
