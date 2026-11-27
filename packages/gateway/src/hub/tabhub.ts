/**
 * Per-tab EventHub. This remains pure logic, with no CDP or WebSocket imports, so synthetic
 * rrweb streams can exercise it in unit tests.
 *
 * With the live tree (MIRROR_LIVE_TREE, live-tree/), the hub keeps the tab's current DOM, applied
 * event by event, and a bounded tail of recent deltas (the ring). A join, reconnect, tab switch or
 * one viewer's recovery is answered from the current state: the tail when the viewer's cursor is
 * still in the ring, otherwise a FullSnapshot synthesized from the tree, an ordinary rrweb
 * snapshot at `seq` in the current epoch. The page is asked for a snapshot only for a new
 * document, a viewport change, a lost stream, or when the tree is known to be broken (or, with
 * MIRROR_LIVE_TREE_VERIFY, to check it); never because a buffer filled up.
 *
 * Without it (the legacy store): latest [Meta, FullSnapshot] + ordered delta buffer since it.
 * Reset triggers: deltas.length > 5000 || deltaBytes > 4MB || new docId || viewport change
 * -> fire needSnapshot -> on arrival: new epoch, clear buffer, broadcast fresh snapshot. A
 * document whose tree cannot be kept (too large, too slow, broken twice) uses it too.
 *
 * Epochs come from one process-wide allocator that starts at a random point. A tab whose CDP
 * session is replaced gets a new hub; its epochs must never repeat an old hub's, or a viewer's
 * resume cursor or replay state from the old document would be taken as current. An epoch is a
 * document, as the page last gave it whole: synthesized catch-ups stay in the current epoch.
 *
 * Gotchas: Meta (EventType.Meta) precedes FullSnapshot (EventType.FullSnapshot) — keep BOTH or
 * the replayer sizes the iframe wrong. Count deltaBytes on the serialized JSON actually sent.
 * Events are immutable once ingested: the fan-out may still be batching them.
 */
import { externalizeSheets } from "./snapshot-sheets";
import {
  encodeMsg,
  EventType,
  IncrementalSource,
  type AgentMsg,
  type Down,
  type EditState,
  type eventWithTime,
  type SnapshotReason,
  type TabId,
} from "@mirror/protocol";
import { sharedTreeBudget, type BudgetMember, type TreeBudget } from "./live-tree/budget";
import { LiveTree, significantMismatches, TreeBroken } from "./live-tree/live-tree";
import {
  logTree,
  noteAnomalies,
  noteFallback,
  notePageSnapshot,
  noteTreeBroken,
  pageSyncMetrics,
  type PageSnapshotCause,
  type TabTreeGauge,
} from "./live-tree/metrics";
import { forgetSynthesized, subtreeEvents, synthesize } from "./live-tree/synthesize";

/**
 * A fence the page answered: everything it reported before the fence is in this hub's stream up
 * to `seq` of `epoch`. `text` is the submit guard's and never leaves the gateway.
 */
export interface FenceResult {
  n: number;
  epoch: number;
  seq: number;
  edit: EditState | null;
  text?: string;
}

/** Fences answered before anyone waited for them, kept this many deep. */
const FENCE_MEMORY = 32;
/**
 * Submit-guard texts not yet taken, kept this many deep: each is handed out once, by whenFenced,
 * and is never kept with the fence it came with.
 */
const FENCE_TEXT_MEMORY = 4;

/**
 * P2-REWRITE hook (assets domain). The assets domain implements this in ../assets/rewrite.ts
 * and integration wires it in main.ts — the hub calls it on every buffered event and NEVER
 * needs editing for it. Identity until then.
 */

export type RewriteStage = (
  e: eventWithTime,
  ctx: { sessionId: string; tabId: TabId },
) => eventWithTime;

export const identityRewrite: RewriteStage = (e) => e;

/** The live tree's limits for one hub (live-tree/config.ts has the process's). */
export interface LiveTreeOptions {
  ringEvents: number;
  ringBytes: number;
  maxNodes: number;
  maxBytes: number;
  maxSidecar: number;
  verify: boolean;
  /** The process-wide budget; one of totalMaxBytes is made when absent. */
  budget?: TreeBudget;
  totalMaxBytes?: number;
  /** VERIFY: how long a tab must be quiet, and how long between two checks. */
  verifyIdleMs?: number;
  verifyIntervalMs?: number;
  /** VERIFY: changes since the last check before another is worth it. */
  verifyAfterMutations?: number;
}

export interface TabHubOpts {
  sessionId: string;
  tabId: TabId;
  maxDeltaEvents?: number; // default 5000
  maxDeltaBytes?: number; // default 4MB
  snapshotRequestTimeoutMs?: number; // default 5000
  snapshotRetryMs?: number; // default 250; nav/resync retry base
  snapshotRetryMaxMs?: number; // default 5000; bounded exponential backoff
  now?: () => number; // default Date.now
  rewrite?: RewriteStage; // default identityRewrite
  /** Allocates each new epoch; default is the process-wide allocator (tests pass their own). */
  nextEpoch?: () => number;
  /** The live tree; false or absent keeps the legacy store. */
  liveTree?: LiveTreeOptions | false;
}

/** Random start, so that a restarted gateway does not reissue the epochs it gave before. */
let lastEpoch = Math.floor(Math.random() * 2 ** 40);

/** Strictly increasing across every hub in this process. */
export function allocateEpoch(): number {
  lastEpoch += 1;
  return lastEpoch;
}

export type NeedSnapshotListener = (reason: SnapshotReason) => unknown;

/**
 * What the live tree of the current document is doing:
 *  - none: no snapshot of this document yet;
 *  - live: the tree is current;
 *  - broken: it failed; a page snapshot was asked for, and deltas still flow;
 *  - dormant: let go for memory; the next viewer that needs the tab gets a page snapshot;
 *  - legacy: this document uses the legacy store (too large, too slow, broken twice).
 */
