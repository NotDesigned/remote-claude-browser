import { apiRequest } from "./api";
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

export async function currentUser(fetcher?: typeof fetch): Promise<FrontendUser> {
  return (await apiRequest<{ user: FrontendUser }>("/api/me", "GET", undefined, fetcher)).user;
}

export async function listUsers(fetcher?: typeof fetch): Promise<ManagedUser[]> {
  return (await apiRequest<{ users: ManagedUser[] }>("/api/users", "GET", undefined, fetcher))
    .users;
}

export function createUser(
  details: { username: string; password: string; role: UserRole },
  fetcher?: typeof fetch,
): Promise<ManagedUser> {
  return apiRequest("/api/users", "POST", details, fetcher);
}

export function updateUser(
  id: string,
  changes: UserChanges,
  fetcher?: typeof fetch,
): Promise<ManagedUser> {
  return apiRequest(`/api/users/${encodeURIComponent(id)}`, "PATCH", changes, fetcher);
}

export function deleteUser(id: string, fetcher?: typeof fetch): Promise<void> {
  return apiRequest(`/api/users/${encodeURIComponent(id)}`, "DELETE", undefined, fetcher);
}

export function logout(fetcher?: typeof fetch): Promise<void> {
  return apiRequest("/logout", "POST", undefined, fetcher);
}

export interface MyBrowserSession {
  sid: string;
  label: string;
  profileId: string;
  profileName: string;
  currentDevice: boolean;
  online: boolean;
  createdAt: number;
}

export async function myBrowserSessions(): Promise<MyBrowserSession[]> {
  return (await apiRequest<{ sessions: MyBrowserSession[] }>("/api/me/sessions")).sessions;
}

export async function endMyBrowserSession(sid: string): Promise<void> {
  await apiRequest(`/api/me/sessions/${encodeURIComponent(sid)}`, "DELETE");
}

export async function changeMyPassword(currentPassword: string, password: string): Promise<void> {
  await apiRequest("/api/me/password", "POST", { currentPassword, password });
}
