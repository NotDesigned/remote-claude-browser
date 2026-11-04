/**
 * Per-viewer connection and backpressure handling.
 *
 * Backpressure rule (unit-test with a mock socket): if ws.bufferedAmount > STALL_BYTES, mark
 * the viewer stalled (stop deltas/px); when it drains below RESUME_BYTES, send `resync` +
 * current snapshot. Check bufferedAmount BEFORE send, not after. Slow viewers cost O(1) memory
 * and never affect other viewers. The rule applies to px frames too (P2-PX): drop, never queue.
 */
import { encodeWithInlineSheets, sheetsOf } from "../hub/snapshot-sheets";
import { encodeMsg, type Down, type TabId } from "@mirror/protocol";

export const STALL_BYTES = 8 * 1024 * 1024;
export const RESUME_BYTES = 1 * 1024 * 1024;
/** Unacknowledged pixel frames allowed per tab; newer frames replace a single waiting one. */
export const PX_MAX_IN_FLIGHT = 2;
/** Without acknowledgements (lost ack, old viewer) resume sending after this long. */
export const PX_ACK_TIMEOUT_MS = 2_000;
const WS_OPEN = 1;

export interface ViewerSocket {
  readonly readyState: number;
  bufferedAmount: number;
  /** Binary frames (pixels) are already compressed JPEG; `compress: false` skips deflate. */
  send(data: string | Uint8Array, options?: { compress?: boolean; binary?: boolean }): void;
}

export interface ViewerConnOpts {
  drainPollMs?: number;
  pxAckTimeoutMs?: number;
  now?: () => number;
  /** Stylesheet hashes this client already holds; undefined when it wants them inline. */
  knownSheets?: Iterable<string>;
}

type PxMsg = Extract<Down, { t: "px" }>;
type SnapshotDown = Extract<Down, { t: "snapshot" }>;
/** JSON text, or a binary pixel frame. */
export type Serialized = string | Uint8Array;

interface PxFlow {
  inFlight: number;
  lastSentAt: number;
  waiting?: { msg: PxMsg; serialized: Serialized };
  timer?: NodeJS.Timeout;
}

interface ReplayCursor {
  epoch: number;
  nextSeq: number;
}

