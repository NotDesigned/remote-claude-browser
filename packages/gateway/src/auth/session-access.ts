/**
 * Who is asking, and which workspaces and browser profiles are theirs.
 *
 * A signed-in browser is a user (the login cookie) on a device (the signed device cookie). The pair
 * is the session owner, `<user id>/device-…`; a workspace belongs to one owner, and it may only run
 * on a browser profile its user owns. Every route, upgrade and viewer message asks here.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ClientSessionError, type createClientSessions } from "../session/clients";
import { mintInvite, type Invite } from "./invite";
import { SESSION_COOKIE } from "./middleware";
import { USER_SESSION_TTL_MS, UserStoreError, type FrontendUser } from "./users";

export const profileForbidden = () =>
  new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");

/** The requester's own workspace: who asks, as which device, and its browser if one runs. */
export interface SessionGrant<R> {
  user: FrontendUser;
  owner: string;
  runtime: R | undefined;
}

export interface SessionAccessDeps<R> {
  /** Test fixtures name the owner in a header and act as the administrator. */
  e2e: boolean;
  /** The signing key of the device cookie. */
  key: Buffer;
  bootstrapAdmin(): FrontendUser;
  signedInUser(request: IncomingMessage): FrontendUser | null;
  deviceSession(request: IncomingMessage): Invite | null;
  sessions: Pick<Awaited<ReturnType<typeof createClientSessions>>, "owns" | "profileOf">;
  profileOwner(profileId: string): string | undefined;
  isStopping(): boolean;
  isClosing(sid: string): boolean;
  runtimeOf(sid: string): R | undefined;
}

export type SessionAccess<R> = ReturnType<typeof createSessionAccess<R>>;

export function createSessionAccess<R>(deps: SessionAccessDeps<R>) {
  const ownerForUser = (request: IncomingMessage, user: FrontendUser): string | undefined => {
    const invite = deps.deviceSession(request);
    return invite?.role === "driver" && invite.sid.startsWith("device-")
      ? `${user.id}/${invite.sid}`
      : undefined;
  };
  const currentUser = (request: IncomingMessage): FrontendUser | null =>
    deps.e2e ? deps.bootstrapAdmin() : deps.signedInUser(request);
  const currentOwner = (request: IncomingMessage): string | undefined => {
    if (deps.e2e) {
      const value =
        request.headers["x-mirror-e2e-owner"] ??
        new URL(request.url ?? "/", "http://local").searchParams.get("e2e-owner");
      return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
        ? `test-${value}`
        : undefined;
    }
    const user = deps.signedInUser(request);
    return user ? ownerForUser(request, user) : undefined;
  };
  /** The user an owner key belongs to. */
  const userIdForOwner = (owner: string): string | undefined =>
    deps.e2e && owner.startsWith("test-")
      ? deps.bootstrapAdmin().id
      : owner.includes("/")
        ? owner.slice(0, owner.indexOf("/"))
        : undefined;
  const ownsProfile = (userId: string, profileId: string) =>
    deps.profileOwner(profileId) === userId;
  /** The workspace is this owner's, on a profile of this user, whether or not it is closing. */
  const owns = (user: FrontendUser, owner: string | undefined, sid: string) =>
    deps.sessions.owns(owner, sid) && ownsProfile(user.id, deps.sessions.profileOf(sid));
  const sessionGrant = (request: IncomingMessage, sid: string): SessionGrant<R> | undefined => {
    const user = currentUser(request);
    const owner = currentOwner(request);
    if (!user || !owner || deps.isClosing(sid) || !owns(user, owner, sid)) return undefined;
    return { user, owner, runtime: deps.runtimeOf(sid) };
  };

  return {
    currentUser,
    currentOwner,
    ownerForUser,
    userIdForOwner,
    /** Whether the requester owns the workspace, even while it is closing. */
    ownsSession(request: IncomingMessage, sid: string): boolean {
      const user = currentUser(request);
      return !!user && owns(user, currentOwner(request), sid);
    },
    /** The requester's own workspace that is not closing, or undefined. */
    sessionGrant,
    /** Like sessionGrant, but refuses with CLIENT_FORBIDDEN. */
    authorizeSession(request: IncomingMessage, sid: string): SessionGrant<R> {
      const grant = sessionGrant(request, sid);
      if (!grant) throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前客户端");
      return grant;
    },
    /** The requester is still signed in as this owner, and the service is not shutting down. */
    requireLiveOwner(request: IncomingMessage, owner: string): FrontendUser {
      const user = currentUser(request);
      if (deps.isStopping() || !user || currentOwner(request) !== owner)
        throw new UserStoreError(401, "LOGIN_REQUIRED", "请重新登录");
      return user;
    },
    ownsProfile,
    /** Refuses a browser profile that is not this user's. */
    requireOwnProfile(userId: string | undefined, profileId: string): void {
      if (userId === undefined || !ownsProfile(userId, profileId)) throw profileForbidden();
    },
    /** A fresh device cookie, keeping the device identity the request already has. */
    deviceCookie(request: IncomingMessage): string {
      const previous = deps.deviceSession(request);
      const device =
        previous?.role === "driver" && previous.sid.startsWith("device-")
          ? previous.sid
          : `device-${randomUUID()}`;
      const maxAge = USER_SESSION_TTL_MS / 1000;
      const exp = Math.floor(Date.now() / 1000) + maxAge;
      return `${SESSION_COOKIE}=${mintInvite({ sid: device, role: "driver", exp }, deps.key)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
    },
  };
}
