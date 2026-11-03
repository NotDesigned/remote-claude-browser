import {
  decodeDown,
  encodeMsg,
  EventType,
  IncrementalSource,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabHub } from "../hub/tabhub";
import { createWsServer, Fanout, type WsServer } from "./server";
import { STALL_BYTES, ViewerConn, type ViewerSocket } from "./viewerconn";
import { createRoleManager } from "./roles";

class MockSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly messages: Down[] = [];

  send(serialized: string): void {
    this.messages.push(decodeDown(serialized));
  }
}

function peer(join: () => Down[] = () => []) {
  const socket = new MockSocket();
  return { socket, viewer: new ViewerConn(socket, join, { drainPollMs: 10 }) };
}

function delta(timestamp: number, seq = 1): Extract<Down, { t: "delta" }> {
  return {
    t: "delta",
    tab: "same-tab",
    epoch: 1,
    seq,
    data: [
      {
        type: EventType.IncrementalSnapshot,
        timestamp,
        data: { source: IncrementalSource.Scroll, id: 7, x: 0, y: timestamp },
      },
    ],
  };
}

function readyHub(sessionId: string): TabHub {
  const hub = new TabHub({ sessionId, tabId: `tab-${sessionId}` });
  hub.ingest({ kind: "hello", docId: 1, url: `https://${sessionId}.test`, isTop: true, ts: 0 });
  const events: eventWithTime[] = [
    {
      type: EventType.Meta,
      timestamp: 1,
      data: { href: `https://${sessionId}.test`, width: 800, height: 600 },
    },
    {
      type: EventType.FullSnapshot,
      timestamp: 2,
      data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
    },
  ];
  for (const e of events) hub.ingest({ kind: "rrweb", docId: 1, e });
  return hub;
}

afterEach(() => vi.useRealTimers());

