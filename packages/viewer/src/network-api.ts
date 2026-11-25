import { apiRequest as request } from "./api";
export interface ProxySourceInfo {
  id: string;
  name: string;
  visibility: "shared" | "private";
  ownerId: string;
  ownerName: string | null;
  nodeCount: number;
  subscription: boolean;
  canManage: boolean;
  updatedAt: number;
}

export interface ProxyInfo {
  id: string;
  sourceId: string;
  name: string;
  type: string;
  visibility: "shared" | "private";
  ownerId: string;
}

export interface ExitHealth {
  browserTimeZone?: string;
  status: "unchecked" | "checking" | "healthy" | "error";
  checkedAt?: number;
  exitIp?: string;
  timeZone?: string;
  exitCity?: string;
  exitCountry?: string;
  error?: string;
}

export interface CpaInstance {
  id: string;
  ownerId: string | null;
  scope: "user" | "shared";
  desiredState: "running" | "stopped";
  status: "running" | "stopped" | "missing";
  createdAt: number;
  canManage: boolean;
  authorization: "unknown" | "empty" | "needs-binding" | "unavailable" | "ready";
  egress: ExitHealth["status"];
  authorizing: boolean;
}

export interface CpaCredential {
  name: string;
  provider: string;
  email?: string;
  label?: string;
  status?: string;
  disabled: boolean;
  unavailable: boolean;
  createdAt?: number;
  updatedAt?: number;
  proxyId: string | null;
  needsBinding: boolean;
  timeZone?: string;
  exitHealth?: ExitHealth;
}

export interface CpaKey {
  id: string;
  instanceId: string;
  userId: string;
  username: string | null;
  name: string;
  prefix: string;
  createdAt: number;
}

export interface CpaOAuth {
  url: string;
  state: string;
  status: "ok";
}
export type CpaPendingOAuth = Omit<CpaOAuth, "status"> & { proxyId: string };
export interface CpaBrowserAuthorization {
  userId: string;
  instanceId: string;
  state: string;
  proxyId: string;
}

/** A stored CPA authorization waiting for its browser; anything else in storage is ignored. */
export function isCpaBrowserAuthorization(value: unknown): value is CpaBrowserAuthorization {
  if (value === null || typeof value !== "object") return false;
  const fields = value as Record<string, unknown>;
  return ["userId", "instanceId", "state", "proxyId"].every(
    (key) => typeof fields[key] === "string" && fields[key] !== "",
  );
}

export interface ProxySourceInput {
  name: string;
  visibility: "shared" | "private";
  content?: string;
  url?: string;
}

const sourcePath = (id: string) => `/api/proxy-sources/${encodeURIComponent(id)}`;
const instancePath = (id: string) => `/api/cpa/instances/${encodeURIComponent(id)}`;

export const proxyApi = {
  sources: () => request<{ sources: ProxySourceInfo[] }>("/api/proxy-sources"),
  usage: (id: string) =>
    request<{ usage: { profiles: number; credentials: number } }>(`${sourcePath(id)}/usage`),
  proxies: () => request<{ proxies: ProxyInfo[] }>("/api/proxies"),
  check: (id: string) =>
    request<{ health: ExitHealth }>(`/api/proxies/${encodeURIComponent(id)}/check`, "POST"),
  create: (source: ProxySourceInput) =>
    request<{ source: ProxySourceInfo }>("/api/proxy-sources", "POST", source),
  update: (id: string, source: ProxySourceInput) =>
    request<{ source: ProxySourceInfo }>(sourcePath(id), "PATCH", source),
  refresh: (id: string) =>
    request<{ source: ProxySourceInfo }>(`${sourcePath(id)}/refresh`, "POST"),
  remove: (id: string) => request<void>(sourcePath(id), "DELETE"),
};