export type TreeState = "off" | "none" | "live" | "broken" | "dormant" | "legacy";

interface RingEntry {
  seq: number;
  event: eventWithTime;
  bytes: number;
}

/** A page snapshot the gateway asked for to check its tree, waiting for its frame documents. */
interface PendingVerify {
  meta: eventWithTime;
  full: eventWithTime;
  checkout: eventWithTime[];
  timer: ReturnType<typeof setTimeout>;
}

/** Two breaks of one document within this long: it keeps the legacy store. */
const REPEAT_BREAK_MS = 10 * 60_000;
/** Apply time per second past which a second counts as hot, and hot seconds in a row to give up. */
const CPU_HOT_MS_PER_S = 200;
const CPU_HOT_SECONDS = 5;
/** Events between two looks at the process-wide budget. */
const BUDGET_EVERY = 256;
/** How long a verify snapshot waits for its frame documents before it is compared. */
const VERIFY_SETTLE_MS = 600;

export class TabHub implements BudgetMember {
  readonly tabId: TabId;
  /**
   * Gateway-assigned; a new one on: new docId, forced snapshot, viewport change (D4/D7). Unique
   * across hubs, so it also identifies this hub; 0 until the first snapshot.
   */
  epoch = 0;
  /** Current agent docId (per-document epoch from the page). */
  docId = 0;
  seq = 0;
  meta: eventWithTime | null = null;
  snapshot: eventWithTime | null = null;
  deltas: eventWithTime[] = [];
  /** How long the page took to deliver the latest snapshot asked for; null if nobody asked. */
  lastSnapshotMs: number | null = null;
  private snapshotRequestedAt: number | null = null;
  deltaBytes = 0;
  lastInputAt = Number.NEGATIVE_INFINITY;
  mode: "dom" | "px" = "dom";
  viewport: { w: number; h: number; dpr: number } | null = null;

  private readonly sessionId: string;
  private readonly maxDeltaEvents: number;
  private readonly maxDeltaBytes: number;
  private readonly snapshotRequestTimeoutMs: number;
  private readonly snapshotRetryMs: number;
  private readonly snapshotRetryMaxMs: number;
  private readonly now: () => number;
  private readonly rewrite: RewriteStage;
  private readonly nextEpoch: () => number;
  private readonly needSnapshotListeners = new Set<NeedSnapshotListener>();
  private readonly downListeners = new Set<(down: Down) => void>();
  private hasDocument = false;
  /** Browser zoom the pixel view is using; the page sees the same geometry either way. */
  pixelZoom = 1;
  /** The pixel view reads the page off the display, where only browser zoom can add density. */
  pixelGrabbing = false;
  private snapshotRequested = false;
  private snapshotRequestAttempt = 0;
  private snapshotRequestTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotRetryDelayMs: number;
  /**
   * The buffer overflowed, so nothing here can bring a new viewer up to date. Connected viewers
   * are fine as they are, so a new snapshot waits until someone actually needs one.
   */
  private historyDropped = false;
  private lastActivity = 0;
  private pendingSnapshotReason: SnapshotReason | null = null;
  private queuedSnapshotReason: SnapshotReason | null = null;
  private snapshotSeq = 0;
  private nextMeta: eventWithTime | null = null;
  private pendingFullSnapshot: eventWithTime | null = null;
  private disposed = false;
  private readonly fenceListeners = new Set<(fence: FenceResult) => void>();
  /** Recent fences by number, oldest first. */
  private readonly fences = new Map<number, FenceResult>();
  /** The submit guard's text of recent fences, until whenFenced hands it out. */
  private readonly fenceTexts = new Map<number, string>();

  // ---- live tree ----
  private readonly treeOpts: LiveTreeOptions | null;
  private readonly budget: TreeBudget | null;
  private tree: LiveTree | null = null;
  treeState: TreeState;
  private ring: RingEntry[] = [];
  private ringHead = 0;
  private ringBytes = 0;
  /** The seq of the oldest event the ring holds (seq + 1 when it holds none). */
  private ringStartSeq = 1;
  /** A document that uses the legacy store. */
  private legacyDocId: number | null = null;
  private breaks: number[] = [];
  /** Why the snapshot being asked for is wanted, for the metrics. */
  private snapshotCause: PageSnapshotCause | null = null;
  private pendingVerify: PendingVerify | null = null;
  private mutationsSinceVerify = 0;
  private lastVerifyAt = Number.NEGATIVE_INFINITY;
  private verifyTimer: ReturnType<typeof setTimeout> | undefined;
  private recompactAsked = false;
  private eventsSinceBudget = 0;
  private cpuSecond = 0;
  private cpuSecondMs = 0;
  private cpuHotSeconds = 0;
  /** Which of the tree's anomalies were already counted process-wide. */
  private anomaliesCounted: Record<string, number> = {};
  /** Shown by a session right now (budget: background tabs go dormant first). */
  private foreground = true;
  lastViewedAt = 0;