describe("session-scoped WebSocket fanout", () => {
  it("isolates every message type and keeps legacy broadcasts away from scoped viewers", () => {
    const fanout = new Fanout();
    const a = peer();
    const sameSession = peer();
    const b = peer();
    const legacy = peer();
    fanout.addViewer(a.viewer, "a");
    fanout.addViewer(sameSession.viewer, "a");
    fanout.addViewer(b.viewer, "b");
    fanout.addViewer(legacy.viewer);
    const messages: Down[] = [
      { t: "hello", viewerId: "owner-a", role: "driver", sessionId: "a" },
      { t: "pong", id: 1, sentTs: 1, serverTs: 2 },
      {
        t: "tabs",
        tabs: [{ id: "private", title: "private", url: "https://a.test", active: true }],
      },
      {
        t: "chrome",
        tab: "private",
        url: "https://a.test",
        loading: false,
        canBack: false,
        canFwd: false,
      },
      { t: "tab-state", tab: "private", state: "recovering" },
      { t: "snapshot", tab: "private", epoch: 1, seq: 1, data: [] },
      { t: "resync", tab: "private" },
      { t: "mode", tab: "private", mode: "px" },
      { t: "px", tab: "private", data: "private-image", w: 1, h: 1 },
      { t: "rtc-sig", tab: "private", lane: "private-lane", from: "agent", payload: {} },
      {
        t: "download",
        id: "private-file",
        name: "private.txt",
        recv: 1,
        total: 1,
        state: "done",
        href: "/s/a/file",
      },
      {
        t: "filepick",
        tab: "private",
        key: "private-key",
        multiple: false,
        maxFiles: 1,
        maxFileBytes: 10,
        maxTotalBytes: 10,
      },
      { t: "driver", viewerId: "owner-a" },
      { t: "clip", text: "private clipboard" },
      { t: "presence", viewers: [{ id: "owner-a", name: "private name" }] },
    ];
    try {
      for (const message of messages) fanout.publishToSession("a", message);
      expect(a.socket.messages).toEqual(messages);
      expect(sameSession.socket.messages).toEqual(messages);
      expect(b.socket.messages).toEqual([]);
      expect(legacy.socket.messages).toEqual([]);
      fanout.publish({ t: "clip", text: "legacy only" });
      expect(legacy.socket.messages).toEqual([{ t: "clip", text: "legacy only" }]);
      expect(a.socket.messages).toHaveLength(messages.length);
      expect(b.socket.messages).toEqual([]);
      expect(fanout.sessionForViewer(a.viewer)).toBe("a");
      expect(() => fanout.addViewer(a.viewer, "b")).toThrow("cannot change sessions");
    } finally {
      fanout.close();
    }
  });

  it("keeps same-tab delta batches separate and flushes only the joining session", () => {
    vi.useFakeTimers();
    const fanout = new Fanout(30);
    const a = peer();
    const b = peer();
    fanout.addViewer(a.viewer, "a");
    fanout.addViewer(b.viewer, "b");
    try {
      fanout.publishToSession("a", delta(10));
      fanout.publishToSession("b", delta(20));
      fanout.publishToSession("a", delta(11, 2));
      const joining = peer();
      fanout.addViewer(joining.viewer, "a");
      expect(a.socket.messages).toEqual([
        { ...delta(10), data: [...delta(10).data, ...delta(11).data] },
      ]);
      expect(joining.socket.messages).toEqual([]);
      expect(b.socket.messages).toEqual([]);
      vi.advanceTimersByTime(30);
      expect(b.socket.messages).toEqual([delta(20)]);
      expect(a.socket.messages).toHaveLength(1);
      expect(joining.socket.messages).toEqual([]);
    } finally {
      fanout.close();
    }
  });

  it("flushes only the recovering viewer's session when its backpressure drains", () => {
    vi.useFakeTimers();
    const fanout = new Fanout(30);
    const slow = peer();
    const fast = peer();
    const b = peer();
    fanout.addViewer(slow.viewer, "a");
    fanout.addViewer(fast.viewer, "a");
    fanout.addViewer(b.viewer, "b");
    try {
      const frame: Down = { t: "px", tab: "same-tab", data: "x", w: 1, h: 1 };
      slow.socket.bufferedAmount = STALL_BYTES + 1;
      slow.viewer.send(frame, encodeMsg(frame));
      fanout.publishToSession("a", delta(10));
      fanout.publishToSession("b", delta(20));
      slow.socket.bufferedAmount = 0;
      vi.advanceTimersByTime(10);
      expect(slow.viewer.isStalled).toBe(false);
      expect(fast.socket.messages).toEqual([delta(10)]);
      expect(b.socket.messages).toEqual([]);
      vi.advanceTimersByTime(20);
      expect(b.socket.messages).toEqual([delta(20)]);
    } finally {
      fanout.close();
    }
  });

  it("flushes tab control messages only against their own session's pending delta", () => {
    vi.useFakeTimers();
    const fanout = new Fanout(30);
    const a = peer();
    const b = peer();
    fanout.addViewer(a.viewer, "a");
    fanout.addViewer(b.viewer, "b");
    try {
      fanout.publishToSession("a", delta(10));
      fanout.publishToSession("b", delta(20));
      fanout.publishToSession("a", { t: "mode", tab: "same-tab", mode: "px" });
      expect(a.socket.messages).toEqual([delta(10), { t: "mode", tab: "same-tab", mode: "px" }]);
      expect(b.socket.messages).toEqual([]);
      fanout.flushSession("b");
      expect(b.socket.messages).toEqual([delta(20)]);
      vi.advanceTimersByTime(30);
      expect(b.socket.messages).toHaveLength(1);
    } finally {
      fanout.close();
    }
  });
});

