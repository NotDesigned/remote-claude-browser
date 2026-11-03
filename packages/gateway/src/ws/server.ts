/**
 * WebSocket fan-out server.
 *
 * `ws` with perMessageDeflate; fastify handles the HTTP upgrade path; delta batching at 30ms
 * flush; viewer join wired to TabHub.joinPayload(). NEVER JSON.stringify per viewer — serialize
 * once per broadcast (encodeMsg) and fan out the string. Auth middleware slot: SEC-2's cookie
 * guard runs at upgrade time (see ../auth/middleware.ts), not on first message.
 */
import {
  decodeResumeCursors,
  decodeUp,
  encodeMsg,
  type Down,
  type ResumeCursor,
  type Up,
} from "@mirror/protocol";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { TabHub } from "../hub/tabhub";
import { ViewerConn, type ViewerConnOpts, type ViewerSocket } from "./viewerconn";

export const DEFAULT_BATCH_MS = 30;
export const VIEWER_REPLACED_CODE = 4009;

export interface DeltaChaosOptions {
  /** Probability per (delta message, viewer). Production never supplies this option. */
  dropRate: number;
  random?: () => number;
}

export interface DeltaChaosStats {
  deltaMessagesConsidered: number;
  deltaMessagesDropped: number;
  droppedByTab: Readonly<Record<string, number>>;
}

interface PendingDelta {
  sessionId: string | undefined;
  msg: Extract<Down, { t: "delta" }>;
  timer: NodeJS.Timeout;
}

export class Fanout {
  private readonly viewers = new Map<ViewerConn, string | undefined>();
  private readonly pending = new Map<string, PendingDelta>();

  private readonly chaosRandom: () => number;
  private readonly chaosDropRate: number;
  private chaosConsidered = 0;
  private chaosDropped = 0;
  private readonly chaosDroppedByTab = new Map<string, number>();

