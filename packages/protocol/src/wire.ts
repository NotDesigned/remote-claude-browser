/**
 * Viewer <-> gateway wire protocol.
 *
 * Transport: one WebSocket per viewer per session, permessage-deflate on, JSON envelopes.
 * encodeMsg/decodeUp/decodeDown are the ONLY encode/decode choke points — if profiling ever
 * demands CBOR/msgpack, this module is the only place that changes. Don't pre-pay.
 *
 * ## seq semantics (D4, D10)
 * `seq` is per-tab and monotonic across `snapshot` and `delta` messages. The gateway assigns it;
 * the viewer treats any gap as divergence and MUST send `resync-req`, then discard all state for
 * that tab and rebuild from the next snapshot (tear down the Replayer + iframe entirely — never
 * reuse a Replayer instance across resyncs).
 *
 * ## epoch semantics (D4, D7)
 * `epoch` is gateway-assigned per tab. It bumps on: agent docId change (navigation), forced
 * snapshot (delta-buffer thresholds: >5000 events or >10MB), and viewport change. Every epoch
 * opens with a fresh `snapshot` message. Input gating (D7): the gateway DROPS input from any
 * viewer whose last `view-ack` epoch != the tab's current epoch — this single rule prevents
 * every "clicked on stale layout" bug.
 *
 * ## key-event rule (D3)
 * Everything keyboard goes as raw `key` down/up pairs, translated server-side through a vendored
 * US layout table into Input.dispatchKeyEvent. `text` (-> Input.insertText) is reserved for
 * exactly two producers: IME commit and paste. Local echo is a viewer-side prediction layer, not
 * a different server path.
 *
 * ## backpressure (D4)
 * If a viewer's ws.bufferedAmount > 8MB the gateway marks it stalled: stop deltas/px; when
 * drained below 1MB, send `resync` + current snapshot. Slow viewers cost O(1) memory.
 */
import type { eventWithTime } from "./rrweb";

/** A tab is identified by its CDP targetId. */
export type TabId = string;

/**
 * Modifier bitfield — CDP's encoding, used verbatim on the wire:
 * Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
 */
export const Mod = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const;
export type Mods = number;

export interface TabMeta {
  id: TabId;
  url: string;
  title: string;
  favicon?: string;
  active: boolean;
}

export interface PresenceEntry {
  id: string;
  name: string;
}

/** Pixel view detail, trading sharpness and frame rate for bandwidth. */
export type PxQuality = "low" | "medium" | "high";

export type SnapshotReason = "nav" | "viewport" | "trim" | "resync";

/** Gateway -> viewer. */
export interface ServerStatusMsg {
  t: "server-status";
  sampledAt: number;
  clientsOnline: number;
  clientsAllocated: number;
  clientsMax: number;
  pixelsActive: number;
  /** Null when pixel sessions have no separate global limit. */
  pixelsMax: number | null;
  cpuPercent: number | null;
  cpuCount: number;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  browserMemoryBytes: number | null;
}