  constructor(opts: TabHubOpts) {
    assertLimit("maxDeltaEvents", opts.maxDeltaEvents);
    assertLimit("maxDeltaBytes", opts.maxDeltaBytes);
    assertPositiveLimit("snapshotRequestTimeoutMs", opts.snapshotRequestTimeoutMs);
    assertPositiveLimit("snapshotRetryMs", opts.snapshotRetryMs);
    assertPositiveLimit("snapshotRetryMaxMs", opts.snapshotRetryMaxMs);

    this.sessionId = opts.sessionId;
    this.tabId = opts.tabId;
    this.maxDeltaEvents = opts.maxDeltaEvents ?? 5_000;
    this.maxDeltaBytes = opts.maxDeltaBytes ?? 4 * 1024 * 1024;
    this.snapshotRequestTimeoutMs = opts.snapshotRequestTimeoutMs ?? 5_000;
    this.snapshotRetryMs = opts.snapshotRetryMs ?? 250;
    this.snapshotRetryMaxMs = opts.snapshotRetryMaxMs ?? 5_000;
    if (this.snapshotRetryMaxMs < this.snapshotRetryMs) {
      throw new RangeError("snapshotRetryMaxMs must be greater than or equal to snapshotRetryMs");
    }
    this.snapshotRetryDelayMs = this.snapshotRetryMs;
    this.now = opts.now ?? Date.now;
    this.rewrite = opts.rewrite ?? identityRewrite;
    this.nextEpoch = opts.nextEpoch ?? allocateEpoch;
    const tree = opts.liveTree;
    if (tree) {
      for (const name of ["ringEvents", "ringBytes", "maxNodes", "maxBytes", "maxSidecar"] as const)
        assertPositiveLimit(name, tree[name]);
      this.treeOpts = tree;
      this.budget = tree.budget ?? sharedTreeBudget(tree.totalMaxBytes ?? 256 * 1024 * 1024);
      this.budget.register(this);
      this.treeState = "none";
    } else {
      this.treeOpts = null;
      this.budget = null;
      this.treeState = "off";
    }
    this.lastViewedAt = this.now();
  }

  /** Whether the current document is served from a live tree (not the legacy store). */
  private get usesTree(): boolean {
    return this.treeOpts !== null && this.legacyDocId !== this.docId;
  }

  /**
   * Ingest one AgentMsg; returns the Down messages to broadcast (0..n).
   * Stale-docId events never reach here (AgentLink drops them), but a `hello` with a new docId
   * closes the old epoch.
   */
  ingest(msg: AgentMsg): Down[] {
    this.lastActivity = this.now();
    if (msg.kind === "cmdres") return [];

    if (msg.kind === "hello") {
      // Only a top-level recorder owns a tab's canonical stream (D2).
      if (!msg.isTop) return [];
      if (this.hasDocument && msg.docId === this.docId) return [];

      // A viewport agreement in progress still needs its snapshot from the new document.
      const owesViewport =
        this.pendingSnapshotReason === "viewport" || this.queuedSnapshotReason === "viewport";
      this.invalidateDocument();
      this.docId = msg.docId;
      this.hasDocument = true;
      this.requestSnapshot("nav");
      if (owesViewport) this.queuedSnapshotReason = "viewport";
      return [];
    }

    // AgentLink normally enforces this boundary. Keeping it here too makes the pure hub safe
    // under navigation races and synthetic stream tests.
    if (!this.hasDocument || msg.docId !== this.docId) return [];

    // A fence marks a place in the stream for the input relay; viewers never see it, and it is
    // not part of the page, so it is never buffered.
    if (msg.kind === "fence") {
      const fence: FenceResult = { n: msg.n, epoch: this.epoch, seq: this.seq, edit: msg.edit };
      this.fences.delete(fence.n);
      this.fences.set(fence.n, fence);
      if (this.fences.size > FENCE_MEMORY) this.fences.delete(this.fences.keys().next().value!);
      this.fenceTexts.delete(fence.n);
      if (typeof msg.text === "string") {
        this.fenceTexts.set(fence.n, msg.text);
        if (this.fenceTexts.size > FENCE_TEXT_MEMORY)
          this.fenceTexts.delete(this.fenceTexts.keys().next().value!);
      }
      for (const listener of [...this.fenceListeners]) listener(fence);
      return [];
    }

    const event = this.rewrite(msg.e, { sessionId: this.sessionId, tabId: this.tabId });

    if (event.type === EventType.Meta) {
      this.nextMeta = event;
      if (this.snapshot === null && !this.usesTree) this.meta = event;
      return this.openPendingSnapshot();
    }

    if (event.type === EventType.FullSnapshot) {
      this.pendingFullSnapshot = event;
      return this.openPendingSnapshot();
    }

    // No delta can be replayed safely until its document has a complete snapshot pair.
    if (!this.streaming) return [];

    const out: Down[] = [];
    // A verify snapshot's checkout (frame documents, adopted sheets) is over: compare now.
    if (this.pendingVerify !== null && !isCheckoutEvent(event)) out.push(...this.decideVerify());

    const seq = ++this.seq;
    const down: Down = {
      t: "delta",
      tab: this.tabId,
      epoch: this.epoch,
      seq,
      data: [event],
    };
    const bytes = utf8JsonBytes(down);

    if (this.usesTree) {
      if (this.treeState !== "dormant") this.pushRing({ seq, event, bytes });
      if (this.pendingVerify !== null) this.pendingVerify.checkout.push(event);
      if (this.treeState === "live") this.applyToTree(event);
      out.push(down);
      return out;
    }

    this.deltas.push(event);
    this.deltaBytes += bytes;
    if (this.deltas.length > this.maxDeltaEvents || this.deltaBytes > this.maxDeltaBytes) {
      this.historyDropped = true;
      this.snapshot = null;
      this.deltas = [];
      this.deltaBytes = 0;
      // A viewer that lost only what comes after this point can still resume.
      this.snapshotSeq = this.seq;
    }
    out.push(down);
    return out;
  }

  /** Deltas flow once the document's first snapshot opened its epoch. */
  private get streaming(): boolean {
    if (this.usesTree) return this.epoch !== 0 && this.epochDocId === this.docId;
    return (this.meta !== null && this.snapshot !== null) || this.historyDropped;
  }

  /** The document whose snapshot opened the current epoch. */
  private epochDocId = -1;