  constructor(
    private readonly batchMs = DEFAULT_BATCH_MS,
    chaos?: DeltaChaosOptions,
  ) {
    if (!Number.isSafeInteger(batchMs) || batchMs < 1) {
      throw new RangeError("batchMs must be a positive safe integer");
    }
    this.chaosDropRate = chaos?.dropRate ?? 0;
    if (!Number.isFinite(this.chaosDropRate) || this.chaosDropRate < 0 || this.chaosDropRate > 1) {
      throw new RangeError("delta chaos dropRate must be between 0 and 1");
    }
    this.chaosRandom = chaos?.random ?? Math.random;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get chaosStats(): DeltaChaosStats {
    return {
      deltaMessagesConsidered: this.chaosConsidered,
      deltaMessagesDropped: this.chaosDropped,
      droppedByTab: Object.fromEntries(this.chaosDroppedByTab),
    };
  }

  addViewer(viewer: ViewerConn, sessionId?: string): void {
    if (sessionId !== undefined) assertSessionId(sessionId);
    if (this.viewers.has(viewer) && this.viewers.get(viewer) !== sessionId) {
      throw new Error("a viewer cannot change sessions without a new connection");
    }
    // A join payload already includes every event currently buffered by its hubs. Flushing first
    // prevents the new viewer from receiving those same events again when a pending batch fires.
    this.flushScope(sessionId);
    viewer.setBeforeResync(() => this.flushScope(sessionId));
    this.viewers.set(viewer, sessionId);
    viewer.sendJoinPayload();
  }

  removeViewer(viewer: ViewerConn): void {
    if (this.viewers.delete(viewer)) {
      viewer.setBeforeResync(undefined);
      viewer.dispose();
    }
  }

  sessionForViewer(viewer: ViewerConn): string | undefined {
    return this.viewers.get(viewer);
  }

  /** Legacy broadcasts remain confined to connections registered without a session. */
  publish(msg: Down): void {
    this.publishScoped(undefined, msg);
  }

  /** Every message type, including clipboard/download/presence, stays inside this session. */
  publishToSession(sessionId: string, msg: Down): void {
    assertSessionId(sessionId);
    this.publishScoped(sessionId, msg);
  }

  flushSession(sessionId: string): void {
    assertSessionId(sessionId);
    this.flushScope(sessionId);
  }

  private publishScoped(sessionId: string | undefined, msg: Down): void {
    if (msg.t !== "delta" || msg.data.length === 0) {
      if ("tab" in msg) this.flushTab(sessionId, msg.tab);
      this.broadcastNow(sessionId, msg);
      return;
    }

    const key = deltaKey(sessionId, msg.tab);
    const pending = this.pending.get(key);
    if (
      pending !== undefined &&
      pending.msg.epoch === msg.epoch &&
      msg.seq === pending.msg.seq + pending.msg.data.length
    ) {
      pending.msg.data.push(...msg.data);
      return;
    }

    this.flushTab(sessionId, msg.tab);
    const batched: Extract<Down, { t: "delta" }> = { ...msg, data: [...msg.data] };
    const timer = setTimeout(() => this.flushTab(sessionId, msg.tab), this.batchMs);
    timer.unref();
    this.pending.set(key, { sessionId, msg: batched, timer });
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flushPending(key);
  }

  close(): void {
    this.flushAll();
    for (const viewer of this.viewers.keys()) {
      viewer.setBeforeResync(undefined);
      viewer.dispose();
    }
    this.viewers.clear();
  }

  private flushScope(sessionId: string | undefined): void {
    for (const [key, pending] of [...this.pending]) {
      if (pending.sessionId === sessionId) this.flushPending(key);
    }
  }

  private flushTab(sessionId: string | undefined, tabId: string): void {
    this.flushPending(deltaKey(sessionId, tabId));
  }

  private flushPending(key: string): void {
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    this.broadcastNow(pending.sessionId, pending.msg);
  }

  private broadcastNow(sessionId: string | undefined, msg: Down): void {
    const serialized = encodeMsg(msg);
    for (const [viewer, viewerSessionId] of this.viewers) {
      if (viewerSessionId !== sessionId) continue;
      if (msg.t === "delta" && this.chaosDropRate > 0) {
        this.chaosConsidered += 1;
        if (this.chaosRandom() < this.chaosDropRate) {
          this.chaosDropped += 1;
          const key = sessionId === undefined ? msg.tab : deltaKey(sessionId, msg.tab);
          this.chaosDroppedByTab.set(key, (this.chaosDroppedByTab.get(key) ?? 0) + 1);
          continue;
        }
      }
      viewer.send(msg, serialized);
    }
  }
}

export type UpgradeGuard = (request: IncomingMessage) => boolean | Promise<boolean>;

export interface WsServerOpts {
  /** Pass Fastify's `fastify.server`; integration retains ownership of the composition root. */
  server: HttpServer;
  hubs?(): Iterable<TabHub>;
  /** Resolve the authorized request's immutable SID. Missing SID rejects the upgrade. */
  sessionForRequest?: (request: IncomingMessage) => string | undefined;
  /** Required with sessionForRequest; never fall back to all hubs for an isolated viewer. */
  hubsForSession?: (sessionId: string) => Iterable<TabHub>;
  path?: string;
  batchMs?: number;
  viewerConn?: ViewerConnOpts;
  /** Test-only application-frame RTT shim; half is applied in each WS direction. */
  simulatedRttMs?: number;
  /** Test-only per-viewer delta loss. Omitted in every production composition. */
  deltaChaos?: DeltaChaosOptions;
  authorizeUpgrade?: UpgradeGuard;
  /** A newer authorized page replaces the prior connection in its SID; legacy defaults false. */
  replaceSessionOnConnect?: boolean;
  /** Reject old keyless viewers before they can replace a newer page; opt-in migration guard. */
  requireConnectionKey?: boolean;
  onUp?: (viewer: ViewerConn, msg: Up, sessionId: string | undefined) => void | Promise<void>;
  onConnection?: (
    viewer: ViewerConn,
    request: IncomingMessage,
    sessionId: string | undefined,
  ) => void;
  onDisconnection?: (viewer: ViewerConn, sessionId: string | undefined) => void;
}

export interface WsServer {
  readonly fanout: Fanout;
  readonly webSocketServer: WebSocketServer;
  /** Available during onConnection and cleared on revocation or disconnect. */
  sessionForViewer(viewer: ViewerConn): string | undefined;
  /** Revoke subscriptions synchronously before a released SID can be assigned to a new owner. */
  closeSession(sessionId: string): void;
  /** Revoke input/fanout and notify disconnection synchronously before closing the transport. */
  closeViewer(viewer: ViewerConn, code?: number, reason?: string): boolean;
  /** Keep this viewer, or revoke all for a chat handoff. Other SIDs are never affected. */
  replaceSession(sessionId: string, keepViewer?: ViewerConn): void;
  close(): Promise<void>;
}

export function createWsServer(opts: WsServerOpts): WsServer {
  if (opts.sessionForRequest !== undefined && opts.hubsForSession === undefined) {
    throw new TypeError("sessionForRequest requires hubsForSession");
  }
  if (opts.replaceSessionOnConnect && opts.sessionForRequest === undefined)
    throw new TypeError("replaceSessionOnConnect requires sessionForRequest");
  const path = opts.path ?? "/ws";
  const simulatedRttMs = opts.simulatedRttMs ?? 0;
  if (!Number.isSafeInteger(simulatedRttMs) || simulatedRttMs < 0) {
    throw new RangeError("simulatedRttMs must be a non-negative safe integer");
  }
  const oneWayDelayMs = simulatedRttMs / 2;
  const fanout = new Fanout(opts.batchMs, opts.deltaChaos);
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const authorizedSessions = new WeakMap<IncomingMessage, string>();
  const viewerSessions = new WeakMap<ViewerConn, string | undefined>();
  const viewerSockets = new Map<ViewerConn, WebSocket>();
  const viewerKeys = new WeakMap<ViewerConn, string>();
  const disconnected = new WeakSet<ViewerConn>();
  const upgradeOrders = new WeakMap<IncomingMessage, number>();
  const latestUpgrade = new Map<string, number>();
  const activeKeys = new Map<string, string>();
  const retiredKeys = new Map<string, Set<string>>();
  let nextUpgrade = 0;
  const retireKey = (sid: string, key: string | undefined) => {
    if (!key) return;
    const keys = retiredKeys.get(sid) ?? new Set<string>();
    keys.add(key);
    retiredKeys.set(sid, keys);
  };
  const notifyDisconnection = (viewer: ViewerConn, sid: string | undefined) => {
    if (disconnected.has(viewer)) return;
    disconnected.add(viewer);
    opts.onDisconnection?.(viewer, sid);
  };
  const closeViewer = (
    viewer: ViewerConn,
    code = VIEWER_REPLACED_CODE,
    reason = "replaced",
    retire = true,
  ): boolean => {
    const socket = viewerSockets.get(viewer);
    if (!socket) return false;
    if (
      !Number.isInteger(code) ||
      !(
        (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
        (code >= 3000 && code <= 4999)
      ) ||
      Buffer.byteLength(reason) > 123
    )
      throw new RangeError("Invalid viewer close code or reason");
    const sid = viewerSessions.get(viewer);
    viewerSockets.delete(viewer);
    viewerSessions.delete(viewer);
    fanout.removeViewer(viewer);
    viewer.dispose();
    if (retire && sid && code === VIEWER_REPLACED_CODE) retireKey(sid, viewerKeys.get(viewer));
    // Roles/input ownership must be gone before the replacement's onConnection runs.
    notifyDisconnection(viewer, sid);
    socket.close(code, reason);
    const deadline = setTimeout(() => socket.terminate(), 1000);
    deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
    return true;
  };
  const replaceSession = (sid: string, keepViewer?: ViewerConn) => {
    assertSessionId(sid);
    if (keepViewer && (viewerSessions.get(keepViewer) !== sid || !viewerSockets.has(keepViewer)))
      throw new Error("replacement viewer does not belong to this session");
    if (!keepViewer) {
      // Chat can take control while an older WS is still awaiting async authorization.
      latestUpgrade.set(sid, ++nextUpgrade);
      retireKey(sid, activeKeys.get(sid));
      activeKeys.delete(sid);
    }
    for (const [viewer] of [...viewerSockets]) {
      if (viewer === keepViewer || viewerSessions.get(viewer) !== sid) continue;
      closeViewer(
        viewer,
        VIEWER_REPLACED_CODE,
        "replaced",
        !keepViewer || viewerKeys.get(viewer) !== viewerKeys.get(keepViewer),
      );
    }
  };

  webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const sessionId = authorizedSessions.get(request);
    if (opts.sessionForRequest !== undefined && sessionId === undefined) {
      socket.close(1008, "session required");
      return;
    }
    const connectionKey = connectionKeyFor(request);
    if (opts.replaceSessionOnConnect && sessionId !== undefined) {
      if (opts.requireConnectionKey && connectionKey === undefined) {
        // Old bundles retry even after 4009. They must never advance ownership or join a SID.
        socket.close(VIEWER_REPLACED_CODE, "replaced");
        return;
      }
      const order = upgradeOrders.get(request)!;
      if (
        order < (latestUpgrade.get(sessionId) ?? 0) ||
        (connectionKey !== undefined && retiredKeys.get(sessionId)?.has(connectionKey))
      ) {
        // Complete the WS handshake so the browser receives a terminal code, not retrying 1006.
        if (connectionKey !== activeKeys.get(sessionId)) retireKey(sessionId, connectionKey);
        socket.close(VIEWER_REPLACED_CODE, "replaced");
        return;
      }
      latestUpgrade.set(sessionId, order);
      const oldKey = activeKeys.get(sessionId);
      if (oldKey !== connectionKey) retireKey(sessionId, oldKey);
      if (connectionKey) activeKeys.set(sessionId, connectionKey);
      else activeKeys.delete(sessionId);
    }
    // A reconnecting viewer may continue from its resume cursors, but only on its first join:
    // drain recovery after a stall always rebuilds from a fresh snapshot.
    let resumeCursors = resumeCursorsFor(request);
    const joinPayload = (): Down[] => {
      const hubs =
        sessionId === undefined ? (opts.hubs?.() ?? []) : opts.hubsForSession!(sessionId);
      const cursors = resumeCursors;
      resumeCursors = [];
      return [...hubs].flatMap((hub) =>
        hub.joinPayload(cursors.find((cursor) => cursor.tab === hub.tabId)),
      );
    };
    const viewerSocket: ViewerSocket =
      oneWayDelayMs === 0 ? socket : new DelayedViewerSocket(socket, oneWayDelayMs);
    const viewer = new ViewerConn(viewerSocket, joinPayload, opts.viewerConn);
    viewerSessions.set(viewer, sessionId);
    viewerSockets.set(viewer, socket);
    if (connectionKey) viewerKeys.set(viewer, connectionKey);

    socket.on("message", (data, isBinary) => {
      delay(oneWayDelayMs, () => {
        if (!viewerSockets.has(viewer) || socket.readyState !== socket.OPEN) return;
        if (isBinary) {
          socket.close(1003, "text messages only");
          return;
        }
        let msg: Up;
        try {
          msg = decodeUp(data.toString());
        } catch {
          socket.close(1003, "invalid message");
          return;
        }
        if (msg.t === "ping") {
          const pong: Extract<Down, { t: "pong" }> = {
            t: "pong",
            id: msg.id,
            sentTs: msg.sentTs,
            serverTs: Date.now(),
          };
          viewer.send(pong, encodeMsg(pong));
          return;
        }
        if (msg.t === "px-ack") {
          if (typeof msg.tab === "string") viewer.ackPx(msg.tab);
          return;
        }
        Promise.resolve(opts.onUp?.(viewer, msg, sessionId)).catch(() =>
          socket.close(1011, "handler failed"),
        );
      });
    });
    socket.once("close", () => {
      try {
        notifyDisconnection(viewer, sessionId);
      } finally {
        viewerSockets.delete(viewer);
        viewerSessions.delete(viewer);
        fanout.removeViewer(viewer);
      }
    });
    if (opts.replaceSessionOnConnect && sessionId !== undefined) replaceSession(sessionId, viewer);
    opts.onConnection?.(viewer, request, sessionId);
    if (viewerSockets.has(viewer)) fanout.addViewer(viewer, sessionId);
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void handleUpgrade(request, socket, head);
  };

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    const requestPath = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
    if (requestPath !== path) {
      rejectUpgrade(socket, "404 Not Found");
      return;
    }
    upgradeOrders.set(request, ++nextUpgrade);

    let authorized = true;
    let sessionId: string | undefined;
    try {
      authorized = (await opts.authorizeUpgrade?.(request)) ?? true;
      if (authorized && opts.sessionForRequest !== undefined) {
        sessionId = opts.sessionForRequest(request);
        if (sessionId === undefined) authorized = false;
        else assertSessionId(sessionId);
      }
    } catch {
      authorized = false;
    }
    if (!authorized) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }

    if (sessionId !== undefined) authorizedSessions.set(request, sessionId);
    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      webSocketServer.emit("connection", ws, request);
    });
  };

  opts.server.on("upgrade", onUpgrade);

  return {
    fanout,
    webSocketServer,
    sessionForViewer: (viewer) => viewerSessions.get(viewer),
    closeViewer,
    replaceSession,
    closeSession(sessionId) {
      assertSessionId(sessionId);
      if (opts.replaceSessionOnConnect) {
        latestUpgrade.set(sessionId, ++nextUpgrade);
        retireKey(sessionId, activeKeys.get(sessionId));
        activeKeys.delete(sessionId);
      }
      const closing = [...viewerSockets].filter(
        ([viewer]) => viewerSessions.get(viewer) === sessionId,
      );
      // Remove every old subscription before terminating any transport. Socket close events are
      // asynchronous; the slot may already be reused when those callbacks finally run.
      for (const [viewer] of closing) {
        viewerSockets.delete(viewer);
        viewerSessions.delete(viewer);
        fanout.removeViewer(viewer);
      }
      // No subscriber remains in this SID, so old pending deltas can be discarded immediately.
      fanout.flushSession(sessionId);
      for (const [, socket] of closing) socket.terminate();
    },
    close: async () => {
      opts.server.off("upgrade", onUpgrade);
      fanout.close();
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      latestUpgrade.clear();
      activeKeys.clear();
      retiredKeys.clear();
    },
  };
}