export type Down =
  | ServerStatusMsg
  | {
      t: "hello";
      viewerId: string;
      role: "driver" | "viewer";
      sessionId: string;
      /** Gateway wall-clock reference for viewer clock-skew estimation. */
      serverTs?: number;
      /**
       * Tabs whose replay this connection continued from the viewer's resume cursor: the join
       * payload carries only the missed deltas and the viewer keeps its geometry and input.
       */
      resumed?: TabId[];
    }
  /** Application-level RTT echo; browser JS cannot observe WebSocket control-frame pong timing. */
  /** `sent` counts every byte the gateway wrote to this connection, after compression. */
  | { t: "pong"; id: number; sentTs: number; serverTs: number; sent?: number }
  | { t: "tabs"; tabs: TabMeta[] }
  | { t: "chrome"; tab: TabId; url: string; loading: boolean; canBack: boolean; canFwd: boolean }
  /** Renderer recovery is separate from gateway/WebSocket connectivity. */
  | { t: "tab-state"; tab: TabId; state: "recovering" | "ready" | "failed" }
  /** data = [Meta, FullSnapshot]; seq = the snapshot's seq; opens `epoch`. */
  | {
      t: "snapshot";
      tab: TabId;
      epoch: number;
      seq: number;
      data: eventWithTime[];
      /** Why this epoch was opened; optional during the additive H2 rollout. */
      reason?: SnapshotReason;
    }
  /** Batched <=30ms on the gateway. */
  | { t: "delta"; tab: TabId; epoch: number; seq: number; data: eventWithTime[] }
  /** Gateway-initiated: discard all state for the tab; a fresh snapshot follows. */
  | { t: "resync"; tab: TabId }
  | { t: "input-status"; tab: TabId; failed: boolean }
  | { t: "mode"; tab: TabId; mode: "dom" | "px" }
  /** Starts or restarts the pixel view's video stream; a keyframe follows. */
  | { t: "vid-cfg"; tab: TabId; codec: string; description: string }
  /** One H.264 frame, as a binary frame on the wire. `seq` reveals a dropped frame. */
  | {
      t: "vid";
      tab: TabId;
      seq: number;
      key: boolean;
      w: number;
      h: number;
      data: Uint8Array;
    }
  /** Frames per second at each stage on the gateway, for diagnosing a slow picture. */
  | { t: "px-stats"; tab: TabId; captureFps: number; encodeFps: number; dropFps: number }
  /** A stylesheet that following snapshots refer to by this hash (see sheets.ts). */
  | { t: "css"; hash: string; text: string }
  /** The requested geometry already matches the current snapshot; input may start. */
  | { t: "view-ok"; tab: TabId; w: number; h: number }
  /** A shared browser permits one pixel stream; no other workspace identity is exposed. */
  | { t: "px-capacity"; available: boolean }
  /**
   * Pixel-fallback frame, viewport-sized. Base64 JPEG inside the gateway; on the wire it travels
   * as a binary frame (see encodePxBinary), which the viewer decodes into a JPEG Blob.
   */
  | { t: "px"; tab: TabId; data: string | Blob; w: number; h: number; sharp?: boolean }
  /**
   * One agent -> viewer WebRTC signaling lane. `lane` identifies a single Replayer generation;
   * the gateway delivers it only to the authenticated viewer that opened that lane.
   */
  | { t: "rtc-sig"; tab: TabId; lane: string; from: "agent"; payload: unknown }
  | {
      t: "download";
      id: string;
      name: string;
      recv: number;
      total: number;
      state: "active" | "done" | "canceled";
      href?: string;
    }
  /** Authorizes one bounded HTTP upload batch for the intercepted remote file input. */
  | {
      t: "filepick";
      tab: TabId;
      key: string;
      multiple: boolean;
      maxFiles: number;
      maxFileBytes: number;
      maxTotalBytes: number;
    }
  /** Announces the current driver's viewerId. */
  | { t: "driver"; viewerId: string }
  | { t: "clip"; text: string }
  | { t: "presence"; viewers: PresenceEntry[] };

