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
import { REPLAY_EDITING_APPEARANCE } from "./input/appearance";
import { createCanvasCompositor, type CanvasCompositor } from "./media/canvas";
import { workingMarkReplay } from "./working-mark";

/** How long the page in view waits for the snapshot of the tab that is replacing it. */
const TAB_SWITCH_WAIT_MS = 1_500;

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
  requestCanvases?: boolean;
  create?: (options: CanvasRtcOptions) => CanvasRtc;
  createLane?: () => string;
  onError?: (error: unknown) => void;
}

interface LiveRtc {
  lane: string;
  controller: CanvasRtc;
  hasMediaRequests(): boolean;
}

interface LiveState {
  tab: TabId;
  epoch: number;
  nextSeq: number;
  /** Replay validity survives a socket reconnect. */
  needsSnapshot: boolean;
  viewport: ReturnType<typeof extractSnapshotViewport>;
  replayer: Replayer;
  stage: HTMLDivElement;
  mount: HTMLDivElement;
  detachInteraction: () => void;
  detachMediaRestore: () => void;
  rtc: LiveRtc | null;
  /** Paints sampled canvas pictures; the replayer itself is never handed canvas commands. */
  canvas: CanvasCompositor;
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

function isCanvasMutation(event: eventWithTime): boolean {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.CanvasMutation
  );
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
  let snapshotPending = false; // A snapshot is expected on this connection.
  let switchTimer: ReturnType<typeof setTimeout> | null = null;
  const parkedLimit = opts.parkedTabs ?? 0;
  /** Oldest first. Never moved in the DOM, which would reload their iframes. */
  const parked = new Map<TabId, LiveState>();
  /** A page back in view until the gateway's catch-up for its tab, which it mostly already has. */
  let catchUp: "waiting" | "answered" | "snapshot" | null = null;
  let pendingRestore: RebuildRestorePoint | null = null;
  let viewerId: string | null = null;
  let isDriver = true;
  let viewportLimit: Extract<Down, { t: "hello" }>["viewportLimit"];

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
    if (parkedLimit < 1 || live.needsSnapshot) return false;
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

  const clearSwitchTimer = () => {
    if (switchTimer !== null) clearTimeout(switchTimer);
    switchTimer = null;
  };

  const endTabSwitch = () => {
    clearSwitchTimer();
    catchUp = null;
    delete opts.container.dataset.switching;
    if (state !== null) state.stage.inert = state.needsSnapshot;
  };

  /** The page is shown at once, but input waits for the gateway to say what it has missed. */
  const awaitCatchUp = (tab: TabId) => {
    catchUp = "waiting";
    if (state !== null) state.stage.inert = true;
    switchTimer = setTimeout(() => {
      switchTimer = null;
      if (catchUp !== "waiting") return;
      catchUp = null;
      requestFreshSnapshot(tab, "tab selected");
    }, TAB_SWITCH_WAIT_MS);
  };

  const setSnapshotPending = (pending: boolean) => {
    snapshotPending = pending;
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
    if (snapshotPending) return;
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
    const viewport = state?.tab === message.tab ? state.viewport : null;
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
    const initialCanvas: eventWithTime[] = [];
    let replayer: Replayer | null = null;
    let rtc: LiveRtc | null = null;
    let cancelRestore = () => {};
    let mediaRestore: ReturnType<typeof armLiveMediaRestore> | null = null;
    try {
      // Sampled canvases have their own compositor. Never send canvas commands to rrweb.
      for (const event of message.data) {
        if (isCanvasMutation(event)) initialCanvas.push(event);
        else {
          const processed = opts.pipeline.run(event, { tab: message.tab, nowMs: now() });
          if (processed !== null) initialEvents.push(processed);
        }
      }
      if (opts.rtc !== undefined) {
        const lane = opts.rtc.createLane?.() ?? createRtcLane();
        let mediaRequested = false;
        const controller = (opts.rtc.create ?? createCanvasRtc)({
          document: opts.container.ownerDocument,
          send: (payload) => {
            if (payload.type === "video" || payload.type === "canvas") mediaRequested = true;
            opts.rtc?.send(message.tab, lane, payload);
          },
          ...(opts.rtc.requestCanvases === undefined
            ? {}
            : { requestCanvases: opts.rtc.requestCanvases }),
          onError: opts.rtc.onError,
        });
        rtc = { lane, controller, hasMediaRequests: () => mediaRequested };
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
          REPLAY_EDITING_APPEARANCE,
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
        plugins: [workingMarkReplay(), ...(rtc === null ? [] : [rtc.controller.replayPlugin])],
      });

      // rrweb opens the replay document during rebuild. Closing it starts SVG animation timelines.
      const iframe = replayer.iframe;
      replayer.on("fullsnapshot-rebuilded", () => iframe.contentDocument?.close());
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
      setSnapshotPending(false);
      const detail = cause instanceof Error ? cause.message : String(cause);
      requestFreshSnapshot(message.tab, `snapshot replay: ${detail}`);
      return;
    }

