/** Frontend identities. Browser-site credentials stay inside each user's Chrome profile. */
export type UserRole = "admin" | "user";

export interface FrontendUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface ManagedUser extends FrontendUser {
  enabled: boolean;
  createdAt: number;
}

export interface UserChanges {
  username?: string;
  password?: string;
  role?: UserRole;
  enabled?: boolean;
}

export class UserApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UserApiError";
  }
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
      : response.status === 401
        ? "登录已失效，请重新登录。"
        : response.status === 403
          ? "你没有管理用户的权限。"
          : `请求失败（${response.status}），请稍后重试。`;
  throw new UserApiError(response.status, message);
}

function isUser(value: unknown): value is FrontendUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    user.id.length > 0 &&
    typeof user.username === "string" &&
    user.username.length > 0 &&
    (user.role === "admin" || user.role === "user")
  );
}

function isManagedUser(value: unknown): value is ManagedUser {
  return (
    isUser(value) &&
    typeof (value as ManagedUser).enabled === "boolean" &&
    Number.isFinite((value as ManagedUser).createdAt)
  );
}

async function managedResponse(response: Response): Promise<ManagedUser> {
  const body: unknown = await response.json();
  const user = typeof body === "object" && body !== null && "user" in body ? body.user : body;
  if (!isManagedUser(user)) throw new Error("用户信息无法读取，请刷新后重试。");
  return user;
}

export async function currentUser(fetcher?: typeof fetch): Promise<FrontendUser> {
  const body: unknown = await (await call("/api/me", {}, fetcher)).json();
  const user = typeof body === "object" && body !== null && "user" in body ? body.user : body;
  if (!isUser(user)) throw new Error("登录信息无法读取，请重新登录。");
  return user;
}

export async function listUsers(fetcher?: typeof fetch): Promise<ManagedUser[]> {
  const body = (await (await call("/api/users", {}, fetcher)).json()) as { users?: unknown };
  if (!Array.isArray(body?.users) || !body.users.every(isManagedUser))
    throw new Error("用户列表无法读取，请刷新后重试。");
  return body.users;
}

export async function createUser(
  details: { username: string; password: string; role: UserRole },
  fetcher?: typeof fetch,
): Promise<ManagedUser> {
  return managedResponse(
    await call("/api/users", { method: "POST", body: JSON.stringify(details) }, fetcher),
  );
}

export async function updateUser(
  id: string,
  changes: UserChanges,
  fetcher?: typeof fetch,
): Promise<ManagedUser> {
  return managedResponse(
    await call(
      `/api/users/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(changes) },
      fetcher,
    ),
  );
}

export async function deleteUser(id: string, fetcher?: typeof fetch): Promise<void> {
  await call(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }, fetcher);
}

export async function logout(fetcher?: typeof fetch): Promise<void> {
  await call("/logout", { method: "POST" }, fetcher);
}

export interface MyBrowserSession {
  sid: string;
  label: string;
  profileId: string;
  profileName: string;
  currentDevice: boolean;
  createdAt: number;
}

export async function myBrowserSessions(): Promise<MyBrowserSession[]> {
  return (await (await call("/api/me/sessions")).json()).sessions;
}

export async function endMyBrowserSession(sid: string): Promise<void> {
  await call(`/api/me/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
}

export async function changeMyPassword(currentPassword: string, password: string): Promise<void> {
  await call("/api/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, password }),
  });
}
