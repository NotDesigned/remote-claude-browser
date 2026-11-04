import type { PxQuality } from "@mirror/protocol";
export const CLIENT_KEY_STORAGE_KEY = "mirror.client-session.key";

export type ClientSessionId =
  `client-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16}`;

export interface OwnedClientSession {
  sid: ClientSessionId;
  label: string;
}

export interface ClientSession extends OwnedClientSession {
  maxClients: number;
  available: number;
  sharedAccount: true;
}

export interface ClientSessionRequest {
  clientKey: string;
  sid?: string;
}

export class ClientSessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly ownedSessions: readonly OwnedClientSession[] = [],
  ) {
    super(message);
    this.name = "ClientSessionError";
  }
}

export function clientPageMode(url: URL): "fixture" | "closed" | "session" {
  if (url.searchParams.get("closed") === "1") return "closed";
  return url.searchParams.has("fixture") ? "fixture" : "session";
}

/** A reload reuses this tab's key; an explicit new-session link rotates it exactly once. */
export function prepareClientSession(
  url: URL,
  storage: Pick<Storage, "getItem" | "setItem">,
  replaceUrl: (url: string) => void,
  randomUUID: () => string = () => crypto.randomUUID(),
): ClientSessionRequest {
  const newSession = url.searchParams.get("new") === "1";
  let clientKey: string;
  try {
    const stored = storage.getItem(CLIENT_KEY_STORAGE_KEY);
    clientKey = !newSession && stored !== null && isUuid(stored) ? stored : randomUUID();
    storage.setItem(CLIENT_KEY_STORAGE_KEY, clientKey);
  } catch {
    throw new ClientSessionError(
      0,
      "CLIENT_STORAGE",
      "浏览器无法保存此标签页的会话标识，请允许本网站使用会话存储后重试。",
    );
  }
  if (newSession) {
    url.searchParams.delete("new");
    url.searchParams.delete("sid");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  }
  const sid = url.searchParams.get("sid");
  return { clientKey, ...(sid === null || sid === "" ? {} : { sid }) };
}

interface ClientRequestOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export async function requestClientSession(
  request: ClientSessionRequest,
  options: ClientRequestOptions = {},
): Promise<ClientSession> {
  let response: Response;
  try {
    response = await requestApi(
      "/api/client/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      options,
    );
  } catch (error) {
    // A saved link can outlive its recycled slot. Ask only for our own key after that rejection.
    if (
      request.sid !== undefined &&
      error instanceof ClientSessionError &&
      error.status === 403 &&
      error.code === "CLIENT_FORBIDDEN"
    ) {
      return requestClientSession({ clientKey: request.clientKey }, options);
    }
    throw error;
  }
  const value: unknown = await response.json().catch(() => null);
  if (
    !isRecord(value) ||
    !isSid(value.sid) ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    !Number.isSafeInteger(value.maxClients) ||
    (value.maxClients as number) < 1 ||
    (value.maxClients as number) > 100 ||
    !Number.isSafeInteger(value.available) ||
    (value.available as number) < 0 ||
    (value.available as number) > (value.maxClients as number) ||
    value.sharedAccount !== true
  ) {
    throw new ClientSessionError(502, "CLIENT_RESPONSE", "会话服务响应异常，请稍后重试。");
  }
  return {
    sid: value.sid,
    label: value.label,
    maxClients: value.maxClients as number,
    available: value.available as number,
    sharedAccount: true,
  };
}

export async function endClientSession(
  sid: ClientSessionId,
  options: ClientRequestOptions = {},
): Promise<void> {
  await requestApi(`/api/client/session/${encodeURIComponent(sid)}`, { method: "DELETE" }, options);
}

async function requestApi(
  path: string,
  init: RequestInit,
  options: ClientRequestOptions,
): Promise<Response> {
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ClientSessionError(0, "CLIENT_NETWORK", "暂时无法连接会话服务，请检查网络后重试。");
  }
  if (response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  const code = isRecord(body) && typeof body.code === "string" ? body.code : "CLIENT_REQUEST";
  const ownedSessions =
    isRecord(body) && Array.isArray(body.ownedSessions)
      ? body.ownedSessions.flatMap((item): OwnedClientSession[] => {
          if (!isRecord(item) || !isSid(item.sid) || typeof item.label !== "string") return [];
          return [{ sid: item.sid, label: item.label }];
        })
      : [];
  const message =
    response.status === 401
      ? "登录已失效，请重新登录后重试。"
      : response.status === 403
        ? "当前设备无权使用这个会话，请重新登录或返回自己的会话。"
        : response.status === 503 && code === "CLIENT_CAPACITY"
          ? "会话名额已占用。请返回已有会话，或等待空闲名额后重试。"
          : response.status === 503 && code === "CLIENT_RESOURCES"
            ? "B 的内存较紧张，请等待离线会话自动回收后重试。"
            : response.status === 503
              ? "会话服务暂时不可用，请稍后重试。"
              : "无法完成会话请求，请稍后重试。";
  throw new ClientSessionError(response.status, code, message, ownedSessions);
}

export function clientGatewayUrl(pageUrl: string, sid?: ClientSessionId): string {
  const url = new URL("/ws", pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (sid !== undefined) url.searchParams.set("sid", sid);
  return url.href;
}

export function clientReturnUrl(sid: ClientSessionId): string {
  return `/?${new URLSearchParams({ sid })}`;
}

function isSid(value: unknown): value is ClientSessionId {
  return typeof value === "string" && /^client-(?:[1-9]|1[0-6])$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ViewMode = "chat" | "dom" | "px";
export const VIEW_MODE_STORAGE_KEY = "mirror.view-mode";

/** Text chat is the everyday view; DOM and pixel views are remembered when chosen explicitly. */
export function preferredViewMode(storage: Pick<Storage, "getItem">): ViewMode {
  try {
    const value = storage.getItem(VIEW_MODE_STORAGE_KEY);
    return value === "dom" || value === "px" ? value : "chat";
  } catch {
    return "chat";
  }
}

export function rememberViewMode(storage: Pick<Storage, "setItem">, mode: ViewMode): void {
  try {
    storage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    /* A blocked store only loses the preference. */
  }
}

export const PX_QUALITY_STORAGE_KEY = "mirror.px-quality";

/** The picture detail chosen on this device; the sharpest one until someone asks for less. */
export function preferredPxQuality(storage: Pick<Storage, "getItem">): PxQuality {
  try {
    const value = storage.getItem(PX_QUALITY_STORAGE_KEY);
    return value === "low" || value === "medium" ? value : "high";
  } catch {
    return "high";
  }
}