export const cpaApi = {
  openOAuth: (sid: string, instanceId: string, state: string) =>
    request<{ ok: true }>(`/api/client/session/${encodeURIComponent(sid)}/cpa/oauth`, "POST", {
      instanceId,
      state,
    }),
  instances: () => request<{ instances: CpaInstance[] }>("/api/cpa/instances"),
  create: (scope: CpaInstance["scope"]) =>
    request<{ instance: CpaInstance }>("/api/cpa/instances", "POST", { scope }),
  start: (id: string) => request<{ instance: CpaInstance }>(`${instancePath(id)}/start`, "POST"),
  stop: (id: string) => request<{ instance: CpaInstance }>(`${instancePath(id)}/stop`, "POST"),
  check: (id: string) => request<{ instance: CpaInstance }>(`${instancePath(id)}/check`, "POST"),
  cancelOAuth: (id: string) =>
    request<{ instance: CpaInstance }>(`${instancePath(id)}/oauth/cancel`, "POST"),
  credentials: (id: string) =>
    request<{ credentials: CpaCredential[] }>(`${instancePath(id)}/credentials`),
  credentialStatus: (id: string, name: string, disabled: boolean) =>
    request<{ ok: true }>(`${instancePath(id)}/credentials/status`, "PATCH", { name, disabled }),
  credentialProxy: (id: string, name: string, proxyId: string) =>
    request<{ ok: true }>(`${instancePath(id)}/credentials/proxy`, "PATCH", { name, proxyId }),
  removeCredential: (id: string, name: string) =>
    request<{ ok: true }>(
      `${instancePath(id)}/credentials?${new URLSearchParams({ name })}`,
      "DELETE",
    ),
  oauth: (id: string, proxyId: string) =>
    request<CpaOAuth>(`${instancePath(id)}/oauth`, "POST", {
      provider: "claude",
      proxyId,
    }),
  pendingOAuth: (id: string) =>
    request<{ sessions: CpaPendingOAuth[] }>(`${instancePath(id)}/oauth`),
  oauthStatus: (id: string, state: string) =>
    request<{ status: "wait" | "ok" | "error"; error?: string }>(
      `${instancePath(id)}/oauth/status?${new URLSearchParams({ state })}`,
    ),
  oauthCallback: (id: string, callback: { state: string; code?: string; redirectUrl?: string }) =>
    request<{ ok: true }>(`${instancePath(id)}/oauth/callback`, "POST", callback),
  keys: (id: string) => request<{ keys: CpaKey[] }>(`${instancePath(id)}/keys`),
  createKey: (id: string, name: string) =>
    request<{ key: CpaKey & { token: string } }>(`${instancePath(id)}/keys`, "POST", { name }),
  removeKey: (id: string, keyId: string) =>
    request<{ ok: true }>(`${instancePath(id)}/keys/${encodeURIComponent(keyId)}`, "DELETE"),
};

export type RemoteCcTokenKind = "client" | "host";
export interface RemoteCcToken {
  id: string;
  userId: string;
  kind: RemoteCcTokenKind;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export interface RemoteCcDeviceRequest {
  userCode: string;
  kind: RemoteCcTokenKind;
  name: string;
  createdAt: number;
  expiresAt: number;
  /** Where the machine that started the request connected from, so the user can recognise it. */
  ip: string | null;
  userAgent: string | null;
}
export interface RemoteCcLogin {
  id: string;
  profileId: string;
  profileName: string | null;
  status: "waiting" | "opened" | "done";
  createdAt: number;
  /** The connected computer (client token) that started this sign-in. */
  tokenName: string | null;
}
const devicePath = (code: string) => `/api/remote-cc/devices/${encodeURIComponent(code)}`;
export const remoteCcApi = {
  tokens: () => request<{ tokens: RemoteCcToken[] }>("/api/remote-cc/tokens"),
  removeToken: (id: string) =>
    request<void>(`/api/remote-cc/tokens/${encodeURIComponent(id)}`, "DELETE"),
  device: (code: string) => request<{ request: RemoteCcDeviceRequest }>(devicePath(code)),
  approve: (code: string) => request<{ ok: true }>(`${devicePath(code)}/approve`, "POST"),
  deny: (code: string) => request<{ ok: true }>(`${devicePath(code)}/deny`, "POST"),
  logins: () => request<{ logins: RemoteCcLogin[] }>("/api/remote-cc/logins"),
  cancelLogin: (id: string) =>
    request<void>(`/api/remote-cc/logins/${encodeURIComponent(id)}`, "DELETE"),
  /** Opens the sign-in page in this browser session (a new tab). */
  openLogin: (sid: string, id: string) =>
    request<{ ok: true }>(
      `/api/client/session/${encodeURIComponent(sid)}/remote-cc/logins/${encodeURIComponent(id)}/open`,
      "POST",
    ),
};
