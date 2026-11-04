/**
 * Gateway side of the pixel fallback.
 * (Viewer half P2-PX-V = viewer/src/pxview.tsx, viewer domain.)
 *
 * Per-tab mode toggle: Page.startScreencast (JPEG) -> H.264 `vid` Down msgs where the viewer can
 * decode them, or `px` JPEG frames where it cannot. A still page also gets one sharp `px` frame.
 * ALWAYS ack frames (Page.screencastFrameAck) or the screencast stalls. Keep the recorder
 * running in px mode (cheap; makes flip-back instant via fresh snapshot). Backpressure: drop
 * frames for stalled viewers, never queue (D4 rule applies to px too).
 */
import type { Down, PxQuality, Up } from "@mirror/protocol";

import type { BrowserHandle } from "./browser/launch";
import type { TabHub } from "./hub/tabhub";
import type { TargetRef } from "./types";
import { createFfmpegEncoder, type VideoEncoder, type VideoEncoderFactory } from "./px-video";

type ModeMsg = Extract<Up, { t: "mode" }>;
type PixelFrame = Extract<Down, { t: "px" }>;
const DEFAULT_COMMAND_TIMEOUT_MS = 3000;
const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 1500;
/** Motion stays JPEG for latency; a still page then gets one `sharp` frame made for text. */
const SHARP_IDLE_MS = 350;
const SHARP_MIN_INTERVAL_MS = 1_500;
const SHARP_MAX_INTERVAL_MS = 30_000;
/** Frames closer than this are real activity, unlike a lone blinking caret. */
const BURST_GAP_MS = 150;
const VIDEO_QUIET_MS = 40;
const VIDEO_FLUSH_GAP_MS = 5;
const VIDEO_FLUSH_FRAMES = 3;
/** A page that never stops, such as a shimmer on one row, still gets sharp around that row. */
const SHARP_MOTION_INTERVAL_MS = 3_000;
/**
 * Limits are in device pixels and square, so a portrait phone keeps its full width. Chromium only
 * scales down, so a smaller browser simply gets its own resolution.
 */
const CAPTURE_PRESETS: Record<
  PxQuality,
  {
    maxWidth: number;
    maxHeight: number;
    jpeg: number;
    /** H.264 replaces JPEG where the viewer can decode it. */
    video: { jpeg: number; everyNthFrame: number; crf: number };
    everyNthFrame: number;
    sharp?: { format: "png" | "webp"; quality?: number };
  }
> = {
  low: {
    maxWidth: 1280,
    maxHeight: 1280,
    jpeg: 50,
    video: { jpeg: 60, everyNthFrame: 3, crf: 28 },
    everyNthFrame: 3,
  },
  medium: {
    maxWidth: 1920,
    maxHeight: 1920,
    jpeg: 65,
    video: { jpeg: 75, everyNthFrame: 2, crf: 23 },
    everyNthFrame: 2,
    sharp: { format: "webp", quality: 90 },
  },
  high: {
    maxWidth: 3840,
    maxHeight: 3840,
    jpeg: 80,
    video: { jpeg: 85, everyNthFrame: 1, crf: 18 },
    everyNthFrame: 2,
    sharp: { format: "png" },
  },
};
type ScreencastBrowser = Pick<
  BrowserHandle,
  "send" | "onAttached" | "onDetached" | "onSessionEvent"
>;

export interface ScreencastOpts {
  browser: ScreencastBrowser;
  hubFor(tabId: string): TabHub | undefined;
  publish(msg: Down): void;
  onError?: (error: unknown) => void;
  commandTimeoutMs?: number;
  firstFrameTimeoutMs?: number;
  /** A viewer cannot keep up, so frames should wait rather than be encoded and queued. */
  backlogged?(): boolean;
  createVideoEncoder?: VideoEncoderFactory;
  /** Supply both hooks to track pixel ownership. Acquisition must be synchronous. */
  acquirePixel?(tabId: string): boolean;
  /** Called after stop completes or its bounded deadline, including reset/dispose paths. */
  releasePixel?(tabId: string): void;
}

export interface ScreencastController {
  handle(msg: ModeMsg): Promise<void>;
  /** Synchronously invalidate this tab's pixel work, including a hung mode queue. */
  reset(tabId: string): void;
  /** The viewer's decoder needs a new stream beginning with a keyframe. */
  requestKeyframe(tabId: string): void;
  modeFor(tabId: string): "dom" | "px" | undefined;
  dispose(): void;
}

