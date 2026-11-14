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

export interface CpaInstance {
  id: string;
  ownerId: string | null;
  scope: "user" | "shared";
  desiredState: "running" | "stopped";
  status: "running" | "stopped" | "missing";
  createdAt: number;
  canManage: boolean;
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

export interface ProxySourceInput {
  name: string;
  visibility: "shared" | "private";
  content?: string;
  url?: string;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.message ?? value.error ?? `请求失败（${response.status}）`);
  return value as T;
}

const sourcePath = (id: string) => `/api/proxy-sources/${encodeURIComponent(id)}`;
const instancePath = (id: string) => `/api/cpa/instances/${encodeURIComponent(id)}`;

export const proxyApi = {
  sources: () => request<{ sources: ProxySourceInfo[] }>("/api/proxy-sources"),
  usage: (id: string) =>
    request<{ usage: { profiles: number; credentials: number } }>(`${sourcePath(id)}/usage`),
  proxies: () => request<{ proxies: ProxyInfo[] }>("/api/proxies"),
  create: (source: ProxySourceInput) =>
    request<{ source: ProxySourceInfo }>("/api/proxy-sources", "POST", source),
  update: (id: string, source: Omit<ProxySourceInput, "url">) =>
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
