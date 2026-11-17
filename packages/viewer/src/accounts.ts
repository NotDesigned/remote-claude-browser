import { apiRequest } from "./api";
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
  onlineSessions: number;
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

const accountPath = (id: string) => `/api/accounts/${encodeURIComponent(id)}`;

export function listAccounts(sid: string | null, fetcher?: typeof fetch): Promise<AccountList> {
  return apiRequest(
    `/api/accounts${sid === null ? "" : `?sid=${encodeURIComponent(sid)}`}`,
    "GET",
    undefined,
    fetcher,
  );
}

export async function createAccount(
  name: string,
  proxyId?: string,
  fetcher?: typeof fetch,
  platform?: BrowserPlatform,
): Promise<AccountInfo> {
  const made = await apiRequest<AccountInfo>(
    "/api/accounts",
    "POST",
    { name, proxyId, platform },
    fetcher,
  );
  return { ...made, running: false, sessions: 0, onlineSessions: 0, signedIn: false, email: null };
}

export function renameAccount(
  id: string,
  name: string,
  fetcher?: typeof fetch,
): Promise<{ name: string }> {
  return apiRequest(accountPath(id), "PATCH", { name }, fetcher);
}

export function setDefaultAccount(id: string): Promise<void> {
  return apiRequest(`${accountPath(id)}/default`, "POST");
}

export function deleteAccount(id: string, fetcher?: typeof fetch): Promise<void> {
  return apiRequest(accountPath(id), "DELETE", undefined, fetcher);
}

export interface ProxyChoice {
  id: string;
  name: string;
  visibility: "shared" | "private";
}

export async function listProxyChoices(): Promise<ProxyChoice[]> {
  return (await apiRequest<{ proxies: ProxyChoice[] }>("/api/proxies")).proxies;
}

export function setAccountProxy(id: string, proxyId: string | null): Promise<void> {
  return apiRequest(`${accountPath(id)}/proxy`, "PATCH", { proxyId });
}

export function setAccountPlatform(
  id: string,
  platform: BrowserPlatform,
  fetcher?: typeof fetch,
): Promise<void> {
  return apiRequest(`${accountPath(id)}/platform`, "PATCH", { platform }, fetcher);
}

export function checkAccountExit(
  id: string,
): Promise<{ scope: "browser" | "node"; health: ExitHealth }> {
  return apiRequest(`${accountPath(id)}/exit/check`, "POST");
}

export function switchAccount(sid: string, id: string, fetcher?: typeof fetch): Promise<void> {
  return apiRequest(
    `/api/client/session/${encodeURIComponent(sid)}/account`,
    "POST",
    { account: id },
    fetcher,
  );
}