  /**
   * True when a reconnecting viewer that has applied everything before `nextSeq` in `epoch` can
   * continue from this hub's buffer instead of receiving a fresh snapshot.
   */
  canResume(epoch: number, nextSeq: number): boolean {
    // Epochs are unique to this hub, so a matching one also proves the cursor came from it.
    if (epoch === 0 || epoch !== this.epoch) return false;
    if (this.usesTree) {
      if (!this.streaming || this.treeState === "dormant") return false;
      return (
        Number.isSafeInteger(nextSeq) && nextSeq >= this.ringStartSeq && nextSeq <= this.seq + 1
      );
    }
    if ((this.meta === null || this.snapshot === null) && !this.historyDropped) return false;
    const offset = nextSeq - (this.snapshotSeq + 1);
    return Number.isSafeInteger(offset) && offset >= 0 && offset <= this.deltas.length;
  }

  /**
   * Viewer join / resync — same code path (D4). A resumable cursor gets the deltas it lacks;
   * otherwise [resync, snapshot]: with the live tree, a snapshot synthesized from it at `seq`;
   * in the legacy store, Meta+FullSnapshot and then the whole delta buffer (seq its last event).
   * The caller then feeds the live tail.
   */
  joinPayload(resume?: { epoch: number; nextSeq: number }): Down[] {
    if (resume !== undefined && this.canResume(resume.epoch, resume.nextSeq)) {
      const tail = this.tail(resume.nextSeq);
      return tail.length === 0
        ? []
        : [{ t: "delta", tab: this.tabId, epoch: this.epoch, seq: resume.nextSeq, data: tail }];
    }
    const payload: Down[] = [{ t: "resync", tab: this.tabId }];
    if (this.usesTree) {
      const snapshot = this.synthesizedSnapshot();
      if (snapshot !== null) payload.push(snapshot);
      else if (this.streaming && !this.snapshotRequested)
        this.requestSnapshot("resync", this.treeState === "dormant" ? "dormant" : "broken");
      return payload;
    }
    if (this.historyDropped && !this.snapshotRequested)
      this.requestSnapshot("resync", "resync-legacy");
    if (this.meta === null || this.snapshot === null) return payload;

    // The buffered deltas travel inside the snapshot, and seq names the last event it covers. The
    // viewer casts a snapshot's events in one task: sent apart, the page as it was at the snapshot
    // (often another page of a single-page app) would be painted before the deltas caught it up.
    payload.push({
      t: "snapshot",
      tab: this.tabId,
      epoch: this.epoch,
      seq: this.snapshotSeq + this.deltas.length,
      data: [this.meta, this.snapshot, ...this.deltas],
      reason: "resync",
    });
    return payload;
  }

  /** The deltas from `nextSeq` on, from the ring or the legacy buffer. */
  private tail(nextSeq: number): eventWithTime[] {
    if (!this.usesTree) return this.deltas.slice(nextSeq - (this.snapshotSeq + 1));
    const start = this.ringHead + (nextSeq - this.ringStartSeq);
    return this.ring.slice(start).map((entry) => entry.event);
  }

  /** The tree as a snapshot at `seq` of the current epoch; null without a live tree. */
  synthesizedSnapshot(): Extract<Down, { t: "snapshot" }> | null {
    if (this.treeState !== "live" || this.tree === null || !this.streaming) return null;
    const memoVersion = this.tree.version;
    const synthesized = synthesize(this.tree);
    // A memo of this version was already counted; a fresh one is a new synthesis.
    if (this.lastSynthVersion !== memoVersion) {
      this.lastSynthVersion = memoVersion;
      pageSyncMetrics.synth.add(synthesized.ms);
    }
    pageSyncMetrics.synthSnapshots += 1;
    return {
      t: "snapshot",
      tab: this.tabId,
      epoch: this.epoch,
      seq: this.seq,
      data: synthesized.events,
      reason: "resync",
    };
  }

  private lastSynthVersion = -1;

  /**
   * The current content of node `id` (LiveTree subtree) at `seq` of the current epoch, for one
   * viewer whose copy of it went apart; null when the tree cannot give it.
   */
  subtreeDown(id: number): Extract<Down, { t: "subtree" }> | null {
    if (this.treeState !== "live" || this.tree === null || !this.streaming) return null;
    const data = subtreeEvents(this.tree, id);
    if (data === null) return null;
    return { t: "subtree", tab: this.tabId, epoch: this.epoch, seq: this.seq, node: id, data };
  }

  /** Whether this hub can bring a viewer up to date right now (a snapshot is not awaited). */
  hasState(): boolean {
    if (this.usesTree) return this.treeState === "live" && this.streaming;
    return this.meta !== null && this.snapshot !== null;
  }

  /** The current replayable snapshot already has this geometry; no new one is needed for it. */
  hasGeometry(w: number, h: number): boolean {
    if (this.snapshotRequested || !this.hasState()) return false;
    if (this.usesTree && this.tree !== null)
      return this.tree.meta.width === w && this.tree.meta.height === h;
    const meta = this.meta;
    return meta?.type === EventType.Meta && meta.data.width === w && meta.data.height === h;
  }

  /** When the page last reported anything, which is how long it has been sitting idle. */
  get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** Fired when thresholds/docId change require a fresh FullSnapshot (caller sends the cmd). */
  onNeedSnapshot(cb: NeedSnapshotListener): void {
    this.needSnapshotListeners.add(cb);
  }

  /**
   * Messages for this tab's viewers that do not come from ingest: a verify snapshot that showed
   * the tree was wrong is broadcast in a new epoch once its frames arrived.
   */
  onDown(listener: (down: Down) => void): () => void {
    this.downListeners.add(listener);
    return () => this.downListeners.delete(listener);
  }

  /** Every fence the page answers, at its place in the stream. */
  onFence(listener: (fence: FenceResult) => void): () => void {
    this.fenceListeners.add(listener);
    return () => this.fenceListeners.delete(listener);
  }

