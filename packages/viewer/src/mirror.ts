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
import { patchEditable } from "./editable-patch";
import { deepActiveElement } from "./input/keys";
import {
  buildLive,
  destroyLive as destroyGeneration,
  disposeRtc as disposeLane,
  isCanvasMutation,
  restoreContext,
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
/**
 * How long a snapshot asked for, or announced, may take before it is asked for again: the request
 * can be lost (a socket that was connecting), and so can the gateway's answer.
 */
export const SNAPSHOT_OVERDUE_MS = 10_000;
/** How long an editor's catch-up may take before the page is rebuilt instead. */
export const EDITABLE_PATCH_WAIT_MS = 5_000;
/** While the person is still typing, the editor is caught up this much later, this many times. */
export const EDITABLE_PATCH_RETRY_MS = 700;
const EDITABLE_PATCH_RETRIES = 8;
/** The replay's own marker: the live replay has applied everything the catch-up covers. */
const EDITABLE_PATCH_MARK = "mirror:editable-patch";

type Snapshot = Extract<Down, { t: "snapshot" }>;
type Delta = Extract<Down, { t: "delta" }>;

export interface Mirror {
  handle(msg: Down): void;
  recover(reason: string): void;
  /**
   * The focused editor of the replay went apart from the page's: bring just that editor back in
   * step (editable-patch.ts), keeping focus, caret and keyboard. Without a focused editor, or when
   * that cannot be done, the page is recovered as `recover` does.
   */
  reconcileEditable(reason: string): void;
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
  /**
   * Asks the gateway for this page alone to be caught up (an editor's catch-up); false when it
   * could not be sent. Without it, requestResync is used.
   */
  requestCatchUp?(tab: TabId, reason: string): boolean;
  /** The person typed so recently that the editor's text is still on its way to the page. */
  editableBusy?(): boolean;
  /** An editor was brought back in step in place: what held it apart is settled. */
  onEditablePatched?(): void;
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
  /** Asks again for a snapshot that is pending for too long. */
  let overdueTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRestore: RebuildRestorePoint | null = null;
  /** An editor waiting for its catch-up (reconcileEditable). */
  let editablePatch: {
    tab: TabId;
    nodeId: number;
    reason: string;
    timer: ReturnType<typeof setTimeout>;
    retries: number;
  } | null = null;
  let editablePatchMarks = 0;
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
    if (live !== null)
      pendingRestore = restoreHooks.capture(live.replayer.iframe, restoreContext(live.replayer));
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

  const clearOverdueTimer = () => {
    if (overdueTimer !== null) clearTimeout(overdueTimer);
    overdueTimer = null;
  };

  const armOverdueTimer = () => {
    clearOverdueTimer();
    overdueTimer = setTimeout(() => {
      overdueTimer = null;
      const tab = sync.activeTab;
      if (!sync.snapshotPending || tab === null) return;
      // Still pending: the request or its answer was lost. Without this the page would wait, inert
      // and ignoring every delta, until the connection itself was lost.
      opts.requestResync(tab, "snapshot overdue");
      armOverdueTimer();
    }, SNAPSHOT_OVERDUE_MS);
  };

  const setSnapshotPending = (pending: boolean) => {
    const was = sync.snapshotPending;
    sync.snapshotPending = pending;
    if (pending) opts.container.dataset.resyncPending = "true";
    else delete opts.container.dataset.resyncPending;
    if (!pending) clearOverdueTimer();
    else if (!was) armOverdueTimer();
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
    cancelEditablePatch();
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

  const cancelEditablePatch = () => {
    if (editablePatch !== null) clearTimeout(editablePatch.timer);
    editablePatch = null;
  };

  /** The editing host around the replay's focused element, with its rrweb id. */
  const focusedEditor = (live: LiveState): { host: HTMLElement; nodeId: number } | null => {
    const document = live.replayer.iframe.contentDocument;
    let host = document === null ? null : (deepActiveElement(document) as HTMLElement | null);
    if (host === null || host.isContentEditable !== true) return null;
    while ((host.parentElement as HTMLElement | null)?.isContentEditable === true)
      host = host.parentElement!;
    const nodeId = live.replayer.getMirror().getId(host);
    return nodeId < 0 ? null : { host, nodeId };
  };

  const reconcileEditable = (reason: string, retries = 0) => {
    const live = state;
    const tab = sync.activeTab;
    const editor =
      live === null ||
      tab === null ||
      live.tab !== tab ||
      live.needsSnapshot ||
      sync.snapshotPending ||
      sync.catchUp !== null
        ? null
        : focusedEditor(live);
    if (editor === null || tab === null) {
      cancelEditablePatch();
      if (sync.activeTab !== null) requestFreshSnapshot(sync.activeTab, reason);
      return;
    }
    if (editablePatch !== null) return;
    // Answered for this page alone, with the cached snapshot and the deltas since.
    if (opts.requestCatchUp?.(tab, reason) === false) {
      requestFreshSnapshot(tab, reason);
      return;
    }
    if (opts.requestCatchUp === undefined) opts.requestResync(tab, reason);
    editablePatch = {
      tab,
      nodeId: editor.nodeId,
      reason,
      retries,
      timer: setTimeout(() => {
        editablePatch = null;
        requestFreshSnapshot(tab, `${reason}: no catch-up`);
      }, EDITABLE_PATCH_WAIT_MS),
    };
  };

  /**
   * The catch-up for an editor: once the live replay has applied every event the catch-up covers,
   * the editor's content is taken from it. The rest of the page is the same in both.
   */
  const applyEditablePatch = (message: Snapshot) => {
    const live = state!;
    const pending = editablePatch!;
    cancelEditablePatch();
    // The page in view has applied exactly what the catch-up covers, or it is not comparable.
    if (message.seq !== live.nextSeq - 1) {
      rebuild(message);
      return;
    }
    const lastTs = message.data.at(-1)?.timestamp ?? 0;
    const replayer = live.replayer;
    const marker = {
      type: EventType.Custom,
      timestamp: lastTs,
      data: { tag: EDITABLE_PATCH_MARK, payload: ++editablePatchMarks },
    } as eventWithTime;
    const mark = editablePatchMarks;
    const onMark = (event: eventWithTime) => {
      if (event.type !== EventType.Custom || event.data.payload !== mark) return;
      replayer.off("custom-event", onMark as never);
      if (state !== live || sync.activeTab !== pending.tab) return;
      if (opts.editableBusy?.() === true) {
        // Text typed since is not in the catch-up: taking it now would take those keys away.
        if (pending.retries >= EDITABLE_PATCH_RETRIES) {
          requestFreshSnapshot(pending.tab, pending.reason);
          return;
        }
        setTimeout(() => {
          if (state === live) reconcileEditable(pending.reason, pending.retries + 1);
        }, EDITABLE_PATCH_RETRY_MS);
        return;
      }
      const patched = patchEditable({
        replayer,
        nodeId: pending.nodeId,
        events: message.data,
        host: opts.container,
      });
      if (patched) opts.onEditablePatched?.();
      else requestFreshSnapshot(pending.tab, `${pending.reason}: editor not patched`);
    };
    replayer.on("custom-event", onMark as never);
    replayer.addEvent(marker);
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
          if (editablePatch !== null && editablePatch.tab === msg.tab) {
            if (
              state?.tab === msg.tab &&
              state.epoch === msg.epoch &&
              !state.needsSnapshot &&
              !sync.snapshotPending &&
              sync.catchUp === null
            ) {
              applyEditablePatch(msg);
              break;
            }
            cancelEditablePatch();
          }
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
          // An editor's catch-up opens with this: the page in view stays as it is, usable.
          if (editablePatch !== null && editablePatch.tab === msg.tab && state?.tab === msg.tab)
            break;
          switch (resyncDecision(sync, state, msg.tab)) {
            case "catch-up-answered": {
              sync.catchUp = catchUpAnswered(sync.catchUp);
              // A hub with no snapshot cached answers with the resync alone, and its snapshot
              // follows when the page sends one. The page stays inert until a snapshot confirms
              // it: if none comes, ask for one rather than leave it so.
              clearSwitchTimer();
              const tab = msg.tab;
              switchTimer = setTimeout(() => {
                switchTimer = null;
                if (sync.catchUp !== "answered" || sync.activeTab !== tab) return;
                sync.catchUp = null;
                requestFreshSnapshot(tab, "catch-up without snapshot");
              }, RECONNECT_SNAPSHOT_WAIT_MS);
              break;
            }
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
      cancelEditablePatch();
      if (sync.activeTab !== null) requestFreshSnapshot(sync.activeTab, reason);
    },
    reconcileEditable: (reason) => reconcileEditable(reason),
    connectionLost() {
      cancelEditablePatch();
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
        // A request made while the socket was connecting was lost with it.
        if (sync.snapshotPending) {
          opts.requestResync(tab, "ws reconnect");
          return;
        }
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
      cancelEditablePatch();
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
      cancelEditablePatch();
      clearReconnectTimer();
      clearOverdueTimer();
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