    state = {
      tab: message.tab,
      epoch: message.epoch,
      nextSeq: message.seq + 1,
      needsSnapshot: false,
      viewport,
      replayer,
      stage,
      mount,
      detachInteraction: () => {},
      detachMediaRestore: mediaRestore.detach,
      rtc,
      canvas: createCanvasCompositor(
        { getReplayer: () => replayer },
        {
          isLive: (id) => rtc?.controller.isLive(id) === true,
          onError: (error) => console.warn("mirror canvas picture failed", error),
        },
      ),
    };
    for (const event of initialCanvas) void state.canvas.apply(event);
    state.detachInteraction = opts.attachInteraction?.(message.tab, replayer) ?? (() => {});
    commitSnapshot(state, message);
  };

  const applyDelta = (message: Delta) => {
    if (snapshotPending) return;
    const live = state;
    if (live === null) {
      if (activeTab === null) activeTab = message.tab;
      requestFreshSnapshot(message.tab, "delta before snapshot");
      return;
    }
    if (message.tab !== live.tab || live.needsSnapshot) return;
    if (message.epoch !== live.epoch) {
      requestFreshSnapshot(message.tab, `epoch gap: expected ${live.epoch}, got ${message.epoch}`);
      return;
    }

    // Frozen protocol assumption: delta.seq is the first event's per-tab sequence.
    const expectedSeq = live.nextSeq;
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
      if (catchUp === "snapshot") catchUp = null;
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
    live.nextSeq = seq + data.length;
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
          if (activeTab === null || msg.tab === activeTab) {
            if (
              catchUp !== null &&
              state?.tab === msg.tab &&
              !state.needsSnapshot &&
              msg.epoch === state.epoch
            ) {
              clearSwitchTimer();
              catchUp = "snapshot";
              commitSnapshot(state, msg);
            } else if (
              state === null ||
              state.tab !== msg.tab ||
              msg.epoch > state.epoch ||
              state.needsSnapshot ||
              snapshotPending
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
            if (catchUp === "waiting") catchUp = "answered";
          } else if (activeTab === null || msg.tab === activeTab) {
            activeTab = msg.tab;
            awaitSnapshot(msg.tab);
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
      if (activeTab !== null) requestFreshSnapshot(activeTab, reason);
    },
    connectionLost() {
      for (const tab of [...parked.keys()]) dropParked(tab);
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
      if (resumed && state?.tab === activeTab && !state.needsSnapshot) return;
      if (activeTab !== null) requestFreshSnapshot(activeTab, "ws reconnect");
    },
    resumeCursor() {
      if (state === null || state.needsSnapshot || state.tab !== activeTab) return null;
      return { tab: state.tab, epoch: state.epoch, nextSeq: state.nextSeq };
    },
    selectTab(tab) {
      if (tab === activeTab) return;
      activeTab = tab;
      pendingRestore = null;
      setSnapshotPending(false);
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
      setSnapshotPending(false);
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
