/**
 * The signed device cookie. A signed-in browser carries one `driver` token whose sid names the
 * device (`device-…`); the gateway keys a user's workspaces by it and checks it again on every
 * WebSocket upgrade.
 */
import type { IncomingMessage } from "node:http";
import { readCookie } from "./cookies";
import { type Invite, verifyInvite } from "./invite";

export const SESSION_COOKIE = "__Host-mirror-session";

export interface SessionGuardOptions {
  key: Buffer;
  now?: () => number;
}

export interface SessionGuard {
  readonly authorizeUpgrade: (request: IncomingMessage) => boolean;
  session(request: IncomingMessage): Invite | null;
}

export function createSessionGuard(options: SessionGuardOptions): SessionGuard {
  // Validate the key eagerly instead of discovering a deployment error on the first request.
  verifyInvite("invalid", options.key, 0);
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));

  const session = (request: IncomingMessage): Invite | null => {
    const token = readCookie(request, SESSION_COOKIE);
    return token === undefined || token === "" ? null : verifyInvite(token, options.key, now());
  };

  return {
    authorizeUpgrade: (request) => session(request) !== null,
    session,
  };
}
