import { apiRequest } from "./api";
import type { ServerStatusMsg } from "@mirror/protocol";
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
  maxSessions: number | null;
}

export interface UserChanges {
  username?: string;
  password?: string;
  role?: UserRole;
  enabled?: boolean;
  maxSessions?: number | null;
}

export interface MyAccount {
  hasPassword: boolean;
  /** Single sign-on when configured: its button label and the linked external accounts. */
  sso: { label: string; linked: { email: string | null; lastLoginAt: number }[] } | null;
}

export async function myAccount(fetcher?: typeof fetch): Promise<MyAccount> {
  const { hasPassword, sso } = await apiRequest<MyAccount>("/api/me", "GET", undefined, fetcher);
  return { hasPassword: hasPassword !== false, sso: sso ?? null };
}

export async function currentUser(fetcher?: typeof fetch): Promise<FrontendUser> {
  return (await apiRequest<{ user: FrontendUser }>("/api/me", "GET", undefined, fetcher)).user;
}

export async function listUsers(fetcher?: typeof fetch): Promise<ManagedUser[]> {
  return (await apiRequest<{ users: ManagedUser[] }>("/api/users", "GET", undefined, fetcher))
    .users;
}

export function createUser(
  details: { username: string; password: string; role: UserRole; maxSessions?: number | null },
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

export interface AdminSession {
  sid: string;
  label: string;
  userId: string;
  username: string;
  profileId: string;
  profileName: string;
  online: boolean;
  running: boolean;
  currentDevice: boolean;
  createdAt: number;
}

export interface AdminOverview {
  users: (ManagedUser & {
    profileCount: number;
    sessionCount: number;
    onlineSessions: number;
    /** The linked single sign-on account's email ("" if unknown); null if none. */
    sso?: string | null;
  })[];
  sessions: AdminSession[];
  resources: ServerStatusMsg;
  runningProfiles: number;
}

export const adminOverview = () => apiRequest<AdminOverview>("/api/admin/overview");
export const endAdminSession = (sid: string) =>
  apiRequest<void>(`/api/admin/sessions/${encodeURIComponent(sid)}`, "DELETE");

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
