/**
 * Sandboxed rrweb mirror and stream-order state machine.
 *
 * The viewer never repairs a divergent document. Any gap or replay failure discards the entire
 * Replayer (including its iframe) when a fresh snapshot is ready (D10). The last known-good
 * iframe remains visible during recovery and is atomically replaced, so recovery never exposes
 * a white/status-only interval.
 */
import { Replayer } from "@rrweb/replay";
import {
  EventType,
  IncrementalSource,
  type Down,
  type eventWithTime,
  type ResumeCursor,
  type TabId,
  MIRROR_RECORD_CLASSES,
} from "@mirror/protocol";
import { createServerClock, type ServerClock } from "./clock";
import type { EventPipeline } from "./pipeline";
import {
  createRebuildRestoreHooks,
  type RebuildRestoreHooks,
  type RebuildRestorePoint,
} from "./rebuild-restore";
import { enforceReplayCursorPassthrough, REPLAY_CURSOR_PASSTHROUGH_RULE } from "./replay-cursor";
import {
  createCanvasRtc,
  type CanvasRtc,
  type CanvasRtcMessage,
  type CanvasRtcOptions,
} from "./media/canvas-rtc";
import { REPLAY_ANCHOR_RULES } from "./replay-anchors";
import { REPLAY_THUMBNAIL_RULES } from "./replay-thumbnails";

/** How long the page in view waits for the snapshot of the tab that is replacing it. */
const TAB_SWITCH_WAIT_MS = 1_500;

type Snapshot = Extract<Down, { t: "snapshot" }>;
type Delta = Extract<Down, { t: "delta" }>;

export interface Mirror {
  handle(msg: Down): void;
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
  /** Recompute follower fit scaling after the outer viewer changes size. */
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
  onSnapshotApplied?(snapshot: Snapshot): void;
  /** Report the buffer actually installed in this Replayer, rather than a future target. */
  onBufferApplied?(bufferMs: number): void;
  /** WebRTC is created and destroyed with each Replayer generation. */
  rtc?: MirrorRtcOptions;
  /** How many tabs left behind stay built, hidden, so that returning to them is immediate. */
  parkedTabs?: number;
}

export interface MirrorRtcOptions {
  send(tab: TabId, lane: string, payload: CanvasRtcMessage | { type: "close" }): void;
  create?: (options: CanvasRtcOptions) => CanvasRtc;
  createLane?: () => string;
  onError?: (error: unknown) => void;
}

interface LiveRtc {
  lane: string;
  controller: CanvasRtc;
}

interface LiveState {
  tab: TabId;
  epoch: number;
  lastSeq: number;
  replayer: Replayer;
  stage: HTMLDivElement;
  mount: HTMLDivElement;
  detachInteraction: () => void;
  detachMediaRestore: () => void;
  rtc: LiveRtc | null;
  bufferMs: number;
}

interface MediaRestoreState {
  target: HTMLMediaElement;
  shouldPlay: boolean;
  currentTime: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  loop: boolean;
}

function captureMediaState(iframe: HTMLIFrameElement): MediaRestoreState[] {
  const document = iframe.contentDocument;
  if (document === null) return [];
  return Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video"), (target) => ({
    target,
    shouldPlay: !target.paused,
    currentTime: target.currentTime,
    playbackRate: target.playbackRate,
    volume: target.volume,
    muted: target.muted,
    loop: target.loop,
  }));
}

function restoreMediaState(states: readonly MediaRestoreState[]): void {
  for (const state of states) {
    const { target } = state;
    // A malformed or not-yet-ready media resource must not turn a best-effort live resume into
    // snapshot recovery. Apply properties independently so muted autoplay still gets its chance.
    try {
      target.muted = state.muted;
    } catch {}
    try {
      target.loop = state.loop;
    } catch {}
    try {
      target.volume = state.volume;
    } catch {}
    try {
      target.playbackRate = state.playbackRate;
    } catch {}
    try {
      target.currentTime = state.currentTime;
    } catch {}
    if (!state.shouldPlay) continue;
    try {
      void target.play().catch(() => {
        // Audible autoplay can be rejected without a user gesture; retain the recorded mute state.
      });
    } catch {
      // Some media implementations can reject play() synchronously.
    }
  }
}

