/**
 * Sandboxed rrweb mirror and stream-order state machine.
 *
 * The viewer never repairs a divergent document. Any gap or replay failure discards the entire
 * Replayer (including its iframe) when a fresh snapshot is ready (D10). The last known-good
 * iframe remains visible during recovery and is atomically replaced, so recovery never exposes
 * a white/status-only interval.
 *
 * mirror-sync.ts decides what each message does to the stream state (and documents it),
 * mirror-replayer.ts builds and destroys Replayer generations, and mirror-parking.ts keeps the
 * pages of tabs left behind. This file holds the state and carries out the decisions.
 */
import type { Replayer } from "@rrweb/replay";
import {
  EventType,
  type Down,
  type eventWithTime,
  type ResumeCursor,
  type TabId,
} from "@mirror/protocol";
import { createServerClock, type ServerClock } from "./clock";
import type { EventPipeline } from "./pipeline";
import {
  createRebuildRestoreHooks,
  type RebuildRestoreHooks,
  type RebuildRestorePoint,
} from "./rebuild-restore";
import { createParkedPages } from "./mirror-parking";
import {
  buildLive,
  destroyLive as destroyGeneration,
  disposeRtc as disposeLane,
  isCanvasMutation,
  type LiveRtc,
  type LiveState,
  type MirrorRtcOptions,
} from "./mirror-replayer";
import {
  catchUpAnswered,
  planDelta,
  resyncDecision,
  snapshotDecision,
  type CatchUp,
} from "./mirror-sync";

export type { MirrorRtcOptions } from "./mirror-replayer";

/** How long the page in view waits for the snapshot of the tab that is replacing it. */
const TAB_SWITCH_WAIT_MS = 1_500;
/**
 * How long a reconnect that did not resume waits for the snapshot its join payload carries. A hub
 * with none cached asks the page itself, which normally answers well within this.
 */
export const RECONNECT_SNAPSHOT_WAIT_MS = 5_000;

type Snapshot = Extract<Down, { t: "snapshot" }>;
type Delta = Extract<Down, { t: "delta" }>;

export interface Mirror {
  handle(msg: Down): void;
  recover(reason: string): void;
  connectionLost(): void;
  /** `resumed`: the gateway continued this replay from its cursor, so no snapshot is needed. */
  connectionRestored(resumed?: boolean): void;
  /** Where the live replay stands, for resuming after a reconnect; null when it must rebuild. */
  resumeCursor(): ResumeCursor | null;
  selectTab(tab: TabId): void;
  getActiveTab(): TabId | null;
  getIframe(): HTMLIFrameElement | null;
  getReplayer(): Replayer | null;
  observeRtt(rttMs: number): void;
  /** Recompute how the remote viewport fits after the viewer changes size. */
  refreshViewportLayout(): void;
  /** Lets go of hidden pages of tabs that no longer exist. */
  keepTabs(tabs: readonly TabId[]): void;
  /** Tear down the Replayer and its iframe. */
  teardown(): void;
}

export interface MirrorOpts {
  container: HTMLElement;
  pipeline: EventPipeline;
  bufferMs?: number;
  requestResync(tab: TabId, reason: string): void;
  now?: () => number;
  clock?: ServerClock;
  /** Shared with Phase-1 echo so predicted edit state can join the rebuild restore point. */
  restoreHooks?: RebuildRestoreHooks;
  /** Phase-1 listeners live inside this Replayer's iframe and must be renewed on rebuild. */
  attachInteraction?(tab: TabId, replayer: Replayer): () => void;
  /** Sees each Replayer from before its snapshot is cast until it is destroyed. */
  watchReplayer?(tab: TabId, replayer: Replayer): () => void;
  onSnapshotApplied?(snapshot: Snapshot): void;
  /** Report the buffer actually installed in this Replayer, rather than a future target. */
  onBufferApplied?(bufferMs: number): void;
  /** WebRTC is created and destroyed with each Replayer generation. */
  rtc?: MirrorRtcOptions;
  /** How many tabs left behind stay built, hidden, so that returning to them is immediate. */
  parkedTabs?: number;
}

