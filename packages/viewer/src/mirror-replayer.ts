/**
 * One Replayer generation: building it from a snapshot into its own stage, and destroying it with
 * its WebRTC lane, interaction listeners and media repair. mirror.ts decides when; this file only
 * knows how.
 */
import { Replayer } from "@rrweb/replay";
import {
  EventType,
  IncrementalSource,
  type Down,
  type eventWithTime,
  type TabId,
  MIRROR_RECORD_CLASSES,
} from "@mirror/protocol";
import type { ServerClock } from "./clock";
import type { EventPipeline } from "./pipeline";
import type { RebuildRestoreHooks, RebuildRestorePoint } from "./rebuild-restore";
import { enforceReplayCursorPassthrough, REPLAY_CURSOR_PASSTHROUGH_RULE } from "./replay-cursor";
import {
  createCanvasRtc,
  type CanvasRtc,
  type CanvasRtcMessage,
  type CanvasRtcOptions,
} from "./media/canvas-rtc";
import { REPLAY_ANCHOR_RULES } from "./replay-anchors";
import { closeReplayDocument } from "./replay-document";
import { REPLAY_THUMBNAIL_RULES } from "./replay-thumbnails";
import { createCanvasCompositor, type CanvasCompositor } from "./media/canvas";
import { workingMarkReplay } from "./working-mark";
import { remoteFocusReplay } from "./remote-focus";

const REPLAY_TEXT_FOCUS_RULE = `
  @media (forced-colors: none) {
    :is(textarea, [contenteditable]:not([contenteditable="false"]),
        input:not([type]), input:is([type="text"], [type="search"], [type="email"],
        [type="tel"], [type="url"], [type="password"], [type="number"])):focus {
      outline: none !important;
    }
  }
`;

type Snapshot = Extract<Down, { t: "snapshot" }>;

export interface MirrorRtcOptions {
  send(tab: TabId, lane: string, payload: CanvasRtcMessage | { type: "close" }): void;
  requestCanvases?: boolean;
  create?: (options: CanvasRtcOptions) => CanvasRtc;
  createLane?: () => string;
  onError?: (error: unknown) => void;
}

export interface LiveRtc {
  lane: string;
  controller: CanvasRtc;
  hasMediaRequests(): boolean;
}

export interface LiveState {
  tab: TabId;
  epoch: number;
  nextSeq: number;
  /** Replay validity survives a socket reconnect. */
  needsSnapshot: boolean;
  viewport: { w: number; h: number } | null;
  replayer: Replayer;
  stage: HTMLDivElement;
  mount: HTMLDivElement;
  detachInteraction: () => void;
  detachMediaRestore: () => void;
  /** Ends what watchReplayer started for this generation. */
  detachReplayWatch: () => void;
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

export function isCanvasMutation(event: eventWithTime): boolean {
  return (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.CanvasMutation
  );
}

/** Closes a generation's WebRTC lane, telling the gateway first. */
export function disposeRtc(
  options: MirrorRtcOptions | undefined,
  tab: TabId,
  rtc: LiveRtc | null,
): void {
  if (rtc === null) return;
  try {
    options?.send(tab, rtc.lane, { type: "close" });
  } catch (error) {
    options?.onError?.(error);
  }
  rtc.controller.dispose();
}

/** Destroys a generation and removes its stage. */
export function destroyLive(rtcOptions: MirrorRtcOptions | undefined, live: LiveState): void {
  const rtc = live.rtc;
  live.rtc = null;
  disposeRtc(rtcOptions, live.tab, rtc);
  live.detachInteraction();
  live.detachMediaRestore();
  live.detachReplayWatch();
  try {
    live.replayer.destroy();
  } catch {
    // The stage is removed below even if rrweb's irreversible destroy encounters bad state.
  }
  live.stage.remove();
}

/**
 * Replays the interaction restore point once the snapshot's document exists. The returned cancel
 * hands back a point that was never applied.
 */
function armRestore(
  restoreHooks: RebuildRestoreHooks,
  replayer: Replayer,
  restorePoint: RebuildRestorePoint | null,
  hasFullSnapshot: boolean,
  unused: (restorePoint: RebuildRestorePoint) => void,
): () => void {
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
    if (!restored) unused(restorePoint);
  };
}

export interface BuildLiveOptions {
  message: Snapshot;
  /** The new generation's stage, already in the container, and the Replayer's root inside it. */
  stage: HTMLDivElement;
  mount: HTMLDivElement;
  viewport: LiveState["viewport"];
  document: Document;
  pipeline: EventPipeline;
  clock: ServerClock;
  now(): number;
  rtc: MirrorRtcOptions | undefined;
  restoreHooks: RebuildRestoreHooks;
  restorePoint: RebuildRestorePoint | null;
  /** The restore point was never applied (the build failed first). */
  onRestoreUnused(restorePoint: RebuildRestorePoint): void;
  onBufferApplied?(bufferMs: number): void;
  /**
   * Called with the Replayer before it casts anything, for listeners that must see the snapshot
   * being built; what it returns is called when the generation ends.
   */
  watchReplayer?(replayer: Replayer): () => void;
}