  /**
   * Fence `n`, when the page answers it, even if it already did before anyone waited; "timeout"
   * after `timeoutMs`, or at once once the hub is disposed. A submit-guard fence's text comes
   * with it to the first caller only: the hub keeps none of it.
   */
  whenFenced(n: number, timeoutMs: number): Promise<FenceResult | "timeout"> {
    const withText = (fence: FenceResult): FenceResult => {
      const text = this.fenceTexts.get(n);
      if (text === undefined) return fence;
      this.fenceTexts.delete(n);
      return { ...fence, text };
    };
    const known = this.fences.get(n);
    if (known !== undefined) return Promise.resolve(withText(known));
    if (this.disposed) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const stop = this.onFence((fence) => {
        if (fence.n !== n) return;
        clearTimeout(timer);
        stop();
        resolve(withText(fence));
      });
      const timer = setTimeout(() => {
        stop();
        resolve("timeout");
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /** A dead renderer's cached document must never be offered as current page content. */
  invalidateDocument(): void {
    this.hasDocument = false;
    this.historyDropped = false;
    this.meta = null;
    this.snapshot = null;
    this.deltas = [];
    this.deltaBytes = 0;
    this.snapshotSeq = 0;
    this.nextMeta = null;
    this.pendingFullSnapshot = null;
    this.pendingSnapshotReason = null;
    this.queuedSnapshotReason = null;
    this.clearSnapshotRetry(true);
    this.clearSnapshotRequest();
    this.epochDocId = -1;
    this.dropTree(this.treeOpts === null ? "off" : "none");
    this.clearRing(this.seq + 1);
    this.breaks = [];
  }

  /**
   * The tab is gone, or its target was attached again under a new hub. Its timers stop and it
   * never asks a page for a snapshot again: the agent behind a reattached target is the new
   * hub's, and a retry from here would give that page unrequested snapshots and new epochs.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fenceTexts.clear();
    this.clearSnapshotRetry(true);
    this.clearSnapshotRequest();
    this.needSnapshotListeners.clear();
    this.downListeners.clear();
    this.dropTree(this.treeState);
    this.clearRing(this.seq + 1);
    this.budget?.unregister(this);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Someone is using the page, even if it has nothing to report yet. */
  noteInput(at = this.now()): void {
    if (!Number.isFinite(at)) throw new RangeError("input timestamp must be finite");
    this.lastActivity = at;
  }

  /** The page's stream lost an event: what the hub holds of it can no longer be trusted. */
  noteStreamLoss(): void {
    if (this.usesTree && this.treeState === "live") {
      this.breakTree(new TreeBroken("stream-loss"), "stream-loss");
      return;
    }
    this.requestSnapshot("resync", "stream-loss");
  }

  /** Shown by a session, or no longer: background tabs are the first to go dormant. */
  setForeground(foreground: boolean): void {
    if (foreground || this.foreground) this.lastViewedAt = this.now();
    this.foreground = foreground;
  }

  get background(): boolean {
    return !this.foreground;
  }

  get dormant(): boolean {
    return this.treeState === "dormant";
  }

  treeBytes(): number {
    return this.tree === null ? 0 : this.tree.estBytes + this.ringBytes;
  }

  /** The budget let this tab go: its tree and tail are dropped until a viewer needs it again. */
  goDormant(): void {
    if (this.treeState !== "live") return;
    pageSyncMetrics.dormant += 1;
    logTree(`${this.tabId} dormant (${this.treeBytes()} bytes)`);
    this.dropTree("dormant");
    this.clearRing(this.seq + 1);
  }

  /** For metrics: what this hub's tree holds. */
  treeStats(): TabTreeGauge {
    const stats = this.tree?.stats();
    return {
      tab: this.tabId,
      state: this.treeState,
      nodes: stats?.nodes ?? 0,
      estBytes: stats?.estBytes ?? 0,
      sidecar: stats?.sidecar ?? 0,
      ring: this.ring.length - this.ringHead,
    };
  }

  /** Force a fresh snapshot for a semantic cause such as viewport geometry change. */
  requestSnapshot(reason: SnapshotReason, cause?: PageSnapshotCause): void {
    if (this.disposed) return;
    if (this.snapshotRequested) {
      if (reason !== this.pendingSnapshotReason) {
        this.queuedSnapshotReason = strongerReason(this.queuedSnapshotReason, reason);
      }
      return;
    }
    this.snapshotCause = cause ?? (reason === "resync" ? "resync-legacy" : reason);
    this.pendingSnapshotReason = strongerReason(this.pendingSnapshotReason, reason);
    // A fresh semantic request supersedes a pending retry timer. Preserve its backoff until an
    // epoch succeeds or a new document resets the recovery chain.
    this.clearSnapshotRetry(false);
    this.snapshotRequested = true;
    this.snapshotRequestedAt = this.now();
    const attempt = ++this.snapshotRequestAttempt;
    this.snapshotRequestTimer = setTimeout(
      () => this.failSnapshotRequest(attempt),
      this.snapshotRequestTimeoutMs,
    );
    this.snapshotRequestTimer.unref?.();

    const requestedReason = this.pendingSnapshotReason ?? reason;
    for (const listener of this.needSnapshotListeners) {
      try {
        Promise.resolve(listener(requestedReason)).catch(() => this.failSnapshotRequest(attempt));
      } catch {
        this.failSnapshotRequest(attempt);
      }
    }
  }

  private openPendingSnapshot(): Down[] {
    if (this.pendingFullSnapshot === null) return [];
    const meta = this.nextMeta ?? this.meta ?? this.currentMeta();
    if (meta === null) return [];

    const full = this.pendingFullSnapshot;
    const asked = this.snapshotRequested;
    const cause: PageSnapshotCause = asked
      ? (this.snapshotCause ?? "resync-legacy")
      : "page-initiated";
    this.lastSnapshotMs =
      asked && this.snapshotRequestedAt !== null ? this.now() - this.snapshotRequestedAt : null;
    this.nextMeta = null;
    this.pendingFullSnapshot = null;
    this.clearSnapshotRequest();
    this.clearSnapshotRetry(true);
    this.snapshotCause = null;
    const sameDocument = this.epochDocId === this.docId;

    // The gateway's own check of its tree: decided once the frame documents have arrived.
    if (this.usesTree && sameDocument && this.treeState === "live" && cause === "verify") {
      notePageSnapshot("verify");
      this.pendingSnapshotReason = null;
      const queued = this.queuedSnapshotReason;
      this.queuedSnapshotReason = null;
      this.startVerify(meta, full);
      if (queued !== null) this.requestSnapshot(queued);
      return [];
    }
    notePageSnapshot(cause);
    if (this.pendingVerify !== null) {
      clearTimeout(this.pendingVerify.timer);
      this.pendingVerify = null;
    }
    // Every same-document snapshot also checks the tree, for the metrics.
    if (this.usesTree && sameDocument && this.treeState === "live" && this.tree !== null)
      this.countVerify(this.tree.compare(meta, full, []));

    this.meta = meta;
    this.historyDropped = false;
    this.deltas = [];
    this.deltaBytes = 0;
    this.epoch = this.nextEpoch();
    this.epochDocId = this.docId;
    this.snapshotSeq = ++this.seq;
    // A page that opened at the agreed size needs no second snapshot to prove it.
    const settlesViewport =
      this.queuedSnapshotReason === "viewport" &&
      this.viewport !== null &&
      meta.type === EventType.Meta &&
      meta.data.width === this.viewport.w &&
      meta.data.height === this.viewport.h;
    const reason = settlesViewport ? "viewport" : (this.pendingSnapshotReason ?? "resync");
    const queuedReason = settlesViewport ? null : this.queuedSnapshotReason;
    this.pendingSnapshotReason = null;
    this.queuedSnapshotReason = null;

    const external = externalizeSheets(full);
    if (this.usesTree) {
      // The hub keeps the tree, not the page's snapshot.
      this.snapshot = null;
      this.clearRing(this.snapshotSeq + 1);
      this.seedTree(meta, full);
    } else {
      this.snapshot = external;
    }

    if (queuedReason !== null) this.requestSnapshot(queuedReason);

    return [
      {
        t: "snapshot",
        tab: this.tabId,
        epoch: this.epoch,
        seq: this.snapshotSeq,
        data: [meta, external],
        reason,
      },
    ];
  }

  /** The Meta of the current state, wherever it is kept. */
  private currentMeta(): eventWithTime | null {
    if (this.tree === null) return this.meta;
    return {
      type: EventType.Meta,
      timestamp: this.tree.lastTimestamp,
      data: { ...this.tree.meta },
    } as eventWithTime;
  }

  // ---- live tree ----

  private seedTree(meta: eventWithTime, full: eventWithTime): void {
    this.dropTree("none");
    if (this.treeState === "dormant" || this.budget?.fits(0) === false) {
      // Dormant (or the budget is full): build again only with room to spare.
    }
    try {
      this.tree = LiveTree.seed(meta, full, { checkInvariants: this.treeOpts?.verify === true });
    } catch (error) {
      this.fallBack(error instanceof TreeBroken ? `seed:${error.kind}` : "seed");
      return;
    }
    this.anomaliesCounted = {};
    this.recompactAsked = false;
    this.mutationsSinceVerify = 0;
    if (!this.withinTabCaps()) return;
    if (this.budget !== null && !this.budget.fits(this.tree.estBytes) && this.background) {
      // A background tab that does not fit stays dormant until someone looks at it.
      this.dropTree("dormant");
      pageSyncMetrics.dormant += 1;
      return;
    }
    this.treeState = "live";
    logTree(`${this.tabId} seeded epoch ${this.epoch}: ${this.tree.nodes.size} nodes`);
    this.budget?.enforce();
  }

  private applyToTree(event: eventWithTime): void {
    const tree = this.tree!;
    const started = performance.now();
    try {
      tree.apply(event);
    } catch (error) {
      this.breakTree(error instanceof TreeBroken ? error : new TreeBroken("exception"), "broken");
      return;
    }
    const micros = (performance.now() - started) * 1000;
    pageSyncMetrics.apply.add(micros);
    this.noteCpu(micros / 1000);
    if (this.treeState !== "live") return;
    if (
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Mutation
    ) {
      this.mutationsSinceVerify += 1;
      this.scheduleVerify();
    }
    if ((this.eventsSinceBudget += 1) >= BUDGET_EVERY) {
      this.eventsSinceBudget = 0;
      this.countAnomalies();
      if (!this.withinTabCaps()) return;
      this.budget?.enforce();
    }
    if (
      !this.recompactAsked &&
      tree.sidecar.length > (this.treeOpts?.maxSidecar ?? Number.POSITIVE_INFINITY)
    ) {
      // Sheet edits pile up on CSS-in-JS pages: a page snapshot has them all in its sheet text.
      this.recompactAsked = true;
      logTree(`${this.tabId} recompacting ${tree.sidecar.length} sheet edits`);
      this.requestSnapshot("resync", "recompact");
    }
  }

  /** Per-tab caps: past them this document uses the legacy store. False when it fell back. */
  private withinTabCaps(): boolean {
    const tree = this.tree;
    if (tree === null || this.treeOpts === null) return false;
    if (tree.nodes.size <= this.treeOpts.maxNodes && tree.estBytes <= this.treeOpts.maxBytes)
      return true;
    this.fallBack(tree.nodes.size > this.treeOpts.maxNodes ? "nodes" : "bytes");
    return false;
  }

  /** More than CPU_HOT_MS_PER_S of applying in each of CPU_HOT_SECONDS seconds: give up. */
  private noteCpu(ms: number): void {
    const second = Math.floor(this.now() / 1000);
    if (second !== this.cpuSecond) {
      if (second === this.cpuSecond + 1 && this.cpuSecondMs > CPU_HOT_MS_PER_S)
        this.cpuHotSeconds += 1;
      else if (this.cpuSecondMs <= CPU_HOT_MS_PER_S || second !== this.cpuSecond + 1)
        this.cpuHotSeconds = 0;
      this.cpuSecond = second;
      this.cpuSecondMs = 0;
    }
    this.cpuSecondMs += ms;
    if (this.cpuHotSeconds >= CPU_HOT_SECONDS) this.fallBack("cpu");
  }

  /**
   * This document uses the legacy store from now on. Its snapshot is not kept with a tree, so a
   * page snapshot is asked for; until it comes, a joining viewer waits for it.
   */
  private fallBack(kind: string): void {
    noteFallback(kind);
    logTree(`${this.tabId} uses the legacy store for this document (${kind})`);
    this.legacyDocId = this.docId;
    this.dropTree("legacy");
    this.clearRing(this.seq + 1);
    this.historyDropped = true;
    this.snapshotSeq = this.seq;
    if (!this.snapshotRequested) this.requestSnapshot("resync", "broken");
  }

  private breakTree(error: TreeBroken, cause: PageSnapshotCause): void {
    noteTreeBroken(error.kind);
    logTree(`${this.tabId} tree broken: ${error.kind}${error.detail ? ` (${error.detail})` : ""}`);
    if (error.fallback) {
      this.fallBack(error.kind);
      return;
    }
    const now = this.now();
    this.breaks = this.breaks.filter((at) => now - at < REPEAT_BREAK_MS);
    this.breaks.push(now);
    if (this.breaks.length >= 2) {
      this.fallBack("repeat-breaks");
      return;
    }
    this.dropTree("broken");
    if (this.snapshotRequested) this.snapshotCause = cause;
    else this.requestSnapshot("resync", cause);
  }

  private dropTree(state: TreeState): void {
    if (this.tree !== null) {
      this.countAnomalies();
      forgetSynthesized(this.tree);
    }
    this.tree = null;
    this.lastSynthVersion = -1;
    if (this.verifyTimer !== undefined) clearTimeout(this.verifyTimer);
    this.verifyTimer = undefined;
    if (this.pendingVerify !== null) clearTimeout(this.pendingVerify.timer);
    this.pendingVerify = null;
    this.treeState = this.treeOpts === null ? "off" : state;
  }

  private countAnomalies(): void {
    const tree = this.tree;
    if (tree === null) return;
    const delta: Record<string, number> = {};
    for (const [key, value] of Object.entries(tree.anomalies)) {
      delta[key] = value - (this.anomaliesCounted[key] ?? 0);
      this.anomaliesCounted[key] = value;
    }
    noteAnomalies(delta);
  }

  private pushRing(entry: RingEntry): void {
    if (this.ring.length - this.ringHead === 0) this.ringStartSeq = entry.seq;
    this.ring.push(entry);
    this.ringBytes += entry.bytes;
    const opts = this.treeOpts!;
    while (
      this.ring.length - this.ringHead > opts.ringEvents ||
      (this.ringBytes > opts.ringBytes && this.ring.length - this.ringHead > 1)
    ) {
      const oldest = this.ring[this.ringHead]!;
      this.ringHead += 1;
      this.ringBytes -= oldest.bytes;
      this.ringStartSeq = oldest.seq + 1;
    }
    if (this.ringHead > 1024 && this.ringHead * 2 > this.ring.length) {
      this.ring = this.ring.slice(this.ringHead);
      this.ringHead = 0;
    }
  }

  private clearRing(nextSeq: number): void {
    this.ring = [];
    this.ringHead = 0;
    this.ringBytes = 0;
    this.ringStartSeq = nextSeq;
  }

  // ---- VERIFY: compare the tree with a page snapshot now and then ----

  private scheduleVerify(): void {
    const opts = this.treeOpts;
    if (opts === null || !opts.verify || this.verifyTimer !== undefined) return;
    if (this.mutationsSinceVerify < (opts.verifyAfterMutations ?? 500)) return;
    const idleMs = opts.verifyIdleMs ?? 2_000;
    const intervalMs = opts.verifyIntervalMs ?? 30_000;
    const check = () => {
      this.verifyTimer = undefined;
      if (this.disposed || this.treeState !== "live") return;
      const now = this.now();
      if (now - this.lastActivity >= idleMs && now - this.lastVerifyAt >= intervalMs) {
        if (this.snapshotRequested || this.pendingVerify !== null) return;
        this.lastVerifyAt = now;
        this.mutationsSinceVerify = 0;
        this.requestSnapshot("resync", "verify");
        return;
      }
      this.verifyTimer = setTimeout(check, Math.max(idleMs, 250));
      this.verifyTimer.unref?.();
    };
    this.verifyTimer = setTimeout(check, Math.max(idleMs, 250));
    this.verifyTimer.unref?.();
  }

  /** Asks for a verify snapshot at once (tests, and a viewer that keeps asking to catch up). */
  suspect(): void {
    if (this.treeState !== "live" || this.snapshotRequested || this.pendingVerify !== null) return;
    this.lastVerifyAt = this.now();
    this.mutationsSinceVerify = 0;
    this.requestSnapshot("resync", "verify");
  }

  private startVerify(meta: eventWithTime, full: eventWithTime): void {
    const timer = setTimeout(() => {
      const downs = this.decideVerify();
      for (const down of downs) for (const listener of [...this.downListeners]) listener(down);
    }, VERIFY_SETTLE_MS);
    timer.unref?.();
    this.pendingVerify = { meta, full, checkout: [], timer };
  }

  /**
   * The verify snapshot and its checkout against the tree (which applied the same checkout).
   * A match swallows the snapshot: no message, same epoch and seq, and the tree starts again from
   * the page's (its sheet edits are in the sheet text now). A mismatch reseeds the tree from the
   * page's snapshot and sends it to every viewer in a new epoch.
   */
  private decideVerify(): Down[] {
    const pending = this.pendingVerify;
    if (pending === null) return [];
    clearTimeout(pending.timer);
    this.pendingVerify = null;
    const tree = this.tree;
    if (tree === null || this.treeState !== "live") return [];
    let page: LiveTree;
    try {
      page = LiveTree.seed(pending.meta, pending.full);
      for (const event of pending.checkout) page.apply(event);
    } catch {
      return [];
    }
    const mismatches = tree.compare(pending.meta, pending.full, pending.checkout);
    const kept = this.countVerify(mismatches);
    if (kept.length === 0) {
      forgetSynthesized(tree);
      this.tree = page;
      this.lastSynthVersion = -1;
      this.anomaliesCounted = {};
      return [];
    }
    logTree(
      `${this.tabId} verify mismatch: ${kept
        .slice(0, 5)
        .map((mismatch) => `${mismatch.id}:${mismatch.kind}`)
        .join(" ")}`,
    );
    forgetSynthesized(tree);
    this.tree = page;
    this.lastSynthVersion = -1;
    this.anomaliesCounted = {};
    this.epoch = this.nextEpoch();
    this.clearRing(this.seq + 1);
    const snapshot = this.synthesizedSnapshot();
    return snapshot === null ? [] : [snapshot];
  }

  /** Counts a comparison; returns the mismatches that count. */
  private countVerify(mismatches: ReturnType<LiveTree["compare"]>) {
    // A cross-site frame's document may come back later, or under new ids: not a difference.
    const kept = significantMismatches(mismatches).filter(
      (mismatch) => mismatch.kind !== "frame-id" && mismatch.kind !== "frame-not-in-page",
    );
    if (kept.length === 0) pageSyncMetrics.verify.match += 1;
    else pageSyncMetrics.verify.mismatch += 1;
    if (kept.length !== mismatches.length) pageSyncMetrics.verify.styleOrForm += 1;
    return kept;
  }

  private failSnapshotRequest(attempt: number): void {
    if (this.disposed) return;
    if (!this.snapshotRequested || attempt !== this.snapshotRequestAttempt) return;
    const reason = this.pendingSnapshotReason;
    this.clearSnapshotRequest();
    if (reason === "nav" || reason === "resync") this.scheduleSnapshotRetry(reason);
  }

  private clearSnapshotRequest(): void {
    this.snapshotRequested = false;
    this.snapshotRequestAttempt += 1;
    if (this.snapshotRequestTimer !== undefined) clearTimeout(this.snapshotRequestTimer);
    this.snapshotRequestTimer = undefined;
  }

  private scheduleSnapshotRetry(reason: "nav" | "resync"): void {
    this.clearSnapshotRetry(false);
    const docId = this.docId;
    const epoch = this.epoch;
    const cause = this.snapshotCause;
    const delayMs = this.snapshotRetryDelayMs;
    this.snapshotRetryDelayMs =
      delayMs >= Math.ceil(this.snapshotRetryMaxMs / 2) ? this.snapshotRetryMaxMs : delayMs * 2;

    this.snapshotRetryTimer = setTimeout(() => {
      this.snapshotRetryTimer = undefined;
      if (this.disposed || !this.hasDocument || this.docId !== docId || this.epoch !== epoch)
        return;
      if (this.snapshotRequested) return;
      this.requestSnapshot(reason, cause ?? undefined);
    }, delayMs);
    this.snapshotRetryTimer.unref?.();
  }

  private clearSnapshotRetry(resetBackoff: boolean): void {
    if (this.snapshotRetryTimer !== undefined) clearTimeout(this.snapshotRetryTimer);
    this.snapshotRetryTimer = undefined;
    if (resetBackoff) this.snapshotRetryDelayMs = this.snapshotRetryMs;
  }
}

/** What follows a page snapshot as part of taking it: frame documents and adopted sheets. */
function isCheckoutEvent(event: eventWithTime): boolean {
  if (event.type !== EventType.IncrementalSnapshot) return false;
  if (event.data.source === IncrementalSource.AdoptedStyleSheet) return true;
  return (
    event.data.source === IncrementalSource.Mutation &&
    (event.data as { isAttachIframe?: boolean }).isAttachIframe === true
  );
}

const SNAPSHOT_REASON_PRIORITY: Record<SnapshotReason, number> = {
  resync: 1,
  viewport: 2,
  nav: 3,
};

function strongerReason(current: SnapshotReason | null, candidate: SnapshotReason): SnapshotReason {
  if (current === null || SNAPSHOT_REASON_PRIORITY[candidate] > SNAPSHOT_REASON_PRIORITY[current]) {
    return candidate;
  }
  return current;
}

function assertLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveLimit(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/**
 * The JSON text of a Down a hub produced, so that the fan-out sends what the hub already wrote to
 * count its bytes instead of serializing it again. Keyed by the object: a copy or a mutation is
 * a different message and serializes afresh.
 */
const serializedDowns = new WeakMap<Down, string>();

export function serializedDown(msg: Down): string | undefined {
  return serializedDowns.get(msg);
}

/** Serializes a Down once, remembering the text for the fan-out. */
export function encodeDownOnce(msg: Down): string {
  const known = serializedDowns.get(msg);
  if (known !== undefined) return known;
  const text = encodeMsg(msg);
  serializedDowns.set(msg, text);
  return text;
}

function utf8JsonBytes(value: Down): number {
  const text = encodeDownOnce(value);
  // Counts without copying the text into a new buffer.
  return Buffer.byteLength(text, "utf8");
}
