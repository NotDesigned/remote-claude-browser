// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createVideoCompositor, DRM_VIDEO_NOTICE, videoTier } from "./video";

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function fakeVideo(src: string | null) {
  const attributes = new Map<string, string>();
  if (src !== null) attributes.set("src", src);
  return {
    nodeType: 1,
    nodeName: "VIDEO",
    ownerDocument: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    autoplay: false,
    controls: false,
    currentTime: 0,
    defaultMuted: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    querySelectorAll: () => [],
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("viewer video tiers", () => {
  it("starts a proxied direct MP4 muted with native unmute/seek controls and keeps its Range URL", () => {
    const proxied = "/s/session-a/a/sealed-video-token";
    const video = fakeVideo(proxied);
    const compositor = createVideoCompositor();

    expect(compositor.onBuild(video, 8)).toBe("direct");
    expect(video.autoplay).toBe(true);
    expect(video.defaultMuted).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.play).toHaveBeenCalledOnce();

    // Native seeking retains the proxied src; the browser's byte request therefore reaches the
    // existing Lane-B Range route instead of being replaced by the RTC lane.
    video.currentTime = 37;
    expect(video.currentTime).toBe(37);
    expect(video.getAttribute("src")).toBe(proxied);
    expect(video.srcObject).toBeNull();
  });

  it("classifies MSE/blob players for RTC and assigns the original audio+video stream", () => {
    const video = fakeVideo("blob:https://player.example/media-source");
    const compositor = createVideoCompositor();
    const videoTrack = fakeTrack("video");
    const audioTrack = fakeTrack("audio");
    const stream = {
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
      getTracks: () => [videoTrack, audioTrack],
    } as unknown as MediaStream;

    expect(videoTier(video)).toBe("rtc");
    expect(compositor.onBuild(video, 9)).toBe("rtc");
    const cleanup = compositor.startStream(video, stream, vi.fn());

    expect(video.srcObject).toBe(stream);
    expect(stream.getAudioTracks()).toEqual([audioTrack]);
    expect(video.muted).toBe(true);
    expect(video.controls).toBe(false);
    cleanup();
    expect(video.srcObject).toBeNull();
  });

  it("exposes the exact DRM notice to the viewer/HUD signal", () => {
    const onNotice = vi.fn();
    const compositor = createVideoCompositor({ onNotice });

    compositor.showBlocked(12, new DOMException("tainted", "SecurityError"), "drm");

    expect(onNotice).toHaveBeenCalledWith(
      expect.objectContaining({ notice: "drm", id: 12, message: DRM_VIDEO_NOTICE }),
    );
    expect(DRM_VIDEO_NOTICE).toBe("Media unavailable in DOM view — use pixel view");
  });

  describe("sound from a stream", () => {
    function streamed(
      hasUserActivation: () => boolean,
      playing: (video: { srcObject: unknown }) => Promise<void> = async () => undefined,
    ) {
      const listeners = new Map<string, Set<() => void>>();
      const document = {
        addEventListener(name: string, listener: () => void) {
          (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(listener);
        },
        removeEventListener(name: string, listener: () => void) {
          listeners.get(name)?.delete(listener);
        },
      };
      const video = {
        ownerDocument: document,
        muted: true,
        controls: true,
        srcObject: null as unknown,
        addEventListener() {},
        removeEventListener() {},
        pause() {},
        play: () => playing(video),
      };
      const track = { addEventListener() {}, removeEventListener() {} };
      const stream = { getVideoTracks: () => [track] };
      const compositor = createVideoCompositor({
        document: null as never,
        hasUserActivation,
      });
      const stop = compositor.startStream(
        video as unknown as HTMLVideoElement,
        stream as unknown as MediaStream,
        () => undefined,
      );
      const press = () => {
        for (const listener of [...(listeners.get("pointerdown") ?? [])]) listener();
      };
      return { video, press, stop, listeners };
    }

    it("starts muted for someone who has not used the viewer, and takes sound at their first press", () => {
      const { video, press } = streamed(() => false);
      expect(video.muted).toBe(true);
      press();
      expect(video.muted).toBe(false);
    });

    it("has sound at once for someone already using the viewer", () => {
      expect(streamed(() => true).video.muted).toBe(false);
    });

    it("keeps the sound when the only thing stopping a play is a new load", async () => {
      const { video } = streamed(
        () => true,
        () => Promise.reject(new DOMException("interrupted by a new load", "AbortError")),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(video.muted).toBe(false);
    });

    it("assigns the stream before any play, so nothing interrupts the play that has the sound", () => {
      const sources: unknown[] = [];
      const { video } = streamed(
        () => true,
        (played) => {
          sources.push(played.srcObject);
          return Promise.resolve();
        },
      );
      expect(sources.length).toBeGreaterThan(0);
      expect(new Set(sources)).toEqual(new Set([video.srcObject]));
      expect(video.srcObject).not.toBeNull();
    });

    it("goes back to muted when the browser refuses, and tries again at the next press", async () => {
      let refuse = true;
      const { video, press } = streamed(
        () => true,
        () =>
          refuse
            ? Promise.reject(new DOMException("no sound yet", "NotAllowedError"))
            : Promise.resolve(),
      );
      await new Promise((resolve) => setTimeout(resolve));
      expect(video.muted).toBe(true);
      refuse = false;
      press();
      expect(video.muted).toBe(false);
    });

    it("leaves clicks to the remote page's own controls", () => {
      expect(streamed(() => false).video.controls).toBe(false);
    });

    it("stops listening when the stream ends", () => {
      const { stop, listeners } = streamed(() => false);
      stop();
      expect(listeners.get("pointerdown")?.size).toBe(0);
    });
  });
});