/** Resume cursors a reconnecting viewer reported in its WebSocket URL. */
export function resumeCursorsFor(request: IncomingMessage): ResumeCursor[] {
  try {
    return decodeResumeCursors(
      new URL(request.url ?? "/", "http://gateway.invalid").searchParams.get("resume"),
    );
  } catch {
    return [];
  }
}

function connectionKeyFor(request: IncomingMessage): string | undefined {
  const key = new URL(request.url ?? "/", "http://gateway.invalid").searchParams.get(
    "connectionKey",
  );
  return key !== null && /^[A-Za-z0-9_-]{1,128}$/.test(key) ? key : undefined;
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new TypeError("sessionId must be a non-empty string");
  }
}

function deltaKey(sessionId: string | undefined, tabId: string): string {
  return JSON.stringify([sessionId ?? null, tabId]);
}

class DelayedViewerSocket implements ViewerSocket {
  constructor(
    private readonly socket: WebSocket,
    private readonly delayMs: number,
  ) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  set bufferedAmount(_value: number) {
    // `ws` owns this counter; ViewerSocket keeps it writable only for the fan-out test double.
  }

  send(data: string): void {
    delay(this.delayMs, () => {
      if (this.socket.readyState === this.socket.OPEN) this.socket.send(data);
    });
  }
}

function delay(delayMs: number, callback: () => void): void {
  if (delayMs === 0) {
    callback();
    return;
  }
  const timer = setTimeout(callback, delayMs);
  timer.unref();
}

function rejectUpgrade(socket: Duplex, status: "401 Unauthorized" | "404 Not Found"): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
