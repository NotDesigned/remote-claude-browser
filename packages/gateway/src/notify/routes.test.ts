import type { Down, Up } from "@mirror/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { NotifyFeed } from "./relay";
import { registerNotifyRoutes } from "./routes";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const feeds: Array<{
    sid: string;
    feed: NotifyFeed;
    device: string | undefined;
    forgotten: boolean;
  }> = [];
  const viewer: Array<{ sid: string; message: Up }> = [];
  let authorized = true;
  const app = Fastify();
  apps.push(app);
  registerNotifyRoutes(app, {
    relay: {
      addFeed(sid, feed, device) {
        const entry = { sid, feed, device, forgotten: false };
        feeds.push(entry);
        return () => {
          entry.forgotten = true;
        };
      },
      onViewer: (sid, message) => viewer.push({ sid, message }),
    },
    // Only the session "mine" belongs to the requester.
    preHandler: async (request, reply) => {
      if ((request.params as { sid: string }).sid !== "mine")
        await reply.code(403).send({ error: "no" });
    },
    authorized: () => authorized,
    heartbeatMs: 20,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    app,
    port,
    feeds,
    viewer,
    revoke: () => (authorized = false),
  };
}

/** Opens the event stream and collects its data lines. */
function openStream(port: number, sid: string, query = "") {
  const messages: Down[] = [];
  let raw = "";
  let status = 0;
  let headers: Record<string, unknown> = {};
  let ended = false;
  let abort = () => undefined as void;
  const ready = new Promise<void>((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: `/s/${sid}/notify${query}` },
      (response) => {
        status = response.statusCode ?? 0;
        headers = response.headers;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          raw += chunk;
          for (const line of chunk.split("\n"))
            if (line.startsWith("data: ")) messages.push(JSON.parse(line.slice(6)) as Down);
          resolve();
        });
        response.on("end", () => {
          ended = true;
          resolve();
        });
      },
    );
    req.on("error", () => resolve());
    req.end();
    abort = () => void req.destroy();
  });
  const stream = {
    messages,
    ready,
    abort: () => abort(),
    get raw() {
      return raw;
    },
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get ended() {
      return ended;
    },
  };
  return stream;
}

const until = async (check: () => boolean) => {
  for (let index = 0; index < 100 && !check(); index++)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("notification feed routes", () => {
  it("streams the session's notifications as server-sent events with heartbeats", async () => {
    const { port, feeds } = await setup();
    const stream = openStream(port, "mine", "?device=laptop-0001");
    await stream.ready;
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(stream.headers["cache-control"]).toBe("no-store");
    await until(() => feeds.length === 1);
    expect(feeds[0]!.sid).toBe("mine");
    expect(feeds[0]!.device).toBe("laptop-0001");
    feeds[0]!.feed.send({ t: "notify-close", id: "n1" });
    await until(() => stream.messages.length === 1);
    expect(stream.messages).toEqual([{ t: "notify-close", id: "n1" }]);
    await until(() => (stream.raw.match(/^:\n/gm) ?? []).length >= 1);
    expect(stream.raw).toMatch(/^:\n/m);
    stream.abort();
    await until(() => feeds[0]!.forgotten);
    expect(feeds[0]!.forgotten).toBe(true);
  });

  it("ends the stream when the relay closes the feed", async () => {
    const { port, feeds } = await setup();
    const stream = openStream(port, "mine");
    await stream.ready;
    await until(() => feeds.length === 1);
    expect(feeds[0]!.feed.authorized()).toBe(true);
    feeds[0]!.feed.close();
    await until(() => stream.ended);
    expect(stream.ended).toBe(true);
    expect(feeds[0]!.forgotten).toBe(true);
  });

  it("refuses another client's session", async () => {
    const { app, feeds, viewer } = await setup();
    const get = await app.inject({ method: "GET", url: "/s/theirs/notify" });
    expect(get.statusCode).toBe(403);
    const post = await app.inject({
      method: "POST",
      url: "/s/theirs/notify",
      payload: { t: "notify-event", id: "n1", type: "click" },
    });
    expect(post.statusCode).toBe(403);
    expect(feeds).toEqual([]);
    expect(viewer).toEqual([]);
  });

  it("takes the viewer's three messages and nothing else", async () => {
    const { app, viewer } = await setup();
    const click = await app.inject({
      method: "POST",
      url: "/s/mine/notify",
      payload: { t: "notify-event", id: "n1", type: "click" },
    });
    expect(click.statusCode).toBe(204);
    expect(viewer).toEqual([
      { sid: "mine", message: { t: "notify-event", id: "n1", type: "click" } },
    ]);
    for (const payload of [{ t: "clip", text: "x" }, { t: "nope" }, [1, 2]]) {
      const response = await app.inject({ method: "POST", url: "/s/mine/notify", payload });
      expect(response.statusCode).toBe(400);
    }
    const large = await app.inject({
      method: "POST",
      url: "/s/mine/notify",
      payload: { t: "notify-answer", id: "x".repeat(20_000), state: "granted" },
    });
    expect(large.statusCode).toBe(413);
    expect(viewer).toHaveLength(1);
  });
});
