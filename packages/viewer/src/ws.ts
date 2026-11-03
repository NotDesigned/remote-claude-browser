/**
 * Reconnecting typed WebSocket client.
 *
 * There is deliberately no resume cursor: a reconnect asks the mirror to discard its local
 * state and the gateway supplies a fresh snapshot (D10).
 */
import { decodeDown, decodePxBinary, encodeMsg, type Down, type Up } from "@mirror/protocol";

export interface GatewaySocket {
  send(msg: Up): void;
  close(): void;
}

export type GatewayConnectionState = "connecting" | "open" | "closed" | "replaced";

export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  binaryType?: string;
  send(data: string): void;
  close(): void;
}

export interface GatewaySocketOptions {
  /** Called for every state transition. `reconnected` is true after the first successful open. */
  onStateChange?(state: GatewayConnectionState, reconnected: boolean): void;
  onProtocolError?(error: Error): void;
  reconnectDelayMs?: number;
  socketFactory?(url: string): WebSocketLike;
  /** Recurring application-level WebSocket ping/pong RTT. */
  onRttSample?(rttMs: number): void;
  rttIntervalMs?: number;
  now?: () => number;
  /** Identifies this page instance across reconnects; it grants no access permissions. */
  connectionKey?: string;
  /** Encoded resume cursors for the next (re)connect, or null to request a full rebuild. */
  resumeParam?: () => string | null;
}

const OPEN = 1;
export const RTT_INTERVAL_MS = 5_000;
export const VIEWER_REPLACED_CODE = 4009;

export function connectGateway(
  url: string,
  onDown: (msg: Down) => void,
  options: GatewaySocketOptions = {},
): GatewaySocket {
  const makeSocket: (socketUrl: string) => WebSocketLike =
    options.socketFactory ??
    ((socketUrl: string) => new WebSocket(socketUrl) as unknown as WebSocketLike);
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  const rttIntervalMs = options.rttIntervalMs ?? RTT_INTERVAL_MS;
  if (!Number.isSafeInteger(rttIntervalMs) || rttIntervalMs < 1) {
    throw new RangeError("rttIntervalMs must be a positive safe integer");
  }
  const now = options.now ?? Date.now;
  const socketUrl = new URL(url);
  socketUrl.searchParams.set(
    "connectionKey",
    options.connectionKey ?? globalThis.crypto.randomUUID(),
  );
  let socket: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let rttTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let hasOpened = false;
  let nextPingId = 1;
  const pendingPings = new Map<number, number>();
  const pending: Up[] = [];

  const stopRtt = () => {
    if (rttTimer !== null) clearInterval(rttTimer);
    rttTimer = null;
    pendingPings.clear();
  };

  const ping = () => {
    if (socket?.readyState !== OPEN) return;
    const id = nextPingId++;
    const sentTs = now();
    pendingPings.clear();
    pendingPings.set(id, sentTs);
    socket.send(encodeMsg({ t: "ping", id, sentTs }));
  };

  const notify = (state: GatewayConnectionState) => {
    options.onStateChange?.(state, hasOpened);
  };

  const open = () => {
    if (disposed) return;
    notify("connecting");
    const resume = hasOpened ? (options.resumeParam?.() ?? null) : null;
    if (resume === null) socketUrl.searchParams.delete("resume");
    else socketUrl.searchParams.set("resume", resume);
    const current = makeSocket(socketUrl.href);
    // Pixel frames arrive as binary JPEG frames; read them as ArrayBuffers, not Blobs.
    current.binaryType = "arraybuffer";
    socket = current;

    current.onopen = () => {
      if (disposed || current !== socket) return;
      const reconnected = hasOpened;
      hasOpened = true;
      options.onStateChange?.("open", reconnected);
      while (pending.length > 0 && current.readyState === OPEN) {
        current.send(encodeMsg(pending.shift()!));
      }
      stopRtt();
      rttTimer = setInterval(ping, rttIntervalMs);
    };

    current.onmessage = (event) => {
      if (disposed || current !== socket) return;
      try {
        const message =
          event.data instanceof ArrayBuffer
            ? pixelFrame(event.data)
            : decodeDown(String(event.data));
        if (message.t === "pong") {
          const sentTs = pendingPings.get(message.id);
          if (sentTs !== undefined && sentTs === message.sentTs) {
            pendingPings.delete(message.id);
            options.onRttSample?.(Math.max(0, now() - message.sentTs));
          }
        }
        onDown(message);
      } catch (cause) {
        options.onProtocolError?.(
          cause instanceof Error ? cause : new Error("Down message decode failed", { cause }),
        );
      }
    };

    current.onclose = (event) => {
      if (current !== socket) return;
      socket = null;
      stopRtt();
      if (disposed) return;
      if (event?.code === VIEWER_REPLACED_CODE) {
        disposed = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        pending.length = 0;
        notify("replaced");
        return;
      }
      notify("closed");
      reconnectTimer = setTimeout(open, reconnectDelayMs);
    };
  };

  open();

  return {
    send(msg) {
      if (disposed) return;
      if (socket?.readyState === OPEN) socket.send(encodeMsg(msg));
      else pending.push(msg);
    },
    close() {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopRtt();
      socket?.close();
      socket = null;
      pending.length = 0;
    },
  };
}

function pixelFrame(buffer: ArrayBuffer): Down {
  const frame = decodePxBinary(buffer);
  if (frame === null) throw new Error("Down: unknown binary frame");
  return {
    t: "px",
    tab: frame.tab,
    w: frame.w,
    h: frame.h,
    data: new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
  };
}
