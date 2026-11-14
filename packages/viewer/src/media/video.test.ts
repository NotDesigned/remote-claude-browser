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

function noticeFixture() {
  class Element {
    dataset: Record<string, string> = {};
    style = {};
    textContent = "";
    parentElement: Element | null = null;
    children: Element[] = [];
    setAttribute() {}
    appendChild(child: Element) {
      child.parentElement = this;
      this.children.push(child);
    }
    remove() {
      const parent = this.parentElement;
      if (parent) parent.children.splice(parent.children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  const body = new Element();
  const hud = new Element();
  body.appendChild(hud);
  const document = {
    body,
    getElementById: () => hud,
    querySelector: () => hud.children[0] ?? null,
    createElement: () => new Element(),
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Document;
  const makeVideo = (src: string | null) => {
    const listeners = new Map<string, Set<() => void>>();
    const video = fakeVideo(src);
    Object.assign(video, {
      ownerDocument: document,
      parentElement: body,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 320, height: 180 }),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: () => void) => {
        listeners.get(type)?.delete(listener);
      }),
    });
    return {
      video,
      listeners,
      playing: () => {
        for (const listener of listeners.get("playing") ?? []) listener();
      },
    };
  };
  return {
    document,
    body,
    hud,
    makeVideo,
    overlays: () => body.children.filter((node) => node !== hud),
  };
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

  it("shows no notice merely for discovering a direct or not-yet-loaded video", () => {
    const f = noticeFixture();
    const compositor = createVideoCompositor({ document: f.document });
    compositor.onBuild(f.makeVideo("/video.mp4").video, 1);
    compositor.onBuild(f.makeVideo(null).video, 2);
    expect(f.hud.children).toHaveLength(0);
    expect(f.overlays()).toHaveLength(0);
    compositor.dispose();
  });

  it("clears a reported block only when that video's playback actually starts", () => {
    const f = noticeFixture();
    const target = f.makeVideo("/video.mp4");
    const compositor = createVideoCompositor({ document: f.document });
    compositor.onBuild(target.video, 1);
    compositor.showBlocked(1, undefined, "drm");
    expect(target.video.pause).not.toHaveBeenCalled();
    expect(f.hud.children[0]?.textContent).toBe(DRM_VIDEO_NOTICE);
    expect(f.overlays()).toHaveLength(1);
    target.playing();
    expect(f.hud.children).toHaveLength(0);
    expect(f.hud.dataset.mediaNotice).toBeUndefined();
    expect(f.overlays()).toHaveLength(0);
    compositor.dispose();
  });

  it("keeps the HUD until all failed videos recover, including a resumed RTC stream", () => {
    const f = noticeFixture();
    const first = f.makeVideo("/video.mp4");
    const second = f.makeVideo("blob:https://example.test/video");
    const compositor = createVideoCompositor({
      document: f.document,
      hasUserActivation: () => false,
    });
    compositor.onBuild(first.video, 1);
    compositor.onBuild(second.video, 2);
    compositor.showBlocked(1);
    compositor.showBlocked(2);
    expect(f.overlays()).toHaveLength(2);
    first.playing();
    expect(f.overlays()).toHaveLength(1);
    expect(f.hud.children).toHaveLength(1);
    const track = fakeTrack("video");
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    const stop = compositor.startStream(second.video, stream, vi.fn());
    expect(f.hud.children).toHaveLength(1);
    second.playing();
    expect(f.overlays()).toHaveLength(0);
    expect(f.hud.children).toHaveLength(0);
    stop();
    compositor.dispose();
  });

  it("ignores a stale playing event from a replaced node and removes its notices on teardown", () => {
    const f = noticeFixture();
    const old = f.makeVideo("/old.mp4");
    const current = f.makeVideo("/new.mp4");
    const compositor = createVideoCompositor({ document: f.document });
    compositor.onBuild(old.video, 7);
    const stalePlaying = [...old.listeners.get("playing")!][0]!;
    compositor.showBlocked(7);
    compositor.onBuild(current.video, 7);
    expect(old.listeners.get("playing")?.size).toBe(0);
    stalePlaying();
    expect(f.hud.children).toHaveLength(1);
    expect(f.overlays()).toHaveLength(1);
    current.playing();
    expect(f.hud.children).toHaveLength(0);
    compositor.showBlocked(7);
    compositor.dispose();
    expect(f.hud.children).toHaveLength(0);
    expect(f.hud.dataset.mediaNotice).toBeUndefined();
    expect(f.overlays()).toHaveLength(0);
    expect(current.listeners.get("playing")?.size).toBe(0);
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