export function createMirror(opts: MirrorOpts): Mirror {
  const now = opts.now ?? Date.now;
  const clock =
    opts.clock ??
    createServerClock({
      now,
      bufferMs: opts.bufferMs,
    });
  const restoreHooks = opts.restoreHooks ?? createRebuildRestoreHooks();
  /** The stream state (see mirror-sync.ts) and the page in view. */
  const sync: { activeTab: TabId | null; snapshotPending: boolean; catchUp: CatchUp } = {
    activeTab: null,
    snapshotPending: false,
    catchUp: null,
  };
  let state: LiveState | null = null;
  let switchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Asks for a snapshot if a reconnect's join payload brought none. */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRestore: RebuildRestorePoint | null = null;
  let viewerId: string | null = null;
  let isDriver = true;
  let viewportLimit: Extract<Down, { t: "hello" }>["viewportLimit"];

  const disposeRtc = (tab: TabId, rtc: LiveRtc | null) => disposeLane(opts.rtc, tab, rtc);
  const destroyLive = (live: LiveState) => destroyGeneration(opts.rtc, live);
  const parked = createParkedPages(opts.parkedTabs ?? 0, destroyLive);

  const applyViewportLayout = () => {
    const live = state;
    if (live === null) return;
    live.mount.dataset.viewportRole = isDriver ? "driver" : "follower";
    opts.container.dataset.viewportRole = isDriver ? "driver" : "follower";
    const viewport = live.viewport;
    const { clientWidth, clientHeight } = opts.container;
    const fitted =
      !isDriver ||
      (viewportLimit && (clientWidth > viewportLimit.width || clientHeight > viewportLimit.height));
    if (viewport === null || !fitted) {
      delete live.mount.dataset.fit;
      live.mount.style.width = "";
      live.mount.style.height = "";
      live.mount.style.transform = "";
      return;
    }
    const scale = fitViewportScale(viewport.w, viewport.h, clientWidth, clientHeight);
    live.mount.dataset.fit = "true";
    live.mount.style.width = `${viewport.w}px`;
    live.mount.style.height = `${viewport.h}px`;
    live.mount.style.transform = `scale(${scale})`;
  };

  const captureInteraction = (live: LiveState | null = state) => {
    if (live !== null) pendingRestore = restoreHooks.capture(live.replayer.iframe);
  };

  /** Clears the visible surface, and only that: hidden pages have to stay where they are. */
  const clearForeground = (keep?: Element) => {
    const hidden = parked.stages();
    for (const child of [...opts.container.children]) {
      if (child !== keep && !hidden.has(child)) child.remove();
    }
  };

  const renderStatus = (message: string) => {
    clearForeground();
    opts.container.dataset.mirrorState = "waiting";
    const status = opts.container.ownerDocument.createElement("p");
    status.className = "mirror-status";
    status.setAttribute("role", "status");
    status.textContent = message;
    opts.container.appendChild(status);
  };

  const discard = (message: string, preserveInteraction = false) => {
    const oldState = state;
    if (preserveInteraction) captureInteraction(oldState);
    state = null;
    opts.pipeline.reset();
    if (oldState !== null) destroyLive(oldState);
    renderStatus(message);
  };

  /** Parks a page that can be kept: its WebRTC lane and listeners end with the view. */
  const park = (live: LiveState) => {
    const rtc = live.rtc;
    live.rtc = null;
    disposeRtc(live.tab, rtc);
    live.detachInteraction();
    live.detachInteraction = () => {};
    parked.park(live);
  };

  /** Takes the page in view off the screen, keeping it if it can be kept. */
  const setAside = (message: string) => {
    const live = state;
    if (live === null || !parked.canPark(live)) {
      discard(message);
      return;
    }
    state = null;
    opts.pipeline.reset();
    park(live);
    renderStatus(message);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const clearSwitchTimer = () => {
    if (switchTimer !== null) clearTimeout(switchTimer);
    switchTimer = null;
  };

  const endTabSwitch = () => {
    clearSwitchTimer();
    sync.catchUp = null;
    delete opts.container.dataset.switching;
    if (state !== null) state.stage.inert = state.needsSnapshot;
  };

  /** The page is shown at once, but input waits for the gateway to say what it has missed. */
  const awaitCatchUp = (tab: TabId) => {
    sync.catchUp = "waiting";
    if (state !== null) state.stage.inert = true;
    switchTimer = setTimeout(() => {
      switchTimer = null;
      if (sync.catchUp !== "waiting") return;
      sync.catchUp = null;
      requestFreshSnapshot(tab, "tab selected");
    }, TAB_SWITCH_WAIT_MS);
  };

  const setSnapshotPending = (pending: boolean) => {
    sync.snapshotPending = pending;
    if (pending) opts.container.dataset.resyncPending = "true";
    else delete opts.container.dataset.resyncPending;
  };

  const awaitSnapshot = (tab: TabId) => {
    if (state?.tab === tab) {
      state.needsSnapshot = true;
      state.stage.inert = true;
    }
    setSnapshotPending(true);
  };

  const requestFreshSnapshot = (tab: TabId, reason: string) => {
    if (sync.snapshotPending) return;
    awaitSnapshot(tab);
    opts.requestResync(tab, reason);
  };

  const commitSnapshot = (live: LiveState, message: Snapshot) => {
    live.viewport = extractSnapshotViewport(message) ?? live.viewport;
    live.stage.inert = false;
    setSnapshotPending(false);
    opts.container.dataset.mirrorState = "live";
    applyViewportLayout();
    opts.onSnapshotApplied?.(message);
  };

  const addEvent = (live: LiveState, event: eventWithTime): boolean => {
    if (isCanvasMutation(event)) {
      void live.canvas.apply(event);
      return true;
    }
    try {
      const processed = opts.pipeline.run(event, { tab: live.tab, nowMs: now() });
      if (processed !== null) live.replayer.addEvent(processed);
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      requestFreshSnapshot(live.tab, `replayer.addEvent: ${detail}`);
      return false;
    }
  };

  const rebuild = (message: Snapshot) => {
    endTabSwitch();
    if (message.reason === "nav" || (state !== null && state.tab !== message.tab)) {
      pendingRestore = null;
    } else captureInteraction();
    const restorePoint = pendingRestore;
    const viewport = state?.tab === message.tab ? state.viewport : null;
    pendingRestore = null;
    // The teardown and replacement happen in one synchronous websocket task. Browsers cannot
    // paint or run the chaos sampler between these operations, so the last good frame remains on
    // screen until this task commits the new iframe without overlapping two rrweb instances.
    if (state !== null && state.tab !== message.tab) setAside("Building the mirror…");
    else discard("Building the mirror…");
    parked.drop(message.tab);
    sync.activeTab = message.tab;
    const stage = opts.container.ownerDocument.createElement("div");
    stage.className = "mirror-stage";
    const mount = opts.container.ownerDocument.createElement("div");
    mount.className = "mirror-replayer";
    stage.appendChild(mount);
    clearForeground();
    opts.container.appendChild(stage);
    opts.container.dataset.mirrorState = "building";

    const built = buildLive({
      message,
      stage,
      mount,
      viewport,
      document: opts.container.ownerDocument,
      pipeline: opts.pipeline,
      clock,
      now,
      rtc: opts.rtc,
      restoreHooks,
      restorePoint,
      onRestoreUnused: (point) => {
        pendingRestore = point;
      },
      onBufferApplied: opts.onBufferApplied,
      ...(opts.watchReplayer === undefined
        ? {}
        : { watchReplayer: (replayer: Replayer) => opts.watchReplayer!(message.tab, replayer) }),
    });
    if (!built.ok) {
      renderStatus("Mirror recovery requested…");
      setSnapshotPending(false);
      requestFreshSnapshot(message.tab, `snapshot replay: ${built.detail}`);
      return;
    }
    state = built.live;
    state.detachInteraction = opts.attachInteraction?.(message.tab, state.replayer) ?? (() => {});
    commitSnapshot(state, message);
  };

  const applyDelta = (message: Delta) => {
    const { plan, catchUp } = planDelta(sync, state, message);
    sync.catchUp = catchUp;
    switch (plan.kind) {
      case "ignore":
        return;
      case "resync-unshown":
        if (sync.activeTab === null) sync.activeTab = message.tab;
        requestFreshSnapshot(message.tab, plan.reason);
        return;
      case "resync":
        requestFreshSnapshot(message.tab, plan.reason);
        return;
      case "apply": {
        const live = state!;
        for (const event of plan.data) {
          if (!addEvent(live, event)) return;
        }
        live.nextSeq = plan.seq + plan.data.length;
      }
    }
  };

  renderStatus("Waiting for a snapshot…");

  return {
    handle(msg) {
      const serverTs = (msg as Down & { serverTs?: unknown }).serverTs;
      if (typeof serverTs === "number") clock.observeServerTime(serverTs, now());
      switch (msg.t) {
        case "hello":
          viewerId = msg.viewerId;
          isDriver = msg.role === "driver";
          viewportLimit = msg.viewportLimit;
          applyViewportLayout();
          break;
        case "driver":
          isDriver = viewerId !== null && msg.viewerId === viewerId;
          applyViewportLayout();
          break;
        case "snapshot":
          switch (snapshotDecision(sync, state, msg)) {
            case "confirm":
              clearSwitchTimer();
              sync.catchUp = "snapshot";
              commitSnapshot(state!, msg);
              break;
            case "rebuild":
              rebuild(msg);
              break;
          }
          break;
        case "delta":
          applyDelta(msg);
          break;
        case "resync":
          switch (resyncDecision(sync, state, msg.tab)) {
            case "catch-up-answered":
              sync.catchUp = catchUpAnswered(sync.catchUp);
              break;
            case "await-snapshot":
              sync.activeTab = msg.tab;
              awaitSnapshot(msg.tab);
              break;
          }
          break;
        case "rtc-sig": {
          const live = state;
          if (
            live !== null &&
            live.tab === msg.tab &&
            live.rtc !== null &&
            live.rtc.lane === msg.lane
          ) {
            live.rtc.controller.receive(msg.payload);
          }
          break;
        }
      }
    },
    recover(reason) {
      if (sync.activeTab !== null) requestFreshSnapshot(sync.activeTab, reason);
    },
    connectionLost() {
      clearReconnectTimer();
      parked.dropAll();
      endTabSwitch();
      // Plain pages keep their unused media discovery plugin when DOM replay resumes. A lane
      // that asked for media must rebuild: its disposed plugin cannot negotiate again.
      if (state?.rtc?.hasMediaRequests()) {
        const rtc = state.rtc;
        state.rtc = null;
        state.needsSnapshot = true;
        state.stage.inert = true;
        disposeRtc(state.tab, rtc);
      }
      if (state === null) renderStatus("Connection lost. Reconnecting…");
      else opts.container.dataset.connectionStale = "true";
      setSnapshotPending(false);
    },
    connectionRestored(resumed = false) {
      delete opts.container.dataset.connectionStale;
      clearReconnectTimer();
      const tab = sync.activeTab;
      if (tab === null) return;
      if (resumed) {
        if (state?.tab === tab && !state.needsSnapshot) return;
        // Resumed by a gateway that sends no snapshot, but this page cannot continue.
        requestFreshSnapshot(tab, "ws reconnect");
        return;
      }
      // A connection that did not resume opens with the tab's resync and cached snapshot, so
      // asking for another would only rebuild the page twice. Ask only if none comes.
      awaitSnapshot(tab);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (sync.snapshotPending && sync.activeTab === tab) opts.requestResync(tab, "ws reconnect");
      }, RECONNECT_SNAPSHOT_WAIT_MS);
    },
    resumeCursor() {
      if (state === null || state.needsSnapshot || state.tab !== sync.activeTab) return null;
      return { tab: state.tab, epoch: state.epoch, nextSeq: state.nextSeq };
    },
    selectTab(tab) {
      if (tab === sync.activeTab) return;
      sync.activeTab = tab;
      pendingRestore = null;
      setSnapshotPending(false);
      endTabSwitch();
      // Picture mode clears the shared surface, and an iframe does not survive leaving the page.
      if (parked.peek(tab)?.stage.isConnected === false) parked.drop(tab);
      const saved = parked.take(tab);
      if (saved !== undefined) {
        const leaving = state;
        state = saved;
        opts.pipeline.reset();
        if (leaving !== null) {
          if (parked.canPark(leaving)) park(leaving);
          else destroyLive(leaving);
        }
        clearForeground(saved.stage);
        delete saved.stage.dataset.parked;
        saved.detachInteraction = opts.attachInteraction?.(tab, saved.replayer) ?? (() => {});
        opts.container.dataset.mirrorState = "live";
        applyViewportLayout();
        awaitCatchUp(tab);
        return;
      }
      if (state?.tab === tab) {
        if (parked.canPark(state)) awaitCatchUp(tab);
        return;
      }
      // The gateway answers an activated tab with its snapshot, and the page in view stays until
      // that replaces it. It can no longer be used, as input would reach the tab being left.
      if (state === null) renderStatus("Switching tabs…");
      else {
        const rtc = state.rtc;
        state.rtc = null;
        disposeRtc(state.tab, rtc);
        state.stage.inert = true;
        opts.container.dataset.switching = "true";
      }
      switchTimer = setTimeout(() => {
        switchTimer = null;
        delete opts.container.dataset.switching;
        if (sync.activeTab !== tab || state?.tab === tab) return;
        setAside("Switching tabs…");
        // Already set when the gateway has answered and its snapshot is on the way.
        requestFreshSnapshot(tab, "tab selected");
      }, TAB_SWITCH_WAIT_MS);
    },
    getActiveTab: () => sync.activeTab,
    getIframe: () => state?.replayer.iframe ?? null,
    getReplayer: () => state?.replayer ?? null,
    observeRtt: (rttMs) => clock.observeRtt(rttMs),
    refreshViewportLayout: applyViewportLayout,
    keepTabs: (tabs) => parked.keep(tabs),
    teardown() {
      clearReconnectTimer();
      endTabSwitch();
      parked.dropAll();
      pendingRestore = null;
      discard("Mirror stopped.");
      setSnapshotPending(false);
      delete opts.container.dataset.connectionStale;
      sync.activeTab = null;
    },
  };
}

export function fitViewportScale(
  viewportWidth: number,
  viewportHeight: number,
  availableWidth: number,
  availableHeight: number,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return 1;
  }
  return Math.min(availableWidth / viewportWidth, availableHeight / viewportHeight);
}

export function extractSnapshotViewport(
  snapshot: Pick<Snapshot, "data">,
): { w: number; h: number } | null {
  for (const event of snapshot.data) {
    if (event.type !== EventType.Meta) continue;
    if (event.data.width > 0 && event.data.height > 0) {
      return { w: event.data.width, h: event.data.height };
    }
  }
  return null;
}
