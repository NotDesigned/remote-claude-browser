/**
 * Routes only local replay fixtures get (MIRROR_E2E=1): advance the idle clock, read a session's
 * page sync state, and evaluate in its page. Never registered in production.
 */
import type { FastifyInstance } from "fastify";
import { SESSION_SLEEP_LIMIT_MS } from "../session/runtime-registry";
import type { GatewayContext } from "./context";

export function registerE2eRoutes(
  app: FastifyInstance,
  ctx: Pick<GatewayContext, "access" | "clientSessions" | "registry" | "idleReaper" | "status">,
  idle: {
    /** Moves the session idle clock forward. */
    advance(milliseconds: number): void;
    /** One pass of the sleeping-session and unused-account cleanup. */
    reap(): Promise<void>;
  },
): void {
  const { access, clientSessions, registry, idleReaper } = ctx;
  const { currentOwner } = access;
  app.post<{ Body: { milliseconds?: number } }>("/__e2e/advance-idle", async (request, reply) => {
    if (!currentOwner(request.raw)) return reply.code(401).send({ error: "Forbidden" });
    const amount = request.body?.milliseconds;
    if (!Number.isSafeInteger(amount) || amount! < 0 || amount! > SESSION_SLEEP_LIMIT_MS)
      return reply.code(400).send({ error: "Invalid test time" });
    await idleReaper.sweep();
    idle.advance(amount!);
    await idleReaper.sweep();
    await idle.reap();
    return ctx.status();
  });
  app.get("/__e2e/probe", async () => ({ serverTs: Date.now() }));
  app.get<{ Querystring: { sid?: string } }>("/__e2e/state", async (request, reply) => {
    const sid = request.query.sid;
    if (!sid || !clientSessions.owns(currentOwner(request.raw), sid))
      return reply.code(403).send({ error: "Forbidden" });
    const runtime = await registry.ensure(sid);
    return {
      sid,
      tabs: [...runtime.tabs.hubs()].map((hub) => ({
        tab: hub.tabId,
        epoch: hub.epoch,
        docId: hub.docId,
        seq: hub.seq,
        url: runtime.metadata.get(hub.tabId)?.url ?? "",
      })),
    };
  });
  app.post<{ Body: { sid?: string; tab?: string; expression?: string } }>(
    "/__e2e/evaluate",
    async (request, reply) => {
      const { sid, tab, expression } = request.body;
      if (!sid || !clientSessions.owns(currentOwner(request.raw), sid))
        return reply.code(403).send({ error: "Forbidden" });
      const runtime = await registry.ensure(sid),
        target = tab
          ? runtime.targets.get(tab)
          : [...runtime.targets.values()].find((item) => item.type === "page");
      if (!target || !runtime.browser.ownsTarget(target.targetId) || typeof expression !== "string")
        return reply.code(403).send({ error: "Forbidden" });
      const result = (await runtime.browser.send(target.sessionId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (result.exceptionDetails)
        return reply.code(500).send({ error: "Fixture expression failed" });
      return { value: result.result?.value };
    },
  );
}