interface VideoStream {
  w: number;
  h: number;
  encoder: VideoEncoder;
  flushTimer?: ReturnType<typeof setTimeout>;
}

interface TabState {
  target: TargetRef;
  hub: TabHub;
  screencasting: boolean;
  lastFrame?: PixelFrame;
  generation: number;
  queueGeneration: number;
  firstFrameTimer?: ReturnType<typeof setTimeout>;
  sharpTimer?: ReturnType<typeof setTimeout>;
  sharpBackoffMs: number;
  sharpNotBefore: number;
  lastSharpInputAt: number;
  lastFrameAt: number;
  lastSharpAt: number;
  sharpInFlight: boolean;
  video?: VideoStream;
  videoSeq: number;
  lastJpeg?: Buffer;
  frameCount: number;
  lastCastData?: string;
  fallback?: { generation: number; promise: Promise<void> };
  queue: Promise<void>;
  pixelLease?: { releasing: boolean };
  pixelStop?: Promise<void>;
}

/**
 * Owns only CDP's screencast lane. It deliberately never pauses or replaces AgentLink/TabHub:
 * rrweb keeps recording into the same hub while JPEG frames are shown.
 */
export function createScreencast(opts: ScreencastOpts): ScreencastController {
  if ((opts.acquirePixel === undefined) !== (opts.releasePixel === undefined))
    throw new TypeError("Pixel capacity requires both acquirePixel and releasePixel hooks");
  const tabs = new Map<string, TabState>();
  const sessions = new Map<string, TabState>();
  // Chosen by the viewer; applies to every tab of this client session.
  let quality: PxQuality = "high";
  let videoWanted = false;
  // ffmpeg is missing or keeps failing: this session stays on JPEG frames.
  let videoBroken = false;
  const screencastParams = () => {
    const preset = CAPTURE_PRESETS[quality];
    const video = videoWanted && !videoBroken;
    return {
      format: "jpeg",
      quality: video ? preset.video.jpeg : preset.jpeg,
      everyNthFrame: video ? preset.video.everyNthFrame : preset.everyNthFrame,
      maxWidth: preset.maxWidth,
      maxHeight: preset.maxHeight,
    };
  };
  const screenshotClip = (w: number, h: number, dpr: number) => {
    const preset = CAPTURE_PRESETS[quality];
    return {
      x: 0,
      y: 0,
      width: w,
      height: h,
      scale: Math.min(1, preset.maxWidth / (w * dpr), preset.maxHeight / (h * dpr)),
    };
  };
  const commandTimeoutMs = checkedTimeout(opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const firstFrameTimeoutMs = checkedTimeout(
    opts.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  );
  let disposed = false;

  const report = (error: unknown): void => opts.onError?.(error);
  const current = (state: TabState, generation = state.generation): boolean =>
    !disposed && sessions.get(state.target.sessionId) === state && state.generation === generation;
  const sendBounded = async (
    state: TabState,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> =>
    withDeadline(
      opts.browser.send(state.target.sessionId, method, params),
      commandTimeoutMs,
      method,
    );
  const clearFirstFrameTimer = (state: TabState): void => {
    if (state.firstFrameTimer !== undefined) clearTimeout(state.firstFrameTimer);
    state.firstFrameTimer = undefined;
    clearTimeout(state.sharpTimer);
    state.sharpTimer = undefined;
  };
  /** Replaces the last JPEG with a frame fit for reading once the page has stopped changing. */
  const captureSharp = async (
    state: TabState,
    generation: number,
    duringMotion: boolean,
  ): Promise<void> => {
    const sharp = CAPTURE_PRESETS[quality].sharp;
    const viewport = state.hub.viewport;
    const seen = state.frameCount;
    if (!sharp || !viewport || !state.screencasting || state.hub.mode !== "px") return;
    if (!current(state, generation) || state.sharpInFlight) return;
    state.sharpInFlight = true;
    state.lastSharpAt = Date.now();
    try {
      const shot = (await sendBounded(state, "Page.captureScreenshot", {
        ...sharp,
        optimizeForSpeed: true,
        fromSurface: true,
        captureBeyondViewport: false,
        clip: screenshotClip(viewport.w, viewport.h, viewport.dpr),
      })) as { data?: unknown };
      // On a still page a newer frame means this picture is out of date and schedules its own.
      // On a moving page the viewer patches whatever keeps changing back over it.
      if (!current(state, generation) || state.hub.mode !== "px") return;
      if (!duringMotion && state.frameCount !== seen) return;
      if (typeof shot.data !== "string" || shot.data.length === 0) return;
      state.lastFrame = {
        t: "px",
        tab: state.target.targetId,
        data: shot.data,
        w: viewport.w,
        h: viewport.h,
      };
      state.sharpBackoffMs = Math.min(SHARP_MAX_INTERVAL_MS, state.sharpBackoffMs * 2);
      state.sharpNotBefore = Date.now() + state.sharpBackoffMs;
      opts.publish(state.lastFrame);
    } catch (error) {
      if (current(state, generation)) report(error);
    } finally {
      state.sharpInFlight = false;
    }
  };
  const stopVideo = (state: TabState): void => {
    const video = state.video;
    if (!video) return;
    state.video = undefined;
    clearTimeout(video.flushTimer);
    video.encoder.close();
  };
  const startVideo = (state: TabState, w: number, h: number): void => {
    stopVideo(state);
    const tab = state.target.targetId;
    const video: VideoStream = {
      w,
      h,
      encoder: (opts.createVideoEncoder ?? createFfmpegEncoder)(
        CAPTURE_PRESETS[quality].video.crf,
        {
          onConfig({ codec, description }) {
            if (state.video === video)
              opts.publish({
                t: "vid-cfg",
                tab,
                codec,
                description: description.toString("base64"),
              });
          },
          onChunk(data, key) {
            if (state.video === video)
              opts.publish({ t: "vid", tab, seq: state.videoSeq++, key, w, h, data });
          },
          onFailure(error) {
            if (state.video !== video) return;
            state.video = undefined;
            clearTimeout(video.flushTimer);
            videoBroken = true;
            report(error);
          },
        },
      ),
    };
    state.video = video;
  };
  /**
   * ffmpeg holds back its last frames until more input arrives. When the picture goes quiet, the
   * same frame is fed again to push out the real one.
   */
  const flushVideo = (state: TabState, video: VideoStream, remaining: number): void => {
    clearTimeout(video.flushTimer);
    video.flushTimer = setTimeout(
      () => {
        if (state.video !== video || !state.lastJpeg) return;
        video.encoder.write(state.lastJpeg);
        if (remaining > 1) flushVideo(state, video, remaining - 1);
      },
      remaining === VIDEO_FLUSH_FRAMES ? VIDEO_QUIET_MS : VIDEO_FLUSH_GAP_MS,
    );
    video.flushTimer.unref?.();
  };
  const feedVideo = (state: TabState, w: number, h: number): void => {
    if (state.video?.w !== w || state.video.h !== h) startVideo(state, w, h);
    const video = state.video;
    if (!video || !state.lastJpeg) return;
    // A frame dropped here costs nothing; one dropped after encoding would break the decoder.
    if (!opts.backlogged?.()) video.encoder.write(state.lastJpeg);
    flushVideo(state, video, VIDEO_FLUSH_FRAMES);
  };
  /** A viewer that joined or lost its place needs a new stream beginning with a keyframe. */
  const restartVideo = (state: TabState): void => {
    if (!videoWanted || videoBroken || !state.lastJpeg || !state.lastFrame) return;
    startVideo(state, state.lastFrame.w, state.lastFrame.h);
    feedVideo(state, state.lastFrame.w, state.lastFrame.h);
  };
  const noteMotionFrame = (state: TabState): void => {
    const now = Date.now();
    const bursting = now - state.lastFrameAt < BURST_GAP_MS;
    // A blinking caret must not cost a full lossless picture every half second, while typing or
    // scrolling should turn sharp again straight away.
    if (bursting || state.hub.lastInputAt > state.lastSharpInputAt) {
      state.sharpBackoffMs = SHARP_MIN_INTERVAL_MS / 2;
      state.sharpNotBefore = 0;
      state.lastSharpInputAt = state.hub.lastInputAt;
    }
    state.lastFrameAt = now;
    state.frameCount++;
    const preset = CAPTURE_PRESETS[quality];
    if (!preset.sharp) return;
    const generation = state.generation;
    const whenStill = Math.max(now + SHARP_IDLE_MS, state.sharpNotBefore);
    const motionDue = state.lastSharpAt + SHARP_MOTION_INTERVAL_MS;
    const duringMotion = bursting && motionDue < whenStill;
    state.sharpTimer = setTimeout(
      () => {
        state.sharpTimer = undefined;
        void captureSharp(state, generation, duringMotion);
      },
      Math.max(0, (duringMotion ? motionDue : whenStill) - now),
    );
    state.sharpTimer.unref?.();
  };
  const invalidate = (state: TabState): boolean => {
    const wasScreencasting = state.screencasting;
    stopVideo(state);
    delete state.lastJpeg;
    state.generation++;
    clearFirstFrameTimer(state);
    state.fallback = undefined;
    state.screencasting = false;
    delete state.lastFrame;
    return wasScreencasting;
  };
  const acquirePixel = (state: TabState): boolean => {
    if (!opts.acquirePixel) return true;
    if (state.pixelLease) return !state.pixelLease.releasing;
    if (!opts.acquirePixel(state.target.targetId)) return false;
    state.pixelLease = { releasing: false };
    return true;
  };
  const stopAndRelease = (state: TabState, stop: boolean): Promise<void> => {
    if (state.pixelStop) return state.pixelStop;
    const lease = state.pixelLease;
    const release = () => {
      if (!lease || state.pixelLease !== lease) return;
      delete state.pixelLease;
      opts.releasePixel?.(state.target.targetId);
    };
    if (!stop) {
      release();
      return Promise.resolve();
    }
    if (lease) lease.releasing = true;
    const stopped = sendBounded(state, "Page.stopScreencast")
      .then(() => undefined)
      .finally(() => {
        release();
        if (state.pixelStop === stopped) delete state.pixelStop;
      });
    state.pixelStop = stopped;
    return stopped;
  };
  const stopQuietly = (state: TabState, stop = true): void => {
    void stopAndRelease(state, stop).catch(() => undefined);
  };
  const returnToDom = async (
    state: TabState,
    generation: number,
    error?: unknown,
  ): Promise<void> => {
    if (!current(state, generation)) return;
    const stop = invalidate(state);
    const restoredGeneration = state.generation;
    state.hub.mode = "dom";
    if (error !== undefined) report(error);
    // Restore the UI before awaiting best-effort cleanup of a potentially hung renderer.
    opts.publish({ t: "mode", tab: state.target.targetId, mode: "dom" });
    for (const down of state.hub.joinPayload()) opts.publish(down);
    try {
      await stopAndRelease(state, stop);
    } catch (cause) {
      if (current(state, restoredGeneration)) report(cause);
    }
  };
  const ensureFirstFrame = (state: TabState, generation: number): Promise<void> => {
    if (!current(state, generation) || !state.screencasting || state.lastFrame)
      return Promise.resolve();
    if (state.fallback?.generation === generation) return state.fallback.promise;
    clearFirstFrameTimer(state);
    const fallback = { generation, promise: Promise.resolve() };
    state.fallback = fallback;
    fallback.promise = (async () => {
      try {
        const preset = CAPTURE_PRESETS[quality];
        let viewport = state.hub.viewport;
        if (viewport === null) {
          const metrics = (await sendBounded(state, "Page.getLayoutMetrics")) as {
            cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
          };
          viewport = {
            w: frameDimension(metrics.cssLayoutViewport?.clientWidth, preset.maxWidth),
            h: frameDimension(metrics.cssLayoutViewport?.clientHeight, preset.maxHeight),
            dpr: 1,
          };
        }
        if (!current(state, generation) || state.hub.mode !== "px" || state.lastFrame) return;
        const w = frameDimension(viewport.w, preset.maxWidth);
        const h = frameDimension(viewport.h, preset.maxHeight);
        const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
        const screenshot = (await sendBounded(state, "Page.captureScreenshot", {
          format: "jpeg",
          quality: preset.jpeg,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: screenshotClip(w, h, dpr),
        })) as { data?: unknown };
        if (!current(state, generation) || state.hub.mode !== "px" || state.lastFrame) return;
        if (typeof screenshot.data !== "string" || screenshot.data.length === 0)
          throw new Error("Pixel first-frame capture returned no image");
        state.lastFrame = { t: "px", tab: state.target.targetId, data: screenshot.data, w, h };
        opts.publish(state.lastFrame);
      } catch (cause) {
        // A native frame arriving during the fallback wins; a late failed capture must not
        // replace a working screencast or alter a newly attached/navigation generation.
        if (current(state, generation) && !state.lastFrame)
          await returnToDom(state, generation, cause);
      } finally {
        if (state.fallback === fallback) state.fallback = undefined;
      }
    })();
    return fallback.promise;
  };
  const watchFirstFrame = (state: TabState, generation: number): void => {
    clearFirstFrameTimer(state);
    if (!current(state, generation) || state.lastFrame) return;
    state.firstFrameTimer = setTimeout(() => {
      state.firstFrameTimer = undefined;
      if (current(state, generation)) void ensureFirstFrame(state, generation);
    }, firstFrameTimeoutMs);
    state.firstFrameTimer.unref?.();
  };

  const unsubscribeFrame = opts.browser.onSessionEvent(
    "Page.screencastFrame",
    (sessionId, event) => {
      const state = sessions.get(sessionId);
      if (disposed || state === undefined) return;

      // Ack independently of fan-out and mode state. A final frame can race stopScreencast;
      // failing to ack it is enough to wedge a later restart on some Chromium versions.
      void sendBounded(state, "Page.screencastFrameAck", { sessionId: event.sessionId }).catch(
        (error) => {
          if (current(state)) report(error);
        },
      );

      if (!state.screencasting) return;
      // Taking a sharp frame can make Chromium repeat the same picture. It must not replace it.
      if (state.lastFrame && event.data === state.lastCastData) return;
      state.lastCastData = event.data;
      const viewport = state.hub.viewport;
      const w = frameDimension(viewport?.w, event.metadata.deviceWidth);
      const h = frameDimension(viewport?.h, event.metadata.deviceHeight);
      state.lastFrame = { t: "px", tab: state.target.targetId, data: event.data, w, h };
      clearFirstFrameTimer(state);
      noteMotionFrame(state);
      if (videoWanted && !videoBroken && state.hub.mode === "px") {
        state.lastJpeg = Buffer.from(event.data, "base64");
        feedVideo(state, w, h);
      } else if (state.hub.mode === "px") opts.publish(state.lastFrame);
      // Retain one bounded latest frame for repeated mode requests on static pages.
      // ViewerConn still drops delivery to stalled viewers rather than queueing frames.
    },
  );

  const unsubscribeNavigation = opts.browser.onSessionEvent(
    "Page.frameNavigated",
    (sessionId, event) => {
      if (!event.frame.parentId) {
        const state = sessions.get(sessionId);
        if (state) {
          state.generation++;
          clearFirstFrameTimer(state);
          state.fallback = undefined;
          delete state.lastFrame;
          if (state.screencasting && state.hub.mode === "px") {
            watchFirstFrame(state, state.generation);
          } else if (state.screencasting) {
            state.screencasting = false;
            stopQuietly(state);
          }
        }
      }
    },
  );

  const applyMode = async (
    state: TabState,
    mode: "dom" | "px",
    qualityChanged = false,
  ): Promise<void> => {
    if (!current(state)) return;
    if (mode === "px") {
      // A queued retry may follow a failed/finished transition that released its first lease.
      if (!acquirePixel(state)) {
        opts.publish({ t: "mode", tab: state.target.targetId, mode: "dom" });
        return;
      }
      const bringToFrontGeneration = state.generation;
      void sendBounded(state, "Page.bringToFront").catch((error) => {
        if (current(state, bringToFrontGeneration)) report(error);
      });
      if (state.screencasting && state.hub.mode === "px") {
        if (qualityChanged) {
          // Keep showing the current picture; only the capture restarts with the new preset.
          const generation = state.generation;
          stopVideo(state);
          try {
            await sendBounded(state, "Page.stopScreencast");
            if (!current(state, generation)) return;
            await sendBounded(state, "Page.startScreencast", screencastParams());
          } catch (error) {
            await returnToDom(state, generation, error);
            return;
          }
          if (!current(state, generation)) return;
        }
        opts.publish({ t: "mode", tab: state.target.targetId, mode: "px" });
        if (state.lastFrame) opts.publish(state.lastFrame);
        else void ensureFirstFrame(state, state.generation);
        restartVideo(state);
        return;
      }
      const generation = ++state.generation;
      clearFirstFrameTimer(state);
      state.fallback = undefined;
      delete state.lastFrame;
      state.screencasting = true;
      // Until start is confirmed, keep the existing DOM lane available to the viewer.
      state.hub.mode = "dom";
      try {
        await sendBounded(state, "Page.startScreencast", screencastParams());
      } catch (error) {
        await returnToDom(state, generation, error);
        return;
      }
      if (!current(state, generation)) return;
      state.screencasting = true;
      state.hub.mode = "px";
      opts.publish({ t: "mode", tab: state.target.targetId, mode: "px" });
      // A frame can precede CDP's start acknowledgement; the viewer ignores it until mode.
      if (state.lastFrame) opts.publish(state.lastFrame);
      else watchFirstFrame(state, generation);
      return;
    }

    if (!state.screencasting && state.hub.mode === "dom" && !state.pixelLease) return;
    await returnToDom(state, state.generation);
  };

  opts.browser.onDetached((target) => {
    if (target.type !== "page") return;
    const state = tabs.get(target.targetId);
    if (state?.target.sessionId !== target.sessionId) return;
    tabs.delete(target.targetId);
    sessions.delete(target.sessionId);
    stopQuietly(state, invalidate(state));
  });

  opts.browser.onAttached((target) => {
    if (disposed || target.type !== "page") return;
    const hub = opts.hubFor(target.targetId);
    if (hub === undefined) return;
    const previous = tabs.get(target.targetId);
    if (previous?.target.sessionId === target.sessionId) return;
    if (previous !== undefined) {
      sessions.delete(previous.target.sessionId);
      stopQuietly(previous, invalidate(previous));
    }
    const state: TabState = {
      target,
      hub,
      screencasting: false,
      generation: 0,
      queueGeneration: 0,
      queue: Promise.resolve(),
      sharpBackoffMs: SHARP_MIN_INTERVAL_MS / 2,
      sharpNotBefore: 0,
      lastSharpInputAt: 0,
      lastFrameAt: 0,
      lastSharpAt: 0,
      sharpInFlight: false,
      videoSeq: 0,
      frameCount: 0,
    };
    tabs.set(target.targetId, state);
    sessions.set(target.sessionId, state);
  });

  return {
    handle(msg) {
      const state = tabs.get(msg.tab);
      if (state === undefined)
        return Promise.reject(new Error(`unknown screencast tab ${msg.tab}`));
      // Reserve before yielding to a per-tab Promise queue so two runtimes cannot both start.
      if (msg.mode === "px" && !acquirePixel(state)) {
        opts.publish({ t: "mode", tab: state.target.targetId, mode: "dom" });
        return Promise.resolve();
      }
      const queueGeneration = state.queueGeneration;
      // Untrusted wire value: anything but a known preset leaves the current one in place.
      const requested =
        typeof msg.quality === "string" && Object.hasOwn(CAPTURE_PRESETS, msg.quality)
          ? msg.quality
          : quality;
      const videoRequested = msg.mode === "px" && msg.video !== undefined ? msg.video : videoWanted;
      const qualityChanged = requested !== quality || videoRequested !== videoWanted;
      quality = requested;
      videoWanted = videoRequested;
      const operation = state.queue.then(async () => {
        if (!current(state) || state.queueGeneration !== queueGeneration) return;
        await applyMode(state, msg.mode, qualityChanged);
      });
      // Preserve serialization after a failed CDP command without hiding that failure from the
      // caller that requested this particular transition.
      state.queue = operation.catch(() => undefined);
      return operation;
    },
    reset(tabId) {
      const state = tabs.get(tabId);
      if (state === undefined || !current(state)) return;
      state.queueGeneration++;
      state.queue = Promise.resolve();
      // returnToDom clears local state and publishes synchronously, before its bounded stop.
      void returnToDom(state, state.generation).catch(report);
    },
    requestKeyframe(tabId) {
      const state = tabs.get(tabId);
      if (state && current(state) && state.hub.mode === "px") restartVideo(state);
    },
    modeFor(tabId) {
      return tabs.get(tabId)?.hub.mode;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeFrame();
      unsubscribeNavigation();
      for (const state of tabs.values()) {
        stopQuietly(state, invalidate(state));
      }
      tabs.clear();
      sessions.clear();
    },
  };
}

function frameDimension(preferred: number | undefined, fallback: number): number {
  const value = preferred !== undefined && Number.isFinite(preferred) ? preferred : fallback;
  return Math.min(10000, Math.max(1, Math.round(value)));
}

function checkedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError("Pixel timeouts must be positive integers");
  return value;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
