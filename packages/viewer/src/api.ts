/** Same-origin workbench APIs share authentication and error handling. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The page to sign in again on. */
export const GATE_PATH = "/gate";

let redirecting = false;
const goToGate = () => {
  if (redirecting || typeof window === "undefined") return;
  redirecting = true;
  window.location.assign(GATE_PATH);
};
let authExpired: () => void = goToGate;

/**
 * What a 401 from any workbench API does: the sign-in is gone, so go back to the gate. Tests swap
 * it out; passing nothing restores the default.
 */
export function setAuthExpiredHandler(handler?: () => void): void {
  authExpired = handler ?? goToGate;
  redirecting = false;
}

export interface ApiOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** A 401 here is an answer, not an expired sign-in (signing out of an expired session). */
  allowUnauthorized?: boolean;
}

function isJson(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return /^application\/(?:[\w.+-]+\+)?json\b/i.test(type.trim());
}

/** The response's JSON value, or null when it is empty or not JSON (a proxy's HTML error page). */
export async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204 || !isJson(response)) return null;
  const text = await response.text().catch(() => "");
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(status: number, body: unknown): string {
  if (body !== null && typeof body === "object") {
    const { message, error } = body as { message?: unknown; error?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof error === "string" && error) return error;
  }
  return `请求失败（${status}）`;
}

/**
 * One fetch of a workbench API: same-origin credentials, no cache, and a 401 handed to the
 * expired-sign-in handler. Returns the response whatever its status.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  options: ApiOptions = {},
): Promise<Response> {
  const response = await (options.fetcher ?? fetch)(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (response.status === 401 && !options.allowUnauthorized) authExpired();
  return response;
}

export async function apiRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  fetcher?: typeof fetch,
  options: Omit<ApiOptions, "fetcher"> = {},
): Promise<T> {
  const response = await apiFetch(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    { ...options, fetcher },
  );
  const value = await readJsonBody(response);
  if (!response.ok)
    throw new ApiError(response.status, errorMessage(response.status, value), value);
  return (value ?? undefined) as T;
}
