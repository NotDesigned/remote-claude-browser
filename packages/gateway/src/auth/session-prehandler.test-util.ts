import type { preHandlerAsyncHookHandler } from "fastify";
import { createSessionGuard } from "./middleware";

/**
 * A route guard for tests of session-scoped routes: the device cookie must verify and name the
 * route's sid. The gateway itself checks the workspace's owner instead (auth/session-access.ts).
 */
export function cookieSessionPreHandler(
  key: Buffer,
  now: () => number,
): preHandlerAsyncHookHandler {
  const guard = createSessionGuard({ key, now });
  return async (request, reply) => {
    const invite = guard.session(request.raw);
    const sid = (request.params as { sid?: unknown } | null)?.sid;
    if (invite === null || (sid !== undefined && sid !== invite.sid))
      await reply.code(403).send({ error: "Forbidden" });
  };
}