describe("session-scoped WebSocket upgrades", () => {
  it("requires scoped join hubs instead of falling back to all sessions", () => {
    const server = createServer();
    expect(() => createWsServer({ server, hubs: () => [], sessionForRequest: () => "a" })).toThrow(
      "requires hubsForSession",
    );
  });

  it("binds authorized requests to immutable sessions for joins, messages and disconnects", async () => {
    const server = createServer();
    const hubs = new Map([
      ["a", readyHub("a")],
      ["b", readyHub("b")],
    ]);
    const legacyHubs = vi.fn(() => [...hubs.values()]);
    const resolveSession = vi.fn((request: IncomingMessage) => {
      const value = request.headers["x-test-session"];
      return typeof value === "string" ? value : undefined;
    });
    const connected = new Map<string, ViewerConn>();
    const onUp = vi.fn();
    const onDisconnection = vi.fn();
    const wsServer: WsServer = createWsServer({
      server,
      hubs: legacyHubs,
      authorizeUpgrade: (request) => request.headers["x-test-auth"] === "allowed",
      sessionForRequest: resolveSession,
      hubsForSession: (sid) => (hubs.has(sid) ? [hubs.get(sid)!] : []),
      onConnection(viewer, _request, sid) {
        expect(sid).toBeDefined();
        expect(wsServer.sessionForViewer(viewer)).toBe(sid);
        connected.set(sid!, viewer);
      },
      onUp,
      onDisconnection,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const clients: WebSocket[] = [];
    const connect = async (sid: string) => {
      const socket = new WebSocket(url, {
        headers: { "x-test-auth": "allowed", "x-test-session": sid },
      });
      clients.push(socket);
      const messages: Down[] = [];
      socket.on("message", (raw) => messages.push(decodeDown(raw.toString())));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return { socket, messages };
    };
    try {
      expect(await rejectionStatus(url, { "x-test-auth": "allowed" })).toBe(401);
      expect(await rejectionStatus(url, { "x-test-session": "a" })).toBe(401);
      const a = await connect("a");
      const b = await connect("b");
      await vi.waitFor(() => {
        expect(a.messages.some((message) => message.t === "snapshot")).toBe(true);
        expect(b.messages.some((message) => message.t === "snapshot")).toBe(true);
      });
      expect(a.messages.every((message) => !("tab" in message) || message.tab === "tab-a")).toBe(
        true,
      );
      expect(b.messages.every((message) => !("tab" in message) || message.tab === "tab-b")).toBe(
        true,
      );
      expect(legacyHubs).not.toHaveBeenCalled();
      wsServer.fanout.publishToSession("a", { t: "clip", text: "a private" });
      wsServer.fanout.publishToSession("b", {
        t: "presence",
        viewers: [{ id: "b", name: "b private" }],
      });
      await vi.waitFor(() => {
        expect(a.messages.some((message) => message.t === "clip")).toBe(true);
        expect(b.messages.some((message) => message.t === "presence")).toBe(true);
      });
      expect(a.messages.some((message) => message.t === "presence")).toBe(false);
      expect(b.messages.some((message) => message.t === "clip")).toBe(false);
      a.socket.send(encodeMsg({ t: "text", tab: "tab-a", insert: "own input" }));
      await vi.waitFor(() =>
        expect(onUp).toHaveBeenCalledWith(
          connected.get("a"),
          { t: "text", tab: "tab-a", insert: "own input" },
          "a",
        ),
      );
      expect(resolveSession).toHaveBeenCalledTimes(3);
      const aViewer = connected.get("a")!;
      const closed = new Promise<void>((resolve) => a.socket.once("close", () => resolve()));
      a.socket.close();
      await closed;
      await vi.waitFor(() => expect(onDisconnection).toHaveBeenCalledWith(aViewer, "a"));
      expect(wsServer.sessionForViewer(aViewer)).toBeUndefined();
    } finally {
      for (const client of clients) client.terminate();
      await wsServer.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const hub of hubs.values()) hub.invalidateDocument();
    }
  });

  it("revokes a released session before transport close and lets its new owner reconnect without affecting peers", async () => {
    const server = createServer();
    const connected = new Map<string, ViewerConn>();
    const onUp = vi.fn();
    const onDisconnection = vi.fn();
    const wsServer = createWsServer({
      server,
      sessionForRequest: (request) => {
        const sid = request.headers["x-test-session"];
        return typeof sid === "string" ? sid : undefined;
      },
      hubsForSession: () => [],
      onConnection: (viewer, _request, sid) => {
        connected.set(sid!, viewer);
      },
      onUp,
      onDisconnection,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const clients: WebSocket[] = [];
    let restoreTransport: () => void = () => undefined;
    const connect = async (sid: string) => {
      const socket = new WebSocket(url, { headers: { "x-test-session": sid } });
      clients.push(socket);
      const messages: Down[] = [];
      socket.on("message", (raw) => messages.push(decodeDown(raw.toString())));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return { socket, messages };
    };
    try {
      const oldA = await connect("a");
      const b = await connect("b");
      const oldViewer = connected.get("a")!;
      const bViewer = connected.get("b")!;
      const oldServerSocket = oldViewer.socket as WebSocket;
      // Hold the old transport open: isolation must not depend on its asynchronous close event.
      const terminate = vi.spyOn(oldServerSocket, "terminate").mockImplementation(() => undefined);
      restoreTransport = () => {
        terminate.mockRestore();
        oldServerSocket.terminate();
      };
      wsServer.fanout.publishToSession("a", delta(10));
      wsServer.closeSession("a");
      expect(terminate).toHaveBeenCalledOnce();
      expect(oldServerSocket.readyState).toBe(WebSocket.OPEN);
      expect(wsServer.fanout.viewerCount).toBe(1);
      expect(wsServer.fanout.sessionForViewer(oldViewer)).toBeUndefined();
      expect(wsServer.sessionForViewer(oldViewer)).toBeUndefined();
      expect(onDisconnection).not.toHaveBeenCalled();

      const newA = await connect("a");
      const newViewer = connected.get("a")!;
      wsServer.fanout.publishToSession("a", { t: "clip", text: "new owner private" });
      wsServer.fanout.publishToSession("b", { t: "clip", text: "b stays connected" });
      await vi.waitFor(() => {
        expect(newA.messages).toEqual([{ t: "clip", text: "new owner private" }]);
        expect(b.messages).toEqual([{ t: "clip", text: "b stays connected" }]);
      });
      expect(oldA.messages).toEqual([]);
      expect(b.socket.readyState).toBe(WebSocket.OPEN);
      const text = { t: "text", tab: "same-tab", insert: "owned input" } as const;
      oldA.socket.send(encodeMsg(text));
      b.socket.send(encodeMsg(text));
      newA.socket.send(encodeMsg(text));
      await vi.waitFor(() => expect(onUp).toHaveBeenCalledTimes(2));
      expect(onUp).toHaveBeenCalledWith(bViewer, text, "b");
      expect(onUp).toHaveBeenCalledWith(newViewer, text, "a");
      expect(onUp).not.toHaveBeenCalledWith(oldViewer, text, "a");

      const oldClosed = new Promise<void>((resolve) => oldA.socket.once("close", () => resolve()));
      restoreTransport();
      restoreTransport = () => undefined;
      await oldClosed;
      await vi.waitFor(() => expect(onDisconnection).toHaveBeenCalledWith(oldViewer, "a"));
      expect(onDisconnection).toHaveBeenCalledOnce();
    } finally {
      restoreTransport();
      for (const client of clients) client.terminate();
      await wsServer.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

async function rejectionStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => reject(new Error("unauthorized WebSocket opened")));
    socket.once("unexpected-response", (_request, response) => {
      socket.on("error", () => undefined);
      response.destroy();
      resolve(response.statusCode);
    });
    socket.once("error", reject);
  });
}

async function replacementHarness(
  authorizeUpgrade: (request: IncomingMessage) => boolean | Promise<boolean> = () => true,
  replaceSessionOnConnect = true,
  requireConnectionKey = false,
) {
  const server = createServer(),
    clients: WebSocket[] = [];
  const peers: { viewer: ViewerConn; sid: string; id: string }[] = [];
  const ids = new WeakMap<ViewerConn, string>();
  const disconnected: ViewerConn[] = [];
  const onUp = vi.fn();
  const roles = createRoleManager();
  const wsServer = createWsServer({
    server,
    replaceSessionOnConnect,
    requireConnectionKey,
    authorizeUpgrade,
    sessionForRequest: (request) => {
      const sid = request.headers["x-test-session"];
      return typeof sid === "string" ? sid : undefined;
    },
    hubsForSession: () => [],
    onConnection(viewer, _request, sid) {
      const id = `test-viewer-${peers.length + 1}`;
      ids.set(viewer, id);
      peers.push({ viewer, sid: sid!, id });
      roles.connect({
        sessionId: sid!,
        inviteRole: "driver",
        viewerId: id,
        send: (message, serialized) => viewer.send(message, serialized),
      });
    },
    onDisconnection(viewer) {
      disconnected.push(viewer);
      roles.disconnect(ids.get(viewer)!);
    },
    onUp,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const connect = async (sid: string, key?: string, headers: Record<string, string> = {}) => {
    const socket = new WebSocket(
      key === undefined ? url : `${url}?connectionKey=${encodeURIComponent(key)}`,
      {
        headers: { "x-test-session": sid, ...headers },
      },
    );
    clients.push(socket);
    const messages: Down[] = [];
    socket.on("message", (raw) => messages.push(decodeDown(raw.toString())));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return { socket, messages, closed };
  };
  return {
    wsServer,
    peers,
    disconnected,
    onUp,
    url,
    connect,
    async close() {
      for (const client of clients) client.terminate();
      await wsServer.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("replacing a workspace viewer", () => {
  it("prevents keyless old bundles repeatedly reconnecting from displacing a valid driver", async () => {
    const test = await replacementHarness(() => true, true, true);
    try {
      const active = await test.connect("a", "current-page"),
        other = await test.connect("b", "other-page");
      await vi.waitFor(() =>
        expect(active.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
      for (const key of [undefined, undefined, "bad.key", "", undefined]) {
        const oldBundle = await test.connect("a", key);
        expect(await oldBundle.closed).toEqual({ code: 4009, reason: "replaced" });
        expect(oldBundle.messages).toEqual([]);
        expect(active.socket.readyState).toBe(WebSocket.OPEN);
        expect(other.socket.readyState).toBe(WebSocket.OPEN);
      }
      expect(test.peers).toHaveLength(2);
      expect(test.disconnected).toEqual([]);
      expect(test.wsServer.fanout.viewerCount).toBe(2);
      active.socket.send(encodeMsg({ t: "text", tab: "tab-a", insert: "still current" }));
      await vi.waitFor(() => expect(test.onUp).toHaveBeenCalledOnce());
      expect(test.onUp).toHaveBeenCalledWith(
        test.peers[0]!.viewer,
        { t: "text", tab: "tab-a", insert: "still current" },
        "a",
      );
      const restored = await test.connect("a", "current-page");
      expect(await active.closed).toEqual({ code: 4009, reason: "replaced" });
      await vi.waitFor(() =>
        expect(restored.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
    } finally {
      await test.close();
    }
  });

  it("allows keyless raw clients when the opt-in migration guard is omitted", async () => {
    const test = await replacementHarness();
    try {
      const first = await test.connect("a", "first-page"),
        raw = await test.connect("a");
      expect(await first.closed).toEqual({ code: 4009, reason: "replaced" });
      await vi.waitFor(() =>
        expect(raw.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
    } finally {
      await test.close();
    }
  });

  it("preserves legacy followers unless replacement is enabled or explicitly requested", async () => {
    const test = await replacementHarness(() => true, false);
    try {
      const first = await test.connect("a", "first"),
        second = await test.connect("a", "second"),
        other = await test.connect("b", "other");
      await vi.waitFor(() =>
        expect(second.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "viewer",
        }),
      );
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
      const follower = test.peers.find((peer) => peer.id === "test-viewer-2")!;
      expect(() => test.wsServer.replaceSession("b", follower.viewer)).toThrow("does not belong");
      test.wsServer.replaceSession("a", follower.viewer);
      expect(await first.closed).toEqual({ code: 4009, reason: "replaced" });
      await vi.waitFor(() =>
        expect(
          second.messages.some(
            (message) => message.t === "driver" && message.viewerId === follower.id,
          ),
        ).toBe(true),
      );
      expect(other.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await test.close();
    }
  });

  it("revokes old input and roles synchronously before the new driver joins, preserving the other SID", async () => {
    const test = await replacementHarness();
    let restore = () => {};
    try {
      const old = await test.connect("a", "old-page"),
        other = await test.connect("b", "other-page");
      await vi.waitFor(() =>
        expect(
          old.messages.some((message) => message.t === "presence") &&
            other.messages.some((message) => message.t === "presence"),
        ).toBe(true),
      );
      const previous = test.peers.find((peer) => peer.sid === "a")!;
      const serverSocket = previous.viewer.socket as WebSocket;
      const close = vi.spyOn(serverSocket, "close").mockImplementation(() => undefined);
      restore = () => {
        close.mockRestore();
        serverSocket.close(4009, "replaced");
      };
      const latest = await test.connect("a", "new-page");
      await vi.waitFor(() =>
        expect(latest.messages.some((message) => message.t === "hello")).toBe(true),
      );
      expect(latest.messages.find((message) => message.t === "hello")).toMatchObject({
        role: "driver",
        sessionId: "a",
      });
      expect(test.disconnected).toEqual([previous.viewer]);
      expect(test.wsServer.sessionForViewer(previous.viewer)).toBeUndefined();
      expect(test.wsServer.fanout.viewerCount).toBe(2);
      expect(close).toHaveBeenCalledExactlyOnceWith(4009, "replaced");
      const oldCount = old.messages.length;
      test.wsServer.fanout.publishToSession("a", { t: "clip", text: "new page private" });
      old.socket.send(encodeMsg({ t: "text", tab: "tab-a", insert: "old input" }));
      other.socket.send(encodeMsg({ t: "text", tab: "tab-b", insert: "other input" }));
      await vi.waitFor(() => {
        expect(latest.messages.some((message) => message.t === "clip")).toBe(true);
        expect(test.onUp).toHaveBeenCalledOnce();
      });
      expect(old.messages).toHaveLength(oldCount);
      expect(other.messages.some((message) => message.t === "clip")).toBe(false);
      expect(other.socket.readyState).toBe(WebSocket.OPEN);
      restore();
      restore = () => {};
      expect(await old.closed).toEqual({ code: 4009, reason: "replaced" });
      expect(test.disconnected.filter((viewer) => viewer === previous.viewer)).toHaveLength(1);
    } finally {
      restore();
      await test.close();
    }
  });

  it("lets chat on the same page take over without retiring that page's WebSocket key", async () => {
    const test = await replacementHarness();
    try {
      const page = await test.connect("a", "unified-page");
      // Chat on the same page takes control: its socket closes but the key stays usable.
      test.wsServer.replaceSession("a", undefined, "unified-page");
      expect(await page.closed).toEqual({ code: 4009, reason: "replaced" });
      const back = await test.connect("a", "unified-page");
      await vi.waitFor(() =>
        expect(back.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
      // Chat from another page still retires this page's key for good.
      test.wsServer.replaceSession("a", undefined, "another-page");
      expect(await back.closed).toEqual({ code: 4009, reason: "replaced" });
      const retired = await test.connect("a", "unified-page");
      expect(await retired.closed).toEqual({ code: 4009, reason: "replaced" });
      expect(retired.messages).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it("rejects the retired page's network reconnect while allowing the same active page to reconnect", async () => {
    const test = await replacementHarness();
    try {
      const old = await test.connect("a", "old-page");
      old.socket.terminate();
      await old.closed;
      const current = await test.connect("a", "new-page");
      const retired = await test.connect("a", "old-page");
      expect(await retired.closed).toEqual({ code: 4009, reason: "replaced" });
      expect(retired.messages).toEqual([]);
      expect(test.peers).toHaveLength(2);
      current.socket.terminate();
      await current.closed;
      const restored = await test.connect("a", "new-page");
      await vi.waitFor(() =>
        expect(restored.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
      expect(test.peers).toHaveLength(3);
    } finally {
      await test.close();
    }
  });

  it("prevents an older authorized upgrade completing late from replacing a newer page", async () => {
    let finishSlow!: (allowed: boolean) => void;
    const slow = new Promise<boolean>((resolve) => {
      finishSlow = resolve;
    });
    const started = vi.fn();
    const test = await replacementHarness((request) => {
      if (request.headers["x-slow"] === "1") {
        started();
        return slow;
      }
      return true;
    });
    try {
      const pending = test.connect("a", "old-pending", { "x-slow": "1" });
      void pending.catch(() => {});
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      const latest = await test.connect("a", "new-page");
      finishSlow(true);
      const old = await pending;
      expect(await old.closed).toEqual({ code: 4009, reason: "replaced" });
      expect(old.messages).toEqual([]);
      expect(test.peers).toHaveLength(1);
      expect(latest.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      finishSlow(false);
      await test.close();
    }
  });

  it("lets only authenticated requests advance replacement ownership", async () => {
    const test = await replacementHarness((request) => request.headers["x-denied"] !== "1");
    try {
      const first = await test.connect("a", "active-page");
      expect(
        await rejectionStatus(`${test.url}?connectionKey=unauthorized-page`, {
          "x-test-session": "a",
          "x-denied": "1",
        }),
      ).toBe(401);
      expect(test.disconnected).toEqual([]);
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
      first.socket.terminate();
      await first.closed;
      const retry = await test.connect("a", "active-page");
      await vi.waitFor(() =>
        expect(retry.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
    } finally {
      await test.close();
    }
  });

  it("exposes explicit per-viewer replacement without touching another session", async () => {
    const test = await replacementHarness();
    try {
      const a = await test.connect("a", "page-a"),
        b = await test.connect("b", "page-b");
      const peer = test.peers.find((item) => item.sid === "a")!;
      expect(test.wsServer.closeViewer(peer.viewer)).toBe(true);
      expect(test.disconnected).toEqual([peer.viewer]);
      expect(test.wsServer.closeViewer(peer.viewer)).toBe(false);
      expect(await a.closed).toEqual({ code: 4009, reason: "replaced" });
      expect(b.socket.readyState).toBe(WebSocket.OPEN);
      expect(test.wsServer.fanout.viewerCount).toBe(1);
    } finally {
      await test.close();
    }
  });

  it("hands a SID to chat without allowing old sockets or pending upgrades to retake it", async () => {
    let finishSlow!: (allowed: boolean) => void;
    const slow = new Promise<boolean>((resolve) => {
      finishSlow = resolve;
    });
    const started = vi.fn();
    const test = await replacementHarness((request) => {
      if (request.headers["x-slow"] === "1") {
        started();
        return slow;
      }
      return true;
    });
    try {
      const current = await test.connect("a", "old-page"),
        other = await test.connect("b", "other-page");
      const pending = test.connect("a", "old-pending", { "x-slow": "1" });
      void pending.catch(() => {});
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      test.wsServer.replaceSession("a");
      expect(await current.closed).toEqual({ code: 4009, reason: "replaced" });
      finishSlow(true);
      const oldPending = await pending;
      expect(await oldPending.closed).toEqual({ code: 4009, reason: "replaced" });
      for (const key of ["old-page", "old-pending"]) {
        const retry = await test.connect("a", key);
        expect(await retry.closed).toEqual({ code: 4009, reason: "replaced" });
        expect(retry.messages).toEqual([]);
      }
      expect(test.peers).toHaveLength(2);
      expect(other.socket.readyState).toBe(WebSocket.OPEN);
      const newPage = await test.connect("a", "intentional-new-page");
      await vi.waitFor(() =>
        expect(newPage.messages.find((message) => message.t === "hello")).toMatchObject({
          role: "driver",
        }),
      );
    } finally {
      finishSlow(false);
      await test.close();
    }
  });
});
