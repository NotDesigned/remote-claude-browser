/** Viewer video tiers for P3-VIDEO. */

export const MEDIA_UNAVAILABLE_NOTICE = "Media unavailable in DOM view — use pixel view";
/** Backward-compatible export for callers that used the earlier DRM-only notice name. */
export const DRM_VIDEO_NOTICE = MEDIA_UNAVAILABLE_NOTICE;

export interface VideoNotice {
  notice: "drm" | "unavailable";
  message: typeof MEDIA_UNAVAILABLE_NOTICE;
  id?: number;
  cause?: unknown;
}

export type VideoTier = "direct" | "rtc";

export interface VideoCompositorOptions {
  /** Trusted viewer document containing #viewer-hud-layer. */
  document?: Document;
  /** Whether this viewer has been used yet, which is what lets a video start with sound. */
  hasUserActivation?: () => boolean;
  onNotice?: (notice: VideoNotice) => void;
  onError?: (error: unknown) => void;
}

export interface VideoCompositor {
  /** Prepare a mirrored video and report whether it should remain native or request RTC. */
  onBuild(video: HTMLVideoElement, id: number): VideoTier;
  /** Put the entire remote MediaStream on the mirrored video; audio stays in WebRTC A/V sync. */
  startStream(
    video: HTMLVideoElement,
    stream: MediaStream,
    onFailure: (error?: unknown) => void,
  ): () => void;
  showBlocked(id?: number, cause?: unknown, notice?: VideoNotice["notice"]): void;
  dispose(): void;
}

function isRtcOnlySource(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return (
    normalized === "" || normalized.startsWith("blob:") || normalized.startsWith("mediasource:")
  );
}

/** A real URL is replayed natively; absent/blob MSE sources must be captured at the agent. */
export function videoTier(video: HTMLVideoElement): VideoTier {
  const urls: string[] = [];
  const src = video.getAttribute("src");
  if (src !== null) urls.push(src);
  for (const source of video.querySelectorAll?.("source") ?? []) {
    const sourceSrc = source.getAttribute("src");
    if (sourceSrc !== null) urls.push(sourceSrc);
  }
  return urls.some((url) => !isRtcOnlySource(url)) ? "direct" : "rtc";
}

function prepareAutoplay(video: HTMLVideoElement): void {
  video.autoplay = true;
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  // Native controls are the user-gesture affordance that lets the viewer unmute or seek.
  video.controls = true;
}

function play(video: HTMLVideoElement, onError?: (error: unknown) => void): void {
  try {
    void video.play().catch(onError);
  } catch (error) {
    onError?.(error);
  }
}

/**
 * A stream starts muted, as a browser may refuse to play it otherwise. It takes its sound as soon as
 * the browser allows that: at once for someone who has been using the viewer, or else at their next
 * press in the page. If the remote page mutes its video, the stream is silent whatever this says.
 */
function allowSoundAfterGesture(
  video: HTMLVideoElement,
  hasUserActivation: () => boolean = () =>
    (globalThis.navigator as Navigator | undefined)?.userActivation?.hasBeenActive === true,
): () => void {
  const document = video.ownerDocument;
  const events = ["pointerdown", "keydown"] as const;
  let stopped = false;
  const listen = () => {
    for (const name of events) document.addEventListener(name, unmute, true);
  };
  const stopListening = () => {
    for (const name of events) document.removeEventListener(name, unmute, true);
  };
  function unmute() {
    stopListening();
    video.muted = false;
    try {
      void video.play().catch((error: unknown) => {
        // Only the browser refusing sound means muting again: a new load interrupting this play
        // says nothing about sound, and the stream plays on with it.
        if (stopped || (error as { name?: unknown } | null)?.name !== "NotAllowedError") return;
        // Keep the picture, and let the next press try again.
        video.muted = true;
        void video.play().catch(() => undefined);
        listen();
      });
    } catch {
      video.muted = true;
    }
  }
  listen();
  if (hasUserActivation()) unmute();
  return () => {
    stopped = true;
    stopListening();
  };
}

function renderHudNotice(document: Document | undefined): HTMLElement | null {
  if (document === undefined) return null;
  const existing = document.querySelector<HTMLElement>("[data-mirror-video-notice]");
  if (existing !== null) return existing;
  const host = document.getElementById("viewer-hud-layer") ?? document.body;
  if (host === null) return null;
  host.dataset.mediaNotice = "unavailable";
  const notice = document.createElement("div");
  notice.dataset.mirrorVideoNotice = "unavailable";
  notice.setAttribute("role", "alert");
  notice.textContent = MEDIA_UNAVAILABLE_NOTICE;
  Object.assign(notice.style, {
    background: "#3b1217",
    border: "1px solid #ef6b78",
    borderRadius: "6px",
    color: "#fff",
    font: "600 13px/1.35 system-ui, sans-serif",
    margin: "8px",
    padding: "8px 10px",
    pointerEvents: "auto",
  });
  host.appendChild(notice);
  return notice;
}