function armLiveMediaRestore(replayer: Replayer): {
  captureAfterSynchronousCast(): void;
  restoreAfterStartLive(): void;
  detach(): void;
} {
  let live = false;
  let fullSnapshotBuilt = false;
  let states: MediaRestoreState[] = [];
  const capture = () => {
    fullSnapshotBuilt = true;
    if (!live) states = captureMediaState(replayer.iframe);
  };
  // Keep this independent of armRestore(): media repair is unconditional, while interaction
  // restore is a conditional one-shot. Full snapshots cast after TO_LIVE need no repair because
  // rrweb's MediaManager already sees a non-paused player and applies their media state directly.
  replayer.on("fullsnapshot-rebuilded", capture);
  return {
    captureAfterSynchronousCast() {
      // A join buffer may contain media-interaction deltas after the FullSnapshot. Capture once
      // more after every synchronous event is cast so a later legitimate pause/play wins.
      if (fullSnapshotBuilt && !live) states = captureMediaState(replayer.iframe);
    },
    restoreAfterStartLive() {
      live = true;
      restoreMediaState(states);
      states = [];
    },
    detach() {
      live = true;
      states = [];
      replayer.off("fullsnapshot-rebuilded", capture);
    },
  };
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
  let activeTab: TabId | null = null;
  let state: LiveState | null = null;
  let resyncRequested = false;
  let switchTimer: ReturnType<typeof setTimeout> | null = null;
  const parkedLimit = opts.parkedTabs ?? 0;
  /** Oldest first. Never moved in the DOM, which would reload their iframes. */
  const parked = new Map<TabId, LiveState>();
  /** A page back in view until the gateway's catch-up for its tab, which it mostly already has. */
  let catchUp: { answered: boolean; snapshotSeen: boolean } | null = null;
  let pendingRestore: RebuildRestorePoint | null = null;
  let viewerId: string | null = null;
  let isDriver = true;
  let remoteViewport: { w: number; h: number } | null = null;

  const disposeRtc = (tab: TabId, rtc: LiveRtc | null) => {
    if (rtc === null) return;
    try {
      opts.rtc?.send(tab, rtc.lane, { type: "close" });
    } catch (error) {
      opts.rtc?.onError?.(error);
    }
    rtc.controller.dispose();
  };

  const applyViewportLayout = () => {
    const live = state;
    if (live === null) return;
    live.mount.dataset.viewportRole = isDriver ? "driver" : "follower";
    opts.container.dataset.viewportRole = isDriver ? "driver" : "follower";
    if (isDriver || remoteViewport === null) {
      live.mount.style.width = "";
      live.mount.style.height = "";
      live.mount.style.transform = "";
      return;
    }
    const scale = fitViewportScale(
      remoteViewport.w,
      remoteViewport.h,
      opts.container.clientWidth,
      opts.container.clientHeight,
    );
    live.mount.style.width = `${remoteViewport.w}px`;
    live.mount.style.height = `${remoteViewport.h}px`;
    live.mount.style.transform = `scale(${scale})`;
  };

  const captureInteraction = (live: LiveState | null = state) => {
    if (live !== null) pendingRestore = restoreHooks.capture(live.replayer.iframe);
  };

  /** Clears the visible surface, and only that: hidden pages have to stay where they are. */
  const clearForeground = (keep?: Element) => {
    const hidden = new Set<Element>([...parked.values()].map((live) => live.stage));
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

  const destroyLive = (live: LiveState) => {
    const rtc = live.rtc;
    live.rtc = null;
    disposeRtc(live.tab, rtc);
    live.detachInteraction();
    live.detachMediaRestore();
    try {
      live.replayer.destroy();
    } catch {
      // The stage is removed below even if rrweb's irreversible destroy encounters bad state.
    }
    live.stage.remove();
  };

  const dropParked = (tab: TabId) => {
    const live = parked.get(tab);
    if (live === undefined) return;
    parked.delete(tab);
    destroyLive(live);
  };

  /** Canvases and video arrive over WebRTC, which ends with the view, so they cannot come back. */
  const canPark = (live: LiveState): boolean => {
    if (parkedLimit < 1) return false;
    try {
      const page = live.replayer.iframe.contentDocument;
      return page !== null && page !== undefined && page.querySelector("canvas,video") === null;
    } catch {
      return false;
    }
  };

  const park = (live: LiveState) => {
    const rtc = live.rtc;
    live.rtc = null;
    disposeRtc(live.tab, rtc);
    live.detachInteraction();
    live.detachInteraction = () => {};
    live.stage.inert = true;
    live.stage.dataset.parked = "true";
    dropParked(live.tab);
    parked.set(live.tab, live);
    for (const tab of parked.keys()) {
      if (parked.size <= parkedLimit) break;
      dropParked(tab);
    }
  };

  /** Takes the page in view off the screen, keeping it if it can be kept. */
  const setAside = (message: string) => {
    const live = state;
    if (live === null || !canPark(live)) {
      discard(message);
      return;
    }
    state = null;
    opts.pipeline.reset();
    park(live);
    renderStatus(message);
  };

  const endTabSwitch = () => {
    if (switchTimer !== null) clearTimeout(switchTimer);
    switchTimer = null;
    catchUp = null;
    delete opts.container.dataset.switching;
    if (state !== null) state.stage.inert = false;
  };

  /** The page is shown at once, but input waits for the gateway to say what it has missed. */
  const awaitCatchUp = (tab: TabId) => {
    catchUp = { answered: false, snapshotSeen: false };
    if (state !== null) state.stage.inert = true;
    switchTimer = setTimeout(() => {
      switchTimer = null;
      const waiting = catchUp;
      if (state !== null) state.stage.inert = false;
      if (waiting === null || waiting.snapshotSeen || waiting.answered) return;
      catchUp = null;
      requestFreshSnapshot(tab, "tab selected");
    }, TAB_SWITCH_WAIT_MS);
  };

  const settleCatchUp = (message: Snapshot) => {
    if (switchTimer !== null) clearTimeout(switchTimer);
    switchTimer = null;
    if (catchUp !== null) catchUp.snapshotSeen = true;
    if (state !== null) state.stage.inert = false;
    remoteViewport = extractSnapshotViewport(message) ?? remoteViewport;
    applyViewportLayout();
    opts.onSnapshotApplied?.(message);
  };

  const requestFreshSnapshot = (tab: TabId, reason: string) => {
    if (resyncRequested) return;
    resyncRequested = true;
    opts.container.dataset.resyncPending = "true";
    opts.requestResync(tab, reason);
  };

  const runPipeline = (tab: TabId, event: eventWithTime): eventWithTime | null => {
    // The interactive iframe option also enables rrweb's canvas lane. Preserve disabled
    // canvas-command replay while the inherited CSP blocks website scripts and subframe URLs.
    if (
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.CanvasMutation
    )
      return null;
    return opts.pipeline.run(event, { tab, nowMs: now() });
  };

  const addEvent = (live: LiveState, event: eventWithTime): boolean => {
    const processed = runPipeline(live.tab, event);
    if (processed === null) return true;
    try {
      live.replayer.addEvent(processed);
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      requestFreshSnapshot(live.tab, `replayer.addEvent: ${detail}`);
      return false;
    }
  };

  const armRestore = (
    replayer: Replayer,
    restorePoint: RebuildRestorePoint | null,
    hasFullSnapshot: boolean,
  ): (() => void) => {
    if (restorePoint === null) return () => {};
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      replayer.off("fullsnapshot-rebuilded", restore);
      restoreHooks.restore(replayer.iframe, restorePoint);
    };
    if (hasFullSnapshot) replayer.on("fullsnapshot-rebuilded", restore);
    else restore();
    return () => {
      replayer.off("fullsnapshot-rebuilded", restore);
      if (!restored) pendingRestore = restorePoint;
    };
  };

  const rebuild = (message: Snapshot) => {
    endTabSwitch();
    if (message.reason === "nav" || (state !== null && state.tab !== message.tab)) {
      pendingRestore = null;
    } else captureInteraction();
    const restorePoint = pendingRestore;
    pendingRestore = null;
    // The teardown and replacement happen in one synchronous websocket task. Browsers cannot
    // paint or run the chaos sampler between these operations, so the last good frame remains on
    // screen until this task commits the new iframe without overlapping two rrweb instances.
    if (state !== null && state.tab !== message.tab) setAside("Building the mirror…");
    else discard("Building the mirror…");
    dropParked(message.tab);
    activeTab = message.tab;
    const stage = opts.container.ownerDocument.createElement("div");
    stage.className = "mirror-stage";
    const mount = opts.container.ownerDocument.createElement("div");
    mount.className = "mirror-replayer";
    stage.appendChild(mount);
    clearForeground();
    opts.container.appendChild(stage);
    opts.container.dataset.mirrorState = "building";

    const initialEvents: eventWithTime[] = [];
    remoteViewport = extractSnapshotViewport(message) ?? remoteViewport;
    for (const event of message.data) {
      const processed = runPipeline(message.tab, event);
      if (processed !== null) initialEvents.push(processed);
    }

    let replayer: Replayer | null = null;
    let rtc: LiveRtc | null = null;
    let cancelRestore = () => {};
    let mediaRestore: ReturnType<typeof armLiveMediaRestore> | null = null;
    try {
      if (opts.rtc !== undefined) {
        const lane = opts.rtc.createLane?.() ?? createRtcLane();
        const controller = (opts.rtc.create ?? createCanvasRtc)({
          document: opts.container.ownerDocument,
          send: (payload) => opts.rtc?.send(message.tab, lane, payload),
          onError: opts.rtc.onError,
        });
        rtc = { lane, controller };
      }
      replayer = new Replayer(initialEvents, {
        root: mount,
        liveMode: true,
        blockClass: MIRROR_RECORD_CLASSES.blockClass,
        // main.tsx installs script-src 'none' before any replay frame is created. This
        // rrweb option enables WebKit input callbacks in that CSP-protected document.
        UNSAFE_replayCanvas: true,
        mouseTail: false,
        // rrweb inserts these rules into the replay document again after every FullSnapshot.
        // Keep replay cursor chrome visible, but permanently remove it from hit testing.
        insertStyleRules: [
          REPLAY_CURSOR_PASSTHROUGH_RULE,
          ...REPLAY_THUMBNAIL_RULES,
          ...REPLAY_ANCHOR_RULES,
        ],
        // Old join-buffer deltas are applied synchronously. rrweb's virtual-DOM optimization
        // otherwise waits for a replay Flush event that live addEvent() does not emit.
        useVirtualDom: false,
        // The play()->pause()->startLive() bridge below is only a synchronous-cast-to-live
        // state hop (pause() is the sole state rrweb accepts TO_LIVE from). rrweb's default
        // pauseAnimation freezes CSS animations via `html.rrweb-paused *{animation-play-state:
        // paused}`, re-injected on every FullSnapshot while not in its internal "playing"
        // state — which includes our permanent live state. That blanks any site whose content
        // is revealed by a CSS entrance animation (opacity 0->1). This mirror never exposes a
        // paused/scrub UI, so keep author animations live.
        pauseAnimation: false,
        ...(rtc === null ? {} : { plugins: [rtc.controller.replayPlugin] }),
      });

      cancelRestore = armRestore(
        replayer,
        restorePoint,
        initialEvents.some((event) => event.type === EventType.FullSnapshot),
      );
      mediaRestore = armLiveMediaRestore(replayer);

      const sandboxTokens = Array.from(replayer.iframe.sandbox);
      if (
        sandboxTokens.length !== 2 ||
        !sandboxTokens.includes("allow-same-origin") ||
        !sandboxTokens.includes("allow-scripts")
      ) {
        throw new Error(`unexpected replay sandbox: ${sandboxTokens.join(" ")}`);
      }
      // rrweb's replay-only default disables iframe scrolling and hit testing. Phase-1 installs
      // input listeners inside that document, so the live mirror must accept native interaction.
      replayer.enableInteract();
      enforceReplayCursorPassthrough(replayer.iframe);

      // Cast the snapshot synchronously before entering live mode. Buffered deltas then land
      // immediately if old, while live-tail events retain the configured jitter window.
      if (initialEvents.length > 0) {
        const firstTs = initialEvents[0]!.timestamp;
        const lastTs = initialEvents[initialEvents.length - 1]!.timestamp;
        replayer.play(Math.max(0, lastTs - firstTs + 1));
        mediaRestore.captureAfterSynchronousCast();
        replayer.pause();
      }
      replayer.startLive(clock.liveBaseline());
      opts.onBufferApplied?.(clock.liveBufferMs());
      mediaRestore.restoreAfterStartLive();
    } catch (cause) {
      cancelRestore();
      mediaRestore?.detach();
      disposeRtc(message.tab, rtc);
      rtc = null;
      try {
        replayer?.destroy();
      } catch {
        // mount.remove() below is the final cleanup path.
      }
      mount.remove();
      renderStatus("Mirror recovery requested…");
      resyncRequested = true;
      opts.container.dataset.resyncPending = "true";
      const detail = cause instanceof Error ? cause.message : String(cause);
      opts.requestResync(message.tab, `snapshot replay: ${detail}`);
      return;
    }

    state = {
      tab: message.tab,
      epoch: message.epoch,
      lastSeq: message.seq,
      replayer,
      stage,
      mount,
      detachInteraction: () => {},
      detachMediaRestore: mediaRestore.detach,
      rtc,
      bufferMs: clock.liveBufferMs(),
    };
    state.detachInteraction = opts.attachInteraction?.(message.tab, replayer) ?? (() => {});
    applyViewportLayout();
    resyncRequested = false;
    delete opts.container.dataset.resyncPending;
    opts.container.dataset.mirrorState = "live";
    opts.onSnapshotApplied?.(message);
  };

  const applyDelta = (message: Delta) => {
    if (resyncRequested) return;
    const live = state;
    if (live === null) {
      if (activeTab === null) activeTab = message.tab;
      requestFreshSnapshot(message.tab, "delta before snapshot");
      return;
    }
    if (message.tab !== live.tab) return;
    if (message.epoch !== live.epoch) {
      requestFreshSnapshot(message.tab, `epoch gap: expected ${live.epoch}, got ${message.epoch}`);
      return;
    }

    // Frozen protocol assumption: delta.seq is the first event's per-tab sequence.
    const expectedSeq = live.lastSeq + 1;
    let seq = message.seq;
    let data = message.data;
    if (catchUp !== null) {
      // A catch-up repeats the tab's whole buffer, and this page has already applied the start.
      const applied = expectedSeq - seq;
      if (applied > 0) {
        if (applied >= data.length && data.length > 0) return;
        data = data.slice(applied);
        seq = expectedSeq;
      }
      if (catchUp.snapshotSeen) catchUp = null;
    }
    if (seq !== expectedSeq || data.length === 0) {
      requestFreshSnapshot(
        message.tab,
        data.length === 0 ? "empty delta" : `seq gap: expected ${expectedSeq}, got ${seq}`,
      );
      return;
    }

    for (const event of data) {
      if (!addEvent(live, event)) return;
    }
    live.lastSeq = seq + data.length - 1;
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
          applyViewportLayout();
          break;
        case "driver":
          isDriver = viewerId !== null && msg.viewerId === viewerId;
          applyViewportLayout();
          break;
        case "snapshot":
          if (activeTab === null || msg.tab === activeTab) {
            if (catchUp !== null && state?.tab === msg.tab && msg.epoch === state.epoch) {
              settleCatchUp(msg);
            } else if (
              state === null ||
              state.tab !== msg.tab ||
              msg.epoch > state.epoch ||
              resyncRequested
            ) {
              rebuild(msg);
            }
          }
          break;
        case "delta":
          if (activeTab === null || msg.tab === activeTab) applyDelta(msg);
          break;
        case "resync":
          if (catchUp !== null && state?.tab === msg.tab) {
            catchUp.answered = true;
          } else if (activeTab === null || msg.tab === activeTab) {
            activeTab = msg.tab;
            resyncRequested = true;
            opts.container.dataset.resyncPending = "true";
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
    connectionLost() {
      for (const tab of [...parked.keys()]) dropParked(tab);
      endTabSwitch();
      if (state?.rtc !== null && state !== null) {
        const rtc = state.rtc;
        state.rtc = null;
        disposeRtc(state.tab, rtc);
      }
      if (state === null) renderStatus("Connection lost. Reconnecting…");
      else opts.container.dataset.connectionStale = "true";
      resyncRequested = false;
    },
    connectionRestored(resumed = false) {
      delete opts.container.dataset.connectionStale;
      if (resumed && state !== null && state.tab === activeTab) return;
      if (activeTab !== null) requestFreshSnapshot(activeTab, "ws reconnect");
    },
    resumeCursor() {
      if (state === null || resyncRequested || state.tab !== activeTab) return null;
      return { tab: state.tab, epoch: state.epoch, nextSeq: state.lastSeq + 1 };
    },
    selectTab(tab) {
      if (tab === activeTab) return;
      activeTab = tab;
      pendingRestore = null;
      resyncRequested = false;
      endTabSwitch();
      let saved = parked.get(tab);
      // Picture mode clears the shared surface, and an iframe does not survive leaving the page.
      if (saved?.stage.isConnected === false) {
        dropParked(tab);
        saved = undefined;
      }
      if (saved !== undefined) {
        parked.delete(tab);
        const leaving = state;
        state = saved;
        opts.pipeline.reset();
        if (leaving !== null) {
          if (canPark(leaving)) park(leaving);
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
        if (canPark(state)) awaitCatchUp(tab);
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
        if (activeTab !== tab || state?.tab === tab) return;
        setAside("Switching tabs…");
        // Already set when the gateway has answered and its snapshot is on the way.
        requestFreshSnapshot(tab, "tab selected");
      }, TAB_SWITCH_WAIT_MS);
    },
    getActiveTab: () => activeTab,
    getIframe: () => state?.replayer.iframe ?? null,
    getReplayer: () => state?.replayer ?? null,
    observeRtt: (rttMs) => clock.observeRtt(rttMs),
    refreshViewportLayout: applyViewportLayout,
    keepTabs(tabs) {
      for (const tab of [...parked.keys()]) if (!tabs.includes(tab)) dropParked(tab);
    },
    teardown() {
      endTabSwitch();
      for (const tab of [...parked.keys()]) dropParked(tab);
      pendingRestore = null;
      discard("Mirror stopped.");
      delete opts.container.dataset.resyncPending;
      delete opts.container.dataset.connectionStale;
      activeTab = null;
    },
  };
}

function createRtcLane(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
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
