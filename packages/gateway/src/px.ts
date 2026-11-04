/**
 * Gateway side of the pixel fallback.
 * (Viewer half P2-PX-V = viewer/src/pxview.tsx, viewer domain.)
 *
 * Per-tab mode toggle. A viewer that can decode H.264 gets `vid` Down msgs read straight off the X
 * display, which leaves the page at full speed. Only one client's window can be on the display, so
 * the others use Page.startScreencast (JPEG) -> `vid`, or `px` JPEG frames where H.264 cannot be
 * decoded. A still screencast also gets one sharp `px` frame.
 * ALWAYS ack frames (Page.screencastFrameAck) or the screencast stalls. Keep the recorder
 * running in px mode (cheap; makes flip-back instant via fresh snapshot). Backpressure: drop
 * frames for stalled viewers, never queue (D4 rule applies to px too).
 */
import type { Down, PxQuality, Up } from "@mirror/protocol";

import type { BrowserHandle } from "./browser/launch";
import type { TabHub } from "./hub/tabhub";
import type { TargetRef } from "./types";
import { zoomLevelFor, type BrowserZoom } from "./browser/browser-zoom";
import type { PixelWindow } from "./browser/pixel-window";
import {
  createFfmpegEncoder,
  createGrabEncoder,
  type GrabEncoderFactory,
  type VideoEncoder,
  type VideoEncoderEvents,
  type VideoEncoderFactory,
} from "./px-video";

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
const ZOOM_SETTLE_MS = 1_500;
const ZOOM_POLL_MS = 50;
const STATS_INTERVAL_MS = 1_000;
/** Beyond this the held frame is pushed out; at 25 fps and up the next frame does it for free. */
const VIDEO_FLUSH_MS = 40;
/** 30 fps. Chromium can produce more, which only costs CPU this view has better uses for. */
const VIDEO_MIN_FRAME_GAP_MS = 33;
/** A page that never stops, such as a shimmer on one row, still gets sharp around that row. */
const SHARP_MOTION_INTERVAL_MS = 3_000;
/**
 * The presets trade sharpness for frame rate, which the CPU limits on a host without a GPU. Traffic
 * is not the constraint. A zoom above the viewer's density never applies, so a normal display gets
 * its own full resolution from all of them.
 */
const CAPTURE_PRESETS: Record<PxQuality, { maxZoom: number }> = {
  smooth: { maxZoom: 1 },
  balanced: { maxZoom: 1.5 },
  sharp: { maxZoom: Number.POSITIVE_INFINITY },
};
/** Square, so a portrait phone keeps its full width. Chromium only ever scales frames down. */
const MAX_FRAME_SIDE = 3840;
const FRAME_JPEG_QUALITY = 80;
const VIDEO_CRF = 16;
/** Without the encoder every frame goes to the viewer, so fewer of them are taken. */
const JPEG_EVERY_NTH_FRAME = 2;
const SHARP_FRAME = { format: "png" } as const;
/** How often the grab checks its window is still on top and its geometry is still wanted. */
const GRAB_CHECK_MS = 250;
type ScreencastBrowser = Pick<
  BrowserHandle,
  "send" | "onAttached" | "onDetached" | "onSessionEvent"
>;

/** Reading pictures off the X display, where each client needs a free slot of the screen. */
export interface ScreenGrab {
  window: PixelWindow;
  /** The left edge of this client's slot, or null when the screen is full. */
  acquire(): number | null;
  release(): void;
  available(): boolean;
  createEncoder?: GrabEncoderFactory;
}

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
  /** Lets the highest quality reach device resolution; without it frames stop at CSS pixels. */
  browserZoom?: BrowserZoom;
  grab?: ScreenGrab;
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
  /** Frames in the encoder, oldest first: whether each one only repeats the one before it. */
  written: boolean[];
  flushed?: boolean;
  lastFedAt?: number;
  /** A grab encoder cannot skip input, so a viewer that fell behind needs a new stream. */
  lost?: boolean;
}

