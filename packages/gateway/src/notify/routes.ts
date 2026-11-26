/**
 * The notification feed: GET /s/:sid/notify is a server-sent event stream of the session's
 * notification messages (notify, notify-close, notify-ask, notify-ask-end), and POST to the same
 * path takes the viewer's three (notify-permission, notify-event, notify-answer).
 *
 * It is separate from the WebSocket because a workbench in the background closes that, which is
 * exactly when a notification matters. The stream carries nothing else and costs a heartbeat.
 */
import { encodeMsg, tryDecodeUp, type Up } from "@mirror/protocol";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { IncomingMessage } from "node:http";
import type { NotifyRelay } from "./relay";

/** A comment line this often keeps proxies and the browser from giving up on a quiet stream. */
export const NOTIFY_HEARTBEAT_MS = 25_000;
const NOTIFY_BODY_LIMIT = 16 * 1024;
const VIEWER_MESSAGES: ReadonlySet<string> = new Set([
  "notify-permission",
  "notify-event",
  "notify-answer",
]);

export interface NotifyRouteOptions {
  relay: Pick<NotifyRelay, "addFeed" | "onViewer">;
  /** The session guard (SEC-2), as for downloads and uploads. */
  preHandler: preHandlerAsyncHookHandler;
  /** Whether the request's login may still use the session. */
  authorized(request: IncomingMessage, sid: string): boolean;
  heartbeatMs?: number;
}

export function registerNotifyRoutes(app: FastifyInstance, options: NotifyRouteOptions): void {
  const ends = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of [...ends]) end();
  });

  app.get<{ Params: { sid: string } }>(
    "/s/:sid/notify",
    { preHandler: options.preHandler },
    async (request, reply) => {
      const sid = request.params.sid;
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        // Nginx would otherwise hold the stream back; Caddy flushes it as it comes.
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      });
      response.write(":ok\n\n");
      let ended = false;
      const heartbeat = setInterval(
        () => response.write(":\n\n"),
        options.heartbeatMs ?? NOTIFY_HEARTBEAT_MS,
      );
      heartbeat.unref?.();
      const end = () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        ends.delete(end);
        forget();
        response.end();
      };
      ends.add(end);
      const forget = options.relay.addFeed(sid, {
        send(message) {
          if (!ended) response.write(`data: ${encodeMsg(message)}\n\n`);
        },
        close: end,
        authorized: () => options.authorized(request.raw, sid),
      });
      request.raw.on("close", end);
      response.on("error", end);
    },
  );

  app.post<{ Params: { sid: string }; Body: unknown }>(
    "/s/:sid/notify",
    { preHandler: options.preHandler, bodyLimit: NOTIFY_BODY_LIMIT },
    async (request, reply) => {
      let message: Up | null = null;
      try {
        message = tryDecodeUp(JSON.stringify(request.body ?? null));
      } catch {
        message = null;
      }
      if (message === null || !VIEWER_MESSAGES.has(message.t))
        return reply.code(400).send({ error: "无法识别的通知消息" });
      options.relay.onViewer(request.params.sid, message);
      return reply.code(204).header("cache-control", "no-store").send();
    },
  );
}
