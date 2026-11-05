/**
 * Reconnecting typed WebSocket client.
 *
 * There is deliberately no resume cursor: a reconnect asks the mirror to discard its local
 * state and the gateway supplies a fresh snapshot (D10).
 */
import {
  MAX_KNOWN_SHEETS,
  decodeDown,
  decodePxBinary,
  decodeVidBinary,
  encodeMsg,
  resolveSheetRefs,
  type Down,
  type Up,
} from "@mirror/protocol";
import { forgetAllSheets, forgetSheet, loadStoredSheets, storeSheet } from "./sheet-store";

/** Stylesheets received on this page, kept across reconnects and view switches. */
const knownSheets = new Map<string, string>();
/** Read once per page, before its first connection offers what it holds. */
let storedSheets: Promise<void> | null | undefined;
function readStoredSheets(): Promise<void> | null {
  if (storedSheets !== undefined) return storedSheets;
  storedSheets =
    loadStoredSheets()?.then((sheets) => {
      for (const [hash, text] of sheets) {
        if (knownSheets.size < MAX_KNOWN_SHEETS && !knownSheets.has(hash))
          knownSheets.set(hash, text);
        else if (!knownSheets.has(hash)) forgetSheet(hash);
      }
    }) ?? null;
  return storedSheets;
}
function rememberSheet(hash: string, text: string): void {
  knownSheets.delete(hash);
  knownSheets.set(hash, text);
  storeSheet(hash, text);
  if (knownSheets.size > MAX_KNOWN_SHEETS) {
    const oldest = knownSheets.keys().next().value!;
    knownSheets.delete(oldest);
    forgetSheet(oldest);
  }
}

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
  /** Download speed since the previous ping, measured on the wire by the gateway. */
  onSpeedSample?(bytesPerSecond: number): void;
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
  let lastSent: { bytes: number; at: number } | null = null;
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
    socketUrl.searchParams.set("sheets", [...knownSheets.keys()].join(","));
    lastSent = null;
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
        if (message.t === "css") {
          rememberSheet(message.hash, message.text);
          return;
        }
        if (message.t === "snapshot") {
          const data = resolveSheetRefs(message.data, (hash) => knownSheets.get(hash));
          if (data === null) {
            // This page lost a sheet the gateway believes it has; start over without any.
            knownSheets.clear();
            forgetAllSheets();
            current.close();
            return;
          }
          message.data = data;
        }
        if (message.t === "pong") {
          const sentTs = pendingPings.get(message.id);
          if (sentTs !== undefined && sentTs === message.sentTs) {
            pendingPings.delete(message.id);
            options.onRttSample?.(Math.max(0, now() - message.sentTs));
            if (typeof message.sent === "number") {
              const previous = lastSent;
              lastSent = { bytes: message.sent, at: message.serverTs };
              const elapsedMs = previous ? message.serverTs - previous.at : 0;
              if (previous && elapsedMs > 0 && message.sent >= previous.bytes)
                options.onSpeedSample?.(((message.sent - previous.bytes) * 1000) / elapsedMs);
            }
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

  const stored = readStoredSheets();
  if (stored === null) open();
  else void stored.then(open, open);

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
  const video = decodeVidBinary(buffer);
  if (video !== null) return video;
  const frame = decodePxBinary(buffer);
  if (frame === null) throw new Error("Down: unknown binary frame");
  // Moving pictures are JPEG; a still page gets a PNG or WebP that is sharper for text.
  const sharp = frame.jpeg[0] !== 0xff;
  const type = !sharp ? "image/jpeg" : frame.jpeg[0] === 0x89 ? "image/png" : "image/webp";
  return {
    t: "px",
    tab: frame.tab,
    w: frame.w,
    h: frame.h,
    sharp,
    data: new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type }),
  };
}