interface GrabState {
  w: number;
  h: number;
  zoom: number;
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
  /** Left edge of the held slot, from when it is claimed until the window is back. */
  grabLeft?: number | undefined;
  /** What the running grab shows. Absent when pictures come from the screencast. */
  grabbing?: GrabState;
  grabChecking?: boolean;
  zoomChanging?: boolean;
  stats: { captured: number; encoded: number; dropped: number };
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
  let quality: PxQuality = "balanced";
  let videoWanted = false;
  // ffmpeg is missing or keeps failing: this session stays on JPEG frames.
  let videoBroken = false;
  let zoomBroken = false;
  // The display or its window cannot be used: this session stays on the screencast.
  let grabBroken = false;
  const screencastParams = () => ({
    format: "jpeg",
    quality: FRAME_JPEG_QUALITY,
    everyNthFrame: videoWanted && !videoBroken ? 1 : JPEG_EVERY_NTH_FRAME,
    maxWidth: MAX_FRAME_SIDE,
    maxHeight: MAX_FRAME_SIDE,
  });
  const zoomWanted = (state: TabState): number => {
    const viewport = state.hub.viewport;
    if (!viewport || !opts.browserZoom || zoomBroken || videoBroken) return 1;
    if (!videoWanted) return 1;
    const density = Math.min(viewport.dpr, CAPTURE_PRESETS[quality].maxZoom);
    return zoomLevelFor(density, viewport.w, viewport.h);
  };
  const applyMetrics = async (state: TabState, zoom: number): Promise<void> => {
    const viewport = state.hub.viewport;
    if (!viewport) return;
    await sendBounded(state, "Emulation.setDeviceMetricsOverride", {
      width: Math.round(viewport.w * zoom),
      height: Math.round(viewport.h * zoom),
      deviceScaleFactor: zoom > 1 || state.hub.pixelGrabbing ? 1 : viewport.dpr,
      mobile: false,
    });
  };
  const pageDensity = async (state: TabState): Promise<number> => {
    const result = (await sendBounded(state, "Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
      silent: true,
    })) as { result?: { value?: unknown } };
    return Number(result.result?.value);
  };
  /** A page at the wanted zoom reports it as its density, as the window has a density of 1. */
  const zoomTookEffect = async (state: TabState, zoom: number): Promise<boolean> => {
    for (let waited = 0; waited < ZOOM_SETTLE_MS; waited += ZOOM_POLL_MS) {
      if (Math.abs((await pageDensity(state)) - zoom) < 0.01) return true;
      await new Promise((resolve) => setTimeout(resolve, ZOOM_POLL_MS));
    }
    return false;
  };
  /** Moves the page to a browser zoom. Its layout and reported density stay the same throughout. */
  const syncZoom = async (state: TabState, zoom: number): Promise<void> => {
    if (!opts.browserZoom || zoom === state.hub.pixelZoom) return;
    try {
      state.hub.pixelZoom = zoom;
      await applyMetrics(state, zoom);
      await opts.browserZoom.press(state.target, zoom);
      if (zoom > 1 && !(await zoomTookEffect(state, zoom)))
        throw new Error(`Browser zoom ${zoom} did not take effect`);
    } catch (error) {
      if (zoom > 1) {
        // Without the zoom the larger window would show a tiny page, so undo all of it.
        zoomBroken = true;
        state.hub.pixelZoom = 1;
        await applyMetrics(state, 1).catch(report);
        await opts.browserZoom.press(state.target, 1).catch(() => {});
      }
      report(error);
    }
  };
  /** Zoom belongs to a site, so a page on another site starts over at 100%. */
  const reassertZoom = async (state: TabState): Promise<void> => {
    const zoom = state.hub.pixelZoom;
    if (!opts.browserZoom || zoom <= 1 || !current(state)) return;
    if (Math.abs((await pageDensity(state)) - zoom) < 0.01) return;
    await opts.browserZoom.press(state.target, zoom);
  };
  const screenshotClip = (w: number, h: number, dpr: number) => {
    return {
      x: 0,
      y: 0,
      width: w,
      height: h,
      scale: Math.min(1, MAX_FRAME_SIDE / (w * dpr), MAX_FRAME_SIDE / (h * dpr)),
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
    const viewport = state.hub.viewport;
    const seen = state.frameCount;
    if (!viewport || !state.screencasting || state.hub.mode !== "px") return;
    if (!current(state, generation) || state.sharpInFlight) return;
    state.sharpInFlight = true;
    state.lastSharpAt = Date.now();
    try {
      const shot = (await sendBounded(state, "Page.captureScreenshot", {
        ...SHARP_FRAME,
        optimizeForSpeed: true,
        fromSurface: true,
        captureBeyondViewport: false,
        // A clip is measured in CSS pixels at scale 1, which would undo the zoom's resolution.
        ...(state.hub.pixelZoom > 1
          ? {}
          : { clip: screenshotClip(viewport.w, viewport.h, viewport.dpr) }),
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
    const grabbing = state.grabbing;
    const events: VideoEncoderEvents = {
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
        if (state.video !== video) return;
        if (grabbing) {
          state.stats.captured++;
          if (video.lost || opts.backlogged?.()) {
            video.lost = true;
            state.stats.dropped++;
            return;
          }
        }
        const repeat = video.written.shift() === true;
        if (!repeat) state.stats.encoded++;
        opts.publish({ t: "vid", tab, seq: state.videoSeq++, key, repeat, w, h, data });
      },
      onFailure(error) {
        if (state.video !== video) return;
        state.video = undefined;
        clearTimeout(video.flushTimer);
        report(error);
        if (!grabbing) {
          videoBroken = true;
          return;
        }
        grabBroken = true;
        reapply(state);
      },
    };
    const video: VideoStream = {
      w,
      h,
      written: [],
      encoder: grabbing
        ? (opts.grab?.createEncoder ?? createGrabEncoder)(
            VIDEO_CRF,
            { left: state.grabLeft ?? 0, ...grabSize(w, h, grabbing.zoom) },
            events,
          )
        : (opts.createVideoEncoder ?? createFfmpegEncoder)(VIDEO_CRF, events),
    };
    state.video = video;
  };
  /**
   * ffmpeg holds back one frame until the next arrives. When the next is not right behind it, the
   * same frame goes in again to push the real one out, so a keystroke is not left waiting.
   */
  const flushVideo = (state: TabState, video: VideoStream): void => {
    clearTimeout(video.flushTimer);
    video.flushTimer = setTimeout(() => {
      if (state.video !== video || !state.lastJpeg || video.flushed) return;
      video.flushed = true;
      video.written.push(true);
      video.encoder.write(state.lastJpeg);
    }, VIDEO_FLUSH_MS);
    video.flushTimer.unref?.();
  };
  const writeVideoFrame = (state: TabState, video: VideoStream): void => {
    if (state.video !== video || !state.lastJpeg) return;
    // A frame dropped here costs nothing; one dropped after encoding would break the decoder.
    if (opts.backlogged?.() || video.encoder.busy?.()) {
      state.stats.dropped++;
    } else {
      video.lastFedAt = Date.now();
      video.flushed = false;
      video.written.push(false);
      video.encoder.write(state.lastJpeg);
    }
    flushVideo(state, video);
  };
  const feedVideo = (state: TabState, w: number, h: number): void => {
    if (state.video?.w !== w || state.video.h !== h) startVideo(state, w, h);
    const video = state.video;
    if (!video || !state.lastJpeg) return;
    // Over the frame rate limit only the newest picture waits, and it still goes out on time.
    const wait = (video.lastFedAt ?? 0) + VIDEO_MIN_FRAME_GAP_MS - Date.now();
    clearTimeout(video.flushTimer);
    if (wait > 0) {
      video.flushTimer = setTimeout(() => writeVideoFrame(state, video), wait);
      video.flushTimer.unref?.();
      return;
    }
    writeVideoFrame(state, video);
  };
  /** A viewer that joined or lost its place needs a new stream beginning with a keyframe. */
  const restartVideo = (state: TabState): void => {
    if (state.grabbing) {
      startVideo(state, state.grabbing.w, state.grabbing.h);
      return;
    }
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
    const generation = state.generation;
    const whenStill = Math.max(now + SHARP_IDLE_MS, state.sharpNotBefore);
    const motionDue = state.lastSharpAt + SHARP_MOTION_INTERVAL_MS;
    // At device resolution moving frames already look like still ones.
    const duringMotion = bursting && motionDue < whenStill && state.hub.pixelZoom <= 1;
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
  /** Gives the display back, with the window as it was. Safe to call when it is not held. */
  const endGrab = async (state: TabState): Promise<void> => {
    if (state.grabLeft === undefined) return;
    state.grabLeft = undefined;
    delete state.grabbing;
    state.hub.pixelGrabbing = false;
    try {
      await opts.grab?.window.restore(state.target.targetId);
    } catch (error) {
      if (!disposed) report(error);
    } finally {
      opts.grab?.release();
    }
  };
  const canGrab = (state: TabState): boolean => {
    const viewport = state.hub.viewport;
    return !!(
      opts.grab &&
      viewport &&
      videoWanted &&
      !videoBroken &&
      !grabBroken &&
      viewport.w <= MAX_FRAME_SIDE &&
      viewport.h <= MAX_FRAME_SIDE
    );
  };
  /** Puts the window on the display and starts reading it. Throws if any of that fails. */
  const beginGrab = async (state: TabState): Promise<void> => {
    state.hub.pixelGrabbing = true;
    const viewport = state.hub.viewport!;
    const left = state.grabLeft!;
    const target = state.target.targetId;
    const wanted = zoomWanted(state);
    const place = (zoom: number) => {
      const { width, height } = grabSize(viewport.w, viewport.h, zoom);
      return opts.grab!.window.place(target, left, width, height);
    };
    // First, as a covered window would not answer the page commands below.
    await place(wanted);
    await syncZoom(state, wanted);
    const zoom = state.hub.pixelZoom;
    if (zoom !== wanted) await place(zoom);
    await applyMetrics(state, zoom);
    // The tab left the pixel view during that, and already gave its slot back.
    if (state.grabLeft === undefined) {
      await opts.grab!.window.restore(state.target.targetId);
      return;
    }
    delete state.lastFrame;
    delete state.lastJpeg;
    state.grabbing = { w: viewport.w, h: viewport.h, zoom };
    startVideo(state, viewport.w, viewport.h);
  };
  const beginCapture = async (state: TabState): Promise<void> => {
    if (canGrab(state)) state.grabLeft ??= opts.grab!.acquire() ?? undefined;
    if (canGrab(state) && state.grabLeft !== undefined) {
      try {
        await beginGrab(state);
        return;
      } catch (error) {
        grabBroken = true;
        report(error);
      }
    }
    if (state.grabLeft !== undefined) {
      await endGrab(state);
      if (state.hub.viewport) await applyMetrics(state, state.hub.pixelZoom);
    }
    await syncZoom(state, zoomWanted(state));
    await sendBounded(state, "Page.startScreencast", screencastParams());
  };
  /** Starts this tab's capture over with whatever it should be using now. */
  const reapply = (state: TabState): void => {
    if (state.zoomChanging) return;
    state.zoomChanging = true;
    state.queue = state.queue
      .then(() => applyMode(state, "px", true))
      .catch(report)
      .finally(() => {
        state.zoomChanging = false;
      });
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
    const grabbed = state.grabLeft !== undefined;
    await endGrab(state);
    await syncZoom(state, 1);
    // Zoom stayed at 1 during the grab, so nothing above has returned the page its real density.
    if (grabbed && state.hub.mode === "dom") await applyMetrics(state, 1).catch(report);
  };
  const ensureFirstFrame = (state: TabState, generation: number): Promise<void> => {
    if (!current(state, generation) || !state.screencasting || state.lastFrame || state.grabbing)
      return Promise.resolve();
    if (state.fallback?.generation === generation) return state.fallback.promise;
    clearFirstFrameTimer(state);
    const fallback = { generation, promise: Promise.resolve() };
    state.fallback = fallback;
    fallback.promise = (async () => {
      try {
        let viewport = state.hub.viewport;
        if (viewport === null) {
          const metrics = (await sendBounded(state, "Page.getLayoutMetrics")) as {
            cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
          };
          viewport = {
            w: frameDimension(metrics.cssLayoutViewport?.clientWidth, MAX_FRAME_SIDE),
            h: frameDimension(metrics.cssLayoutViewport?.clientHeight, MAX_FRAME_SIDE),
            dpr: 1,
          };
        }
        if (!current(state, generation) || state.hub.mode !== "px" || state.lastFrame) return;
        const w = frameDimension(viewport.w, MAX_FRAME_SIDE);
        const h = frameDimension(viewport.h, MAX_FRAME_SIDE);
        const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
        const screenshot = (await sendBounded(state, "Page.captureScreenshot", {
          format: "jpeg",
          quality: FRAME_JPEG_QUALITY,
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
    if (!current(state, generation) || state.lastFrame || state.grabbing) return;
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
      // The viewer's density can change while casting, for example on another monitor.
      if (
        state.hub.mode === "px" &&
        !state.zoomChanging &&
        zoomWanted(state) !== state.hub.pixelZoom
      ) {
        reapply(state);
      }
      // Taking a sharp frame can make Chromium repeat the same picture. It must not replace it.
      if (state.lastFrame && event.data === state.lastCastData) return;
      state.lastCastData = event.data;
      state.stats.captured++;
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
          state.queue = state.queue.then(() => reassertZoom(state)).catch(report);
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
            await beginCapture(state);
          } catch (error) {
            await returnToDom(state, generation, error);
            return;
          }
          if (!current(state, generation)) return;
        }
        opts.publish({ t: "mode", tab: state.target.targetId, mode: "px" });
        if (state.lastFrame) opts.publish(state.lastFrame);
        else void ensureFirstFrame(state, state.generation);
        // A capture that just started already begins with a keyframe.
        if (!qualityChanged || !state.grabbing) restartVideo(state);
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
        await beginCapture(state);
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
    opts.browserZoom?.forget(target.targetId);
    stopQuietly(state, invalidate(state));
    void endGrab(state);
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
      void endGrab(previous);
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
      stats: { captured: 0, encoded: 0, dropped: 0 },
      frameCount: 0,
    };
    tabs.set(target.targetId, state);
    sessions.set(target.sessionId, state);
  });

  const statsTimer = setInterval(() => {
    for (const state of tabs.values()) {
      const { captured, encoded, dropped } = state.stats;
      state.stats = { captured: 0, encoded: 0, dropped: 0 };
      if (state.hub.mode !== "px" || !state.video) continue;
      opts.publish({
        t: "px-stats",
        tab: state.target.targetId,
        captureFps: captured,
        encodeFps: encoded,
        dropFps: dropped,
      });
    }
  }, STATS_INTERVAL_MS);
  statsTimer.unref?.();

  const checkGrab = (state: TabState): void => {
    if (!state.screencasting || state.hub.mode !== "px" || state.zoomChanging) return;
    const { grabbing, video } = state;
    if (!grabbing) {
      // A slot came free, or this tab now has the viewport it needs to use one.
      if (canGrab(state) && opts.grab!.available()) reapply(state);
      return;
    }
    const viewport = state.hub.viewport;
    if (
      !canGrab(state) ||
      viewport!.w !== grabbing.w ||
      viewport!.h !== grabbing.h ||
      zoomWanted(state) !== grabbing.zoom
    ) {
      reapply(state);
      return;
    }
    if (video?.lost && !opts.backlogged?.()) restartVideo(state);
    if (state.grabChecking) return;
    state.grabChecking = true;
    void opts
      .grab!.window.keepOnTop(state.target.targetId)
      .catch(report)
      .finally(() => {
        state.grabChecking = false;
      });
  };
  const grabTimer = opts.grab
    ? setInterval(() => {
        for (const state of tabs.values()) checkGrab(state);
      }, GRAB_CHECK_MS)
    : undefined;
  grabTimer?.unref?.();

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
      clearInterval(statsTimer);
      clearInterval(grabTimer);
      unsubscribeFrame();
      unsubscribeNavigation();
      for (const state of tabs.values()) {
        stopQuietly(state, invalidate(state));
        void endGrab(state);
      }
      tabs.clear();
      sessions.clear();
    },
  };
}

/** The encoder needs even sides. Losing the odd row costs less than scaling every line. */
function grabSize(w: number, h: number, zoom: number): { width: number; height: number } {
  return {
    width: Math.floor((w * zoom) / 2) * 2,
    height: Math.floor((h * zoom) / 2) * 2,
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