/** Viewer -> gateway. */
export type Up =
  /** Application-level RTT probe echoed immediately by the gateway. */
  | { t: "ping"; id: number; sentTs: number }
  /** Driver viewport in CSS px + DPR -> Emulation.setDeviceMetricsOverride (D7). */
  | { t: "view"; tab: TabId; w: number; h: number; dpr: number }
  /** Ack of the snapshot epoch produced by a viewport change; unlocks input per D7. */
  | { t: "view-ack"; tab: TabId; epoch: number }
  | {
      t: "ptr";
      tab: TabId;
      kind: "move" | "down" | "up" | "wheel";
      nodeId: number;
      /** Position within the node, [0,1]. */
      rx: number;
      ry: number;
      /** Viewport px fallback (and the primary coords in px mode). */
      vx: number;
      vy: number;
      button?: 0 | 1 | 2;
      buttons: number;
      mods: Mods;
      /** Wheel deltas. */
      dx?: number;
      dy?: number;
      clicks?: 1 | 2;
    }
  | { t: "key"; tab: TabId; kind: "down" | "up"; key: string; code: string; mods: Mods }
  /** IME commit + paste ONLY (D3/D5) -> Input.insertText. */
  | { t: "text"; tab: TabId; insert: string }
  /** Committed text or value-control state, including contenteditable text. */
  | {
      t: "value";
      tab: TabId;
      nodeId: number;
      value: string;
      /** False for a native editing event; omitted preserves legacy committed-change behavior. */
      commit?: boolean;
      /** Checkbox/radio committed state; when present, `value` is not applied. */
      checked?: boolean;
      /** Multiple-select committed option values; when present, `value` is not applied. */
      values?: string[];
      /** Preserve the local text-control selection when a value snapshot replaces selected text. */
      selectionStart?: number;
      selectionEnd?: number;
    }
  /** Composition in flight -> Input.imeSetComposition. */
  | { t: "ime"; tab: TabId; text: string; selStart: number; selEnd: number }
  /** <=10Hz per node; nodeId 0 = window scroll. */
  | { t: "scroll"; tab: TabId; nodeId: number; x: number; y: number }
  | {
      t: "nav";
      tab: TabId;
      action: "go" | "back" | "fwd" | "reload" | "newtab" | "close" | "activate";
      url?: string;
    }
  /** `video` says this browser can decode H.264 frames, which replace JPEG frames. */
  | { t: "mode"; tab: TabId; mode: "dom" | "px"; quality?: PxQuality; video?: boolean }
  /** The video decoder lost its place and needs a new stream from a keyframe. */
  | { t: "vid-key"; tab: TabId }
  /**
   * The viewer received one `px` frame. The gateway keeps at most a couple of frames in flight
   * per viewer and replaces any newer waiting frame, so slow links show the latest picture
   * instead of a growing queue hidden in proxy and TCP buffers.
   */
  | { t: "px-ack"; tab: TabId }
  | { t: "resync-req"; tab: TabId; reason: string }
  | { t: "driver-transfer"; to: string }
  /**
   * Viewer -> agent WebRTC signaling. The gateway attaches the authenticated viewer identity;
   * clients must never put a viewer id on this envelope.
   */
  | { t: "rtc-sig"; tab: TabId; lane: string; payload: unknown }
  | { t: "clip"; text: string };

const DOWN_TAGS: ReadonlySet<string> = new Set([
  "hello",
  "pong",
  "tabs",
  "chrome",
  "tab-state",
  "snapshot",
  "delta",
  "resync",
  "input-status",
  "mode",
  "px-capacity",
  "server-status",
  "view-ok",
  "css",
  "vid-cfg",
  "px-stats",
  "px",
  "rtc-sig",
  "download",
  "filepick",
  "driver",
  "clip",
  "presence",
]);

const UP_TAGS: ReadonlySet<string> = new Set([
  "ping",
  "view",
  "view-ack",
  "ptr",
  "key",
  "text",
  "value",
  "ime",
  "scroll",
  "nav",
  "mode",
  "px-ack",
  "vid-key",
  "resync-req",
  "driver-transfer",
  "rtc-sig",
  "clip",
]);

/** Single serialization choke point (future CBOR switch lives here). */
export function encodeMsg(msg: Down | Up): string {
  return JSON.stringify(msg);
}

function decode(raw: string, tags: ReadonlySet<string>, dir: string): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`${dir}: not JSON`);
  }
  if (typeof obj !== "object" || obj === null || typeof (obj as { t?: unknown }).t !== "string") {
    throw new Error(`${dir}: missing tag`);
  }
  const t = (obj as { t: string }).t;
  if (!tags.has(t)) throw new Error(`${dir}: unknown tag "${t}"`);
  return obj;
}

/** Viewer side: decode a gateway message. Throws on unknown/garbled input. */
export function decodeDown(raw: string): Down {
  return decode(raw, DOWN_TAGS, "Down") as Down;
}

/** Gateway side: decode a viewer message. Throws on unknown/garbled input. */
export function decodeUp(raw: string): Up {
  return decode(raw, UP_TAGS, "Up") as Up;
}

/** Where a viewer's replay stands for one tab: the next sequence number it expects. */
export interface ResumeCursor {
  tab: TabId;
  epoch: number;
  nextSeq: number;
}

const MAX_RESUME_CURSORS = 8;
const MAX_RESUME_PARAM_LENGTH = 2048;

/** WebSocket URL parameter carrying resume cursors across a reconnect. */
export function encodeResumeCursors(cursors: readonly ResumeCursor[]): string {
  return JSON.stringify(
    cursors
      .slice(0, MAX_RESUME_CURSORS)
      .map((cursor) => [cursor.tab, cursor.epoch, cursor.nextSeq]),
  );
}