function renderVideoNotice(video: HTMLVideoElement): HTMLElement | null {
  const document = video.ownerDocument;
  const parent = video.parentElement;
  if (parent === null) return null;
  const notice = document.createElement("div");
  notice.dataset.mirrorVideoBlocked = "true";
  notice.setAttribute("role", "alert");
  notice.textContent = MEDIA_UNAVAILABLE_NOTICE;
  const rect = video.getBoundingClientRect();
  Object.assign(notice.style, {
    alignItems: "center",
    background: "#111",
    color: "#fff",
    display: "flex",
    font: "600 14px/1.4 system-ui, sans-serif",
    height: `${Math.max(1, rect.height)}px`,
    justifyContent: "center",
    left: `${rect.left}px`,
    padding: "12px",
    position: "fixed",
    textAlign: "center",
    top: `${rect.top}px`,
    width: `${Math.max(1, rect.width)}px`,
    zIndex: "2147483647",
  });
  document.body.appendChild(notice);
  return notice;
}

export function createVideoCompositor(options: VideoCompositorOptions = {}): VideoCompositor {
  const videos = new Map<number, HTMLVideoElement>();
  const blockedIds = new Set<number | undefined>();
  const renderedNotices = new Map<number, HTMLElement>();
  const playbackListeners = new Map<number, () => void>();
  let hudNotice: HTMLElement | null = null;
  let disposed = false;
  const clearHud = () => {
    const host = hudNotice?.parentElement;
    hudNotice?.remove();
    hudNotice = null;
    if (host) delete host.dataset.mediaNotice;
  };

  const showBlocked = (
    id?: number,
    cause?: unknown,
    noticeKind: VideoNotice["notice"] = "unavailable",
  ) => {
    if (disposed) return;
    blockedIds.add(id);
    const notice: VideoNotice = {
      notice: noticeKind,
      message: MEDIA_UNAVAILABLE_NOTICE,
      ...(id === undefined ? {} : { id }),
      ...(cause === undefined ? {} : { cause }),
    };
    options.onNotice?.(notice);
    hudNotice ??= renderHudNotice(options.document ?? globalThis.document);
    if (id !== undefined) {
      const video = videos.get(id);
      if (video !== undefined) {
        if (!renderedNotices.has(id)) {
          const rendered = renderVideoNotice(video);
          if (rendered !== null) renderedNotices.set(id, rendered);
        }
      }
    }
  };

  return {
    onBuild(video, id) {
      if (disposed) return "direct";
      playbackListeners.get(id)?.();
      renderedNotices.get(id)?.remove();
      renderedNotices.delete(id);
      videos.set(id, video);
      const playing = () => {
        // A replaced node can still finish an earlier play request.
        if (videos.get(id) !== video) return;
        blockedIds.delete(id);
        blockedIds.delete(undefined);
        renderedNotices.get(id)?.remove();
        renderedNotices.delete(id);
        if (blockedIds.size === 0) clearHud();
      };
      video.addEventListener("playing", playing);
      playbackListeners.set(id, () => video.removeEventListener("playing", playing));
      prepareAutoplay(video);
      if (blockedIds.has(id)) showBlocked(id);
      const tier = videoTier(video);
      if (tier === "direct") play(video, options.onError);
      return tier;
    },
    startStream(video, stream, onFailure) {
      if (disposed) return () => {};
      prepareAutoplay(video);
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack === undefined) throw new Error("video WebRTC stream has no video track");
      const failed = () => onFailure(new Error("video WebRTC media track ended"));
      videoTrack.addEventListener("ended", failed, { once: true });
      video.addEventListener("error", failed, { once: true });
      // The page's own controls are mirrored over this, and clicks on them belong to the remote page.
      video.controls = false;
      // Assign the original stream, not a video-only copy: WebRTC timestamps keep audio/video synced.
      video.srcObject = stream;
      play(video, onFailure);
      // After the stream is in place, as assigning it interrupts any play already asked for.
      const stopSound = allowSoundAfterGesture(video, options.hasUserActivation);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        stopSound();
        videoTrack.removeEventListener("ended", failed);
        video.removeEventListener("error", failed);
        video.pause();
        if (video.srcObject === stream) video.srcObject = null;
      };
    },
    showBlocked,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stop of playbackListeners.values()) stop();
      playbackListeners.clear();
      for (const notice of renderedNotices.values()) notice.remove();
      renderedNotices.clear();
      clearHud();
      videos.clear();
      blockedIds.clear();
    },
  };
}