export type BuildResult =
  | { ok: true; live: LiveState }
  /** Everything the attempt created is gone, including `mount`. */
  | { ok: false; detail: string };

/** Builds a live Replayer generation from a snapshot. */
export function buildLive(options: BuildLiveOptions): BuildResult {
  const { message, mount, pipeline, clock } = options;
  const initialEvents: eventWithTime[] = [];
  const initialCanvas: eventWithTime[] = [];
  let replayer: Replayer | null = null;
  let rtc: LiveRtc | null = null;
  let cancelRestore = () => {};
  let mediaRestore: ReturnType<typeof armLiveMediaRestore> | null = null;
  let unwatch = () => {};
  try {
    // Sampled canvases have their own compositor. Never send canvas commands to rrweb.
    for (const event of message.data) {
      if (isCanvasMutation(event)) initialCanvas.push(event);
      else {
        const processed = pipeline.run(event, { tab: message.tab, nowMs: options.now() });
        if (processed !== null) initialEvents.push(processed);
      }
    }
    if (options.rtc !== undefined) {
      const rtcOptions = options.rtc;
      const lane = rtcOptions.createLane?.() ?? createRtcLane();
      let mediaRequested = false;
      const controller = (rtcOptions.create ?? createCanvasRtc)({
        document: options.document,
        send: (payload) => {
          if (payload.type === "video" || payload.type === "canvas") mediaRequested = true;
          options.rtc?.send(message.tab, lane, payload);
        },
        ...(rtcOptions.requestCanvases === undefined
          ? {}
          : { requestCanvases: rtcOptions.requestCanvases }),
        onError: rtcOptions.onError,
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
        REPLAY_TEXT_FOCUS_RULE,
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
      plugins: [
        closeNestedReplayDocuments(),
        workingMarkReplay(),
        remoteFocusReplay(),
        ...(rtc === null ? [] : [rtc.controller.replayPlugin]),
      ],
    });

    // rrweb opens the replay document during rebuild. Closing it starts SVG animation timelines;
    // the page's doctype goes to the parser first so it keeps the page's standards mode.
    const iframe = replayer.iframe;
    replayer.on("fullsnapshot-rebuilded", () => closeReplayDocument(iframe.contentDocument));
    cancelRestore = armRestore(
      options.restoreHooks,
      replayer,
      options.restorePoint,
      initialEvents.some((event) => event.type === EventType.FullSnapshot),
      options.onRestoreUnused,
    );
    mediaRestore = armLiveMediaRestore(replayer);
    unwatch = options.watchReplayer?.(replayer) ?? (() => {});

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
    options.onBufferApplied?.(clock.liveBufferMs());
    mediaRestore.restoreAfterStartLive();
  } catch (cause) {
    cancelRestore();
    mediaRestore?.detach();
    unwatch();
    disposeRtc(options.rtc, message.tab, rtc);
    rtc = null;
    try {
      replayer?.destroy();
    } catch {
      // mount.remove() below is the final cleanup path.
    }
    mount.remove();
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  }

  const built = replayer;
  const builtRtc = rtc;
  const live: LiveState = {
    tab: message.tab,
    epoch: message.epoch,
    nextSeq: message.seq + 1,
    needsSnapshot: false,
    viewport: options.viewport,
    replayer: built,
    stage: options.stage,
    mount,
    detachInteraction: () => {},
    detachMediaRestore: mediaRestore.detach,
    detachReplayWatch: unwatch,
    rtc: builtRtc,
    canvas: createCanvasCompositor(
      { getReplayer: () => built },
      {
        isLive: (id) => builtRtc?.controller.isLive(id) === true,
        onError: (error) => console.warn("mirror canvas picture failed", error),
      },
    ),
  };
  for (const event of initialCanvas) void live.canvas.apply(event);
  return { ok: true, live };
}

/**
 * rrweb builds a frame's document with document.open() too (attachDocumentToIframe), and leaves
 * it open: quirks mode whatever the page's doctype, and SVG animations that never start. The
 * document's own onBuild comes once its nodes are all in place; the top document is closed on
 * "fullsnapshot-rebuilded" instead.
 */
export function closeNestedReplayDocuments() {
  return {
    onBuild(node: { nodeType: number }, { replayer }: { replayer: Pick<Replayer, "iframe"> }) {
      if (node.nodeType !== 9 || node === replayer.iframe.contentDocument) return;
      try {
        closeReplayDocument(node as Document);
      } catch {
        // A frame on its way out: its document is of no further use.
      }
    },
  };
}

function createRtcLane(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}