/** Untrusted input: anything malformed simply means "no resume". */
export function decodeResumeCursors(raw: string | null | undefined): ResumeCursor[] {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RESUME_PARAM_LENGTH)
    return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cursors: ResumeCursor[] = [];
  for (const entry of parsed.slice(0, MAX_RESUME_CURSORS)) {
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const [tab, epoch, nextSeq] = entry as unknown[];
    if (
      typeof tab === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(tab) &&
      Number.isSafeInteger(epoch) &&
      Number.isSafeInteger(nextSeq) &&
      (epoch as number) >= 0 &&
      (nextSeq as number) >= 0
    )
      cursors.push({ tab, epoch: epoch as number, nextSeq: nextSeq as number });
  }
  return cursors;
}

/**
 * Binary pixel frames skip base64 (+33 %) and a pointless deflate pass over JPEG bytes:
 * [0x50 'P'][version 1][tab length u16][tab UTF-8][width u16][height u16][JPEG bytes].
 */
const VID_BINARY_MAGIC = 0x56;
const VID_BINARY_VERSION = 1;

export function encodeVidBinary(message: Extract<Down, { t: "vid" }>): Uint8Array {
  const tabBytes = new TextEncoder().encode(message.tab);
  if (tabBytes.length > 0xffff) throw new RangeError("tab id too long");
  const frame = new Uint8Array(4 + tabBytes.length + 9 + message.data.length);
  const view = new DataView(frame.buffer);
  frame[0] = VID_BINARY_MAGIC;
  frame[1] = VID_BINARY_VERSION;
  view.setUint16(2, tabBytes.length);
  frame.set(tabBytes, 4);
  const at = 4 + tabBytes.length;
  view.setUint16(at, Math.max(0, Math.min(0xffff, Math.round(message.w))));
  view.setUint16(at + 2, Math.max(0, Math.min(0xffff, Math.round(message.h))));
  view.setUint32(at + 4, message.seq);
  frame[at + 8] = message.key ? 1 : 0;
  frame.set(message.data, at + 9);
  return frame;
}

/** Returns null for anything that is not a well-formed binary video frame. */
export function decodeVidBinary(
  buffer: ArrayBuffer | Uint8Array,
): Extract<Down, { t: "vid" }> | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== VID_BINARY_MAGIC || bytes[1] !== VID_BINARY_VERSION)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tabLength = view.getUint16(2);
  const at = 4 + tabLength;
  if (bytes.length < at + 9) return null;
  return {
    t: "vid",
    tab: new TextDecoder().decode(bytes.subarray(4, at)),
    w: view.getUint16(at),
    h: view.getUint16(at + 2),
    seq: view.getUint32(at + 4),
    key: bytes[at + 8] === 1,
    data: bytes.subarray(at + 9),
  };
}

const PX_BINARY_MAGIC = 0x50;
const PX_BINARY_VERSION = 1;

export function encodePxBinary(tab: TabId, w: number, h: number, jpeg: Uint8Array): Uint8Array {
  const tabBytes = new TextEncoder().encode(tab);
  if (tabBytes.length > 0xffff) throw new RangeError("tab id too long");
  const frame = new Uint8Array(2 + 2 + tabBytes.length + 4 + jpeg.length);
  const view = new DataView(frame.buffer);
  frame[0] = PX_BINARY_MAGIC;
  frame[1] = PX_BINARY_VERSION;
  view.setUint16(2, tabBytes.length);
  frame.set(tabBytes, 4);
  const at = 4 + tabBytes.length;
  view.setUint16(at, Math.max(0, Math.min(0xffff, Math.round(w))));
  view.setUint16(at + 2, Math.max(0, Math.min(0xffff, Math.round(h))));
  frame.set(jpeg, at + 4);
  return frame;
}

/** Returns null for anything that is not a well-formed binary pixel frame. */
export function decodePxBinary(
  buffer: ArrayBuffer | Uint8Array,
): { tab: TabId; w: number; h: number; jpeg: Uint8Array } | null {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8 || bytes[0] !== PX_BINARY_MAGIC || bytes[1] !== PX_BINARY_VERSION)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tabLength = view.getUint16(2);
  const at = 4 + tabLength;
  if (bytes.length < at + 4) return null;
  const tab = new TextDecoder().decode(bytes.subarray(4, at));
  return { tab, w: view.getUint16(at), h: view.getUint16(at + 2), jpeg: bytes.subarray(at + 4) };
}