export class ViewerConn {
  private readonly cursors = new Map<TabId, ReplayCursor>();
  private readonly drainPollMs: number;
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly knownSheets: Set<string> | undefined;
  private stalled = false;
  private disposed = false;
  private beforeResync: (() => void) | undefined;
  private readonly pxFlows = new Map<TabId, PxFlow>();
  private readonly pxAckTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    readonly socket: ViewerSocket,
    private readonly getJoinPayload: () => Down[],
    opts: ViewerConnOpts = {},
  ) {
    this.drainPollMs = opts.drainPollMs ?? 30;
    if (!Number.isSafeInteger(this.drainPollMs) || this.drainPollMs < 1) {
      throw new RangeError("drainPollMs must be a positive safe integer");
    }
    this.pxAckTimeoutMs = opts.pxAckTimeoutMs ?? PX_ACK_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.knownSheets = opts.knownSheets ? new Set(opts.knownSheets) : undefined;
  }

  get isStalled(): boolean {
    return this.stalled;
  }

  /** Fanout installs this to end any in-flight batch before a drain recovery snapshots state. */
  setBeforeResync(cb: (() => void) | undefined): void {
    this.beforeResync = cb;
  }

  /** Send a message already serialized once by the fan-out broadcaster. */
  send(msg: Down, serialized: Serialized): boolean {
    if (!this.isOpen()) return false;
    if (msg.t === "delta" && this.wasAlreadyReplayed(msg)) return false;

    if (isDroppable(msg) && this.socket.bufferedAmount > STALL_BYTES) {
      this.markStalled();
      return false;
    }
    if (this.stalled && isDroppable(msg)) return false;
    if (msg.t === "px") return this.sendPx(msg, serialized);
    if (msg.t === "mode" || msg.t === "resync") this.resetPx(msg.tab);

    this.write(msg.t === "snapshot" ? this.snapshotFrame(msg, serialized) : serialized);
    this.advanceCursor(msg);
    return true;
  }

  /** Sends the stylesheets this client lacks, then returns the snapshot frame that refers to them. */
  private snapshotFrame(msg: SnapshotDown, serialized?: Serialized): Serialized {
    const sheets = sheetsOf(msg);
    if (!sheets) return serialized ?? encodeMsg(msg);
    if (!this.knownSheets) return encodeWithInlineSheets(msg);
    for (const [hash, text] of sheets) {
      if (this.knownSheets.has(hash)) continue;
      this.knownSheets.add(hash);
      this.write(encodeMsg({ t: "css", hash, text }));
    }
    return serialized ?? encodeMsg(msg);
  }

  /** Initial join and drain recovery share the hub's canonical resync path. */
  sendJoinPayload(): void {
    if (!this.isOpen()) return;
    for (const msg of this.getJoinPayload()) {
      this.socket.send(msg.t === "snapshot" ? this.snapshotFrame(msg) : encodeMsg(msg));
      this.advanceCursor(msg);
    }
  }

  /** The viewer received a pixel frame for `tab`; release one slot and send the newest waiting. */
  ackPx(tab: TabId): void {
    const flow = this.pxFlows.get(tab);
    if (flow === undefined) return;
    flow.inFlight = Math.max(0, flow.inFlight - 1);
    this.flushPx(tab, flow);
  }

  dispose(): void {
    this.disposed = true;
    for (const tab of [...this.pxFlows.keys()]) this.resetPx(tab);
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private sendPx(msg: PxMsg, serialized: Serialized): boolean {
    let flow = this.pxFlows.get(msg.tab);
    if (flow === undefined) {
      flow = { inFlight: 0, lastSentAt: 0 };
      this.pxFlows.set(msg.tab, flow);
    }
    if (this.pxSlotAvailable(flow)) {
      this.writePx(flow, serialized);
      return true;
    }
    // Only the newest picture matters; replace any frame that is still waiting.
    flow.waiting = { msg, serialized };
    this.schedulePxTimeout(msg.tab, flow);
    return false;
  }

  private pxSlotAvailable(flow: PxFlow): boolean {
    if (flow.inFlight < PX_MAX_IN_FLIGHT) return true;
    if (this.now() - flow.lastSentAt < this.pxAckTimeoutMs) return false;
    flow.inFlight = 0;
    return true;
  }

  private writePx(flow: PxFlow, serialized: Serialized): void {
    flow.inFlight++;
    flow.lastSentAt = this.now();
    this.write(serialized);
  }

  private flushPx(tab: TabId, flow: PxFlow): void {
    if (flow.waiting === undefined || !this.isOpen()) return;
    if (this.stalled) {
      flow.waiting = undefined;
      return;
    }
    if (!this.pxSlotAvailable(flow)) {
      this.schedulePxTimeout(tab, flow);
      return;
    }
    const { serialized } = flow.waiting;
    flow.waiting = undefined;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    flow.timer = undefined;
    this.writePx(flow, serialized);
  }

  /** A static page produces no further frames, so a waiting frame must not wait for one. */
  private schedulePxTimeout(tab: TabId, flow: PxFlow): void {
    if (flow.timer !== undefined || this.disposed) return;
    const delay = Math.max(1, flow.lastSentAt + this.pxAckTimeoutMs - this.now());
    flow.timer = setTimeout(() => {
      flow.timer = undefined;
      if (this.pxFlows.get(tab) === flow) this.flushPx(tab, flow);
    }, delay);
    flow.timer.unref?.();
  }

  private resetPx(tab: TabId): void {
    const flow = this.pxFlows.get(tab);
    if (flow?.timer !== undefined) clearTimeout(flow.timer);
    this.pxFlows.delete(tab);
  }

  private write(serialized: Serialized): void {
    if (typeof serialized === "string") this.socket.send(serialized);
    else this.socket.send(serialized, { compress: false, binary: true });
  }

  private markStalled(): void {
    if (this.stalled) return;
    this.stalled = true;
    this.scheduleDrainCheck();
  }

  private scheduleDrainCheck(): void {
    if (this.disposed || this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (!this.isOpen()) return;
      if (this.socket.bufferedAmount >= RESUME_BYTES) {
        this.scheduleDrainCheck();
        return;
      }

      // Keep `stalled` true during the flush: this connection drops the pending tail while its
      // healthy peers receive it, then gets that same tail exactly once from joinPayload().
      this.beforeResync?.();
      this.stalled = false;
      this.sendJoinPayload();
    }, this.drainPollMs);
    this.drainTimer.unref();
  }

  private wasAlreadyReplayed(msg: Extract<Down, { t: "delta" }>): boolean {
    const cursor = this.cursors.get(msg.tab);
    return (
      cursor !== undefined &&
      cursor.epoch === msg.epoch &&
      msg.seq + msg.data.length <= cursor.nextSeq
    );
  }

  private advanceCursor(msg: Down): void {
    if (msg.t === "snapshot") {
      this.cursors.set(msg.tab, { epoch: msg.epoch, nextSeq: msg.seq + 1 });
    } else if (msg.t === "delta") {
      this.cursors.set(msg.tab, {
        epoch: msg.epoch,
        nextSeq: msg.seq + msg.data.length,
      });
    } else if (msg.t === "resync") {
      this.cursors.delete(msg.tab);
    }
  }

  private isOpen(): boolean {
    return !this.disposed && this.socket.readyState === WS_OPEN;
  }
}

function isDroppable(msg: Down): boolean {
  return msg.t === "delta" || msg.t === "px";
}
