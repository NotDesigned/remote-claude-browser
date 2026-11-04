import {
  EventType,
  IncrementalSource,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { decodeSent } from "./ws/decode-sent.test-util";
import type { Protocol } from "puppeteer-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoEncoderEvents } from "./px-video";

import type { FlatSessionEventMap } from "./browser/launch";
import { TabHub } from "./hub/tabhub";
import type { CdpSend, TargetRef } from "./types";
import { Fanout } from "./ws/server";
import { STALL_BYTES, ViewerConn, type ViewerSocket } from "./ws/viewerconn";
import { createScreencast } from "./px";
import { createPixelCapacity } from "./px-capacity";

interface Call {
  sessionId: string;
  method: string;
  params?: Record<string, unknown>;
}

class MockBrowser {
  readonly calls: Call[] = [];
  respond?: CdpSend;
  private readonly attached = new Set<(target: TargetRef) => void>();
  private readonly detached = new Set<(target: TargetRef) => void>();
  private readonly events = new Map<
    keyof FlatSessionEventMap,
    Set<(sessionId: string, event: unknown) => void>
  >();

  readonly send: CdpSend = async (sessionId, method, params) => {
    this.calls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    return this.respond?.(sessionId, method, params) ?? {};
  };

  onAttached(callback: (target: TargetRef) => void): void {
    this.attached.add(callback);
  }

  onDetached(callback: (target: TargetRef) => void): void {
    this.detached.add(callback);
  }

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    const callbacks = this.events.get(method) ?? new Set();
    const erased = callback as (sessionId: string, event: unknown) => void;
    callbacks.add(erased);
    this.events.set(method, callbacks);
    return () => callbacks.delete(erased);
  }

  attach(target: TargetRef): void {
    for (const callback of this.attached) callback(target);
  }

  detach(target: TargetRef): void {
    for (const callback of this.detached) callback(target);
  }

  frame(sessionId: string, event: Protocol.Page.ScreencastFrameEvent): void {
    for (const callback of this.events.get("Page.screencastFrame") ?? []) {
      callback(sessionId, event);
    }
  }
}

class MockSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: (string | Uint8Array)[] = [];

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  messages(): Down[] {
    return this.sent.map((message) => decodeSent(message));
  }
}

function rrweb(docId: number, e: eventWithTime): AgentMsg {
  return { kind: "rrweb", docId, e };
}

function frame(sessionId: number, data: string): Protocol.Page.ScreencastFrameEvent {
  return {
    sessionId,
    data,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1920,
      deviceHeight: 1080,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  };
}

function recordedHub(): TabHub {
  const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
  hub.viewport = { w: 1280, h: 720, dpr: 1 };
  hub.ingest({ kind: "hello", docId: 1, url: "https://fixture.test/", isTop: true, ts: 1 });
  hub.ingest(
    rrweb(1, {
      type: EventType.Meta,
      timestamp: 1,
      data: { href: "https://fixture.test/", width: 1280, height: 720 },
    }),
  );
  hub.ingest(
    rrweb(1, {
      type: EventType.FullSnapshot,
      timestamp: 2,
      data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
    }),
  );
  return hub;
}

describe("createScreencast", () => {
  afterEach(() => vi.useRealTimers());

  describe("browser zoom", () => {
    const setup = async (dpr: number, density = () => dpr) => {
      vi.useFakeTimers();
      const browser = new MockBrowser();
      browser.respond = async (_session, method) =>
        method === "Runtime.evaluate" ? { result: { value: density() } } : {};
      const hub = recordedHub();
      hub.viewport = { w: 1440, h: 900, dpr };
      const pressed: number[] = [];
      const errors: unknown[] = [];
      const published: Down[] = [];
      const controller = createScreencast({
        browser,
        hubFor: () => hub,
        publish: (message) => published.push(message),
        onError: (error) => errors.push(error),
        createVideoEncoder: () => ({ write: () => {}, close: () => {} }),
        browserZoom: {
          press: async (_target, level) => void pressed.push(level),
          forget: () => {},
        },
      });
      browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
      const metrics = () =>
        browser.calls
          .filter(({ method }) => method === "Emulation.setDeviceMetricsOverride")
          .map(({ params }) => params);
      return { browser, hub, pressed, errors, metrics, controller };
    };
    const px = { t: "mode", tab: "tab-1", mode: "px", quality: "high", video: true } as const;

    it("widens the window and zooms a high-density page to reach device resolution", async () => {
      const { hub, pressed, metrics, controller } = await setup(2);
      await controller.handle(px);
      expect(pressed).toEqual([2]);
      expect(hub.pixelZoom).toBe(2);
      expect(metrics()).toEqual([
        { width: 2880, height: 1800, deviceScaleFactor: 1, mobile: false },
      ]);
      controller.dispose();
    });

    it("restores the window and zoom when leaving the picture", async () => {
      const { hub, pressed, metrics, controller } = await setup(2);
      await controller.handle(px);
      await controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
      expect(pressed).toEqual([2, 1]);
      expect(hub.pixelZoom).toBe(1);
      expect(metrics().at(-1)).toEqual({
        width: 1440,
        height: 900,
        deviceScaleFactor: 2,
        mobile: false,
      });
      controller.dispose();
    });

    it("leaves a normal display and lower qualities alone", async () => {
      const normal = await setup(1);
      await normal.controller.handle(px);
      expect(normal.pressed).toEqual([]);
      normal.controller.dispose();
      const medium = await setup(2);
      await medium.controller.handle({ ...px, quality: "medium" });
      expect(medium.pressed).toEqual([]);
      medium.controller.dispose();
    });

    it("gives up on zoom and restores the page when it has no effect", async () => {
      const { hub, pressed, errors, metrics, controller } = await setup(2, () => 1);
      const started = controller.handle(px);
      await vi.advanceTimersByTimeAsync(2_000);
      await started;
      expect(hub.pixelZoom).toBe(1);
      expect(pressed).toEqual([2, 1]);
      expect(metrics().at(-1)).toMatchObject({ width: 1440, deviceScaleFactor: 2 });
      expect(String(errors[0])).toContain("did not take effect");
      controller.dispose();
    });
  });

  describe("video frames", () => {
    const setup = async (backlogged = () => false) => {
      vi.useFakeTimers();
      const browser = new MockBrowser();
      const hub = recordedHub();
      const published: Down[] = [];
      const encoders: {
        crf: number;
        written: string[];
        closed: boolean;
        events: VideoEncoderEvents;
      }[] = [];
      const controller = createScreencast({
        browser,
        hubFor: () => hub,
        publish: (message) => published.push(message),
        backlogged,
        createVideoEncoder: (crf, events) => {
          const encoder = { crf, written: [] as string[], closed: false, events };
          encoders.push(encoder);
          return {
            write: (jpeg) => encoder.written.push(jpeg.toString("base64")),
            close: () => {
              encoder.closed = true;
            },
          };
        },
      });
      browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
      await controller.handle({
        t: "mode",
        tab: "tab-1",
        mode: "px",
        quality: "high",
        video: true,
      });
      return { browser, hub, published, encoders, controller };
    };

    it("encodes frames instead of sending JPEG, at a higher capture rate", async () => {
      const { browser, published, encoders, controller } = await setup();
      expect(browser.calls.find(({ method }) => method === "Page.startScreencast")?.params).toEqual(
        {
          format: "jpeg",
          quality: 85,
          everyNthFrame: 1,
          maxWidth: 3840,
          maxHeight: 3840,
        },
      );
      browser.frame("cdp-1", frame(1, "AAAA"));
      expect(encoders[0]!.crf).toBe(18);
      expect(encoders[0]!.written).toEqual(["AAAA"]);
      expect(published.some((message) => message.t === "px")).toBe(false);

      encoders[0]!.events.onConfig({ codec: "avc1.64001f", description: Buffer.from([1]) });
      encoders[0]!.events.onChunk(Buffer.from([9]), true);
      encoders[0]!.events.onChunk(Buffer.from([8]), false);
      expect(published.filter((message) => message.t !== "mode")).toMatchObject([
        { t: "vid-cfg", codec: "avc1.64001f", description: "AQ==" },
        { t: "vid", seq: 0, key: true, w: 1280, h: 720 },
        { t: "vid", seq: 1, key: false },
      ]);
      controller.dispose();
    });

    it("pushes the last frame out of the encoder once the picture goes quiet", async () => {
      const { browser, encoders, controller } = await setup();
      browser.frame("cdp-1", frame(1, "AAAA"));
      await vi.advanceTimersByTimeAsync(39);
      expect(encoders[0]!.written).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(encoders[0]!.written).toEqual(["AAAA", "AAAA", "AAAA", "AAAA"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(encoders[0]!.written).toHaveLength(4);
      controller.dispose();
    });

    it("drops frames before encoding while a viewer cannot keep up", async () => {
      let behind = true;
      const { browser, encoders, controller } = await setup(() => behind);
      browser.frame("cdp-1", frame(1, "AAAA"));
      expect(encoders[0]!.written).toEqual([]);
      behind = false;
      browser.frame("cdp-1", frame(2, "BBBB"));
      expect(encoders[0]!.written).toEqual(["BBBB"]);
      controller.dispose();
    });

    it("starts a new stream on request and when the page size changes", async () => {
      const { browser, hub, encoders, controller } = await setup();
      browser.frame("cdp-1", frame(1, "AAAA"));
      controller.requestKeyframe("tab-1");
      expect(encoders).toHaveLength(2);
      expect(encoders[0]!.closed).toBe(true);
      expect(encoders[1]!.written).toEqual(["AAAA"]);
      hub.viewport = { w: 800, h: 600, dpr: 1 };
      browser.frame("cdp-1", frame(2, "BBBB"));
      expect(encoders).toHaveLength(3);
      controller.dispose();
    });

    it("falls back to JPEG when the encoder fails", async () => {
      const { browser, published, encoders, controller } = await setup();
      browser.frame("cdp-1", frame(1, "AAAA"));
      encoders[0]!.events.onFailure(new Error("ffmpeg missing"));
      browser.frame("cdp-1", frame(2, "BBBB"));
      expect(published.at(-1)).toMatchObject({ t: "px", data: "BBBB" });
      expect(encoders).toHaveLength(1);
      controller.dispose();
    });

    it("stops the encoder when leaving the picture", async () => {
      const { browser, encoders, controller } = await setup();
      browser.frame("cdp-1", frame(1, "AAAA"));
      await controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
      expect(encoders[0]!.closed).toBe(true);
      controller.dispose();
    });
  });

  describe("sharp frames", () => {
    const setup = async (dpr = 2, requested: "high" | "medium" = "medium") => {
      vi.useFakeTimers();
      const browser = new MockBrowser();
      browser.respond = async (_session, method) =>
        method === "Page.captureScreenshot" ? { data: "PNGDATA" } : {};
      const hub = recordedHub();
      hub.viewport = { w: 1280, h: 720, dpr };
      const published: Down[] = [];
      const controller = createScreencast({
        browser,
        hubFor: () => hub,
        publish: (message) => published.push(message),
      });
      browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
      await controller.handle({ t: "mode", tab: "tab-1", mode: "px", quality: requested });
      const frames = () => published.filter((message) => message.t === "px");
      const shots = () => browser.calls.filter(({ method }) => method === "Page.captureScreenshot");
      return { browser, frames, shots, controller };
    };

    it("sends one sharp frame once the page has been still", async () => {
      const { browser, frames, shots, controller } = await setup();
      browser.frame("cdp-1", frame(1, "moving"));
      expect(frames().at(-1)).toMatchObject({ data: "moving" });
      await vi.advanceTimersByTimeAsync(349);
      expect(shots()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(shots()[0]!.params).toMatchObject({ format: "webp", optimizeForSpeed: true });
      expect(frames().at(-1)).toMatchObject({ data: "PNGDATA", w: 1280, h: 720 });

      // Chromium repeating the same picture must not put the JPEG back.
      browser.frame("cdp-1", frame(2, "moving"));
      expect(frames().at(-1)).toMatchObject({ data: "PNGDATA" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(shots()).toHaveLength(1);
      controller.dispose();
    });

    it("stays sharp around a part of the page that never stops moving", async () => {
      const { browser, frames, shots, controller } = await setup();
      for (let index = 0; index < 70; index++) {
        browser.frame("cdp-1", frame(index, `moving-${index}`));
        await vi.advanceTimersByTimeAsync(100);
      }
      // One soon after the motion starts, then about every three seconds of it.
      expect(shots().length).toBeGreaterThanOrEqual(2);
      expect(shots().length).toBeLessThanOrEqual(4);
      expect(frames().some((message) => message.t === "px" && message.data === "PNGDATA")).toBe(
        true,
      );
      controller.dispose();
    });

    it("backs off when only a lone change repeats, like a blinking caret", async () => {
      const { browser, shots, controller } = await setup();
      for (let blink = 0; blink < 10; blink++) {
        browser.frame("cdp-1", frame(blink, `caret-${blink % 2}`));
        await vi.advanceTimersByTimeAsync(530);
      }
      expect(shots().length).toBeLessThanOrEqual(3);
      controller.dispose();
    });
  });

  it("captures at the requested detail and restarts only the capture when it changes", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    hub.viewport = { w: 1920, h: 1080, dpr: 1 };
    const sent: Down[] = [];
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const send: CdpSend = async (session, method, params) => {
      calls.push({ method, params: params as Record<string, unknown> | undefined });
      if (method === "Page.startScreencast") browser.frame(session, frame(1, "first"));
      return {};
    };
    const controller = createScreencast({
      browser: {
        send,
        onAttached: browser.onAttached.bind(browser),
        onDetached: browser.onDetached.bind(browser),
        onSessionEvent: browser.onSessionEvent.bind(browser),
      },
      hubFor: () => hub,
      publish: (message) => sent.push(message),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    const capture = () => calls.filter(({ method }) => /Page\.(start|stop)Screencast/.test(method));

    await controller.handle({ t: "mode", tab: "tab-1", mode: "px", quality: "low" });
    expect(capture()).toEqual([
      {
        method: "Page.startScreencast",
        params: { format: "jpeg", quality: 50, everyNthFrame: 3, maxWidth: 1280, maxHeight: 1280 },
      },
    ]);

    await controller.handle({ t: "mode", tab: "tab-1", mode: "px", quality: "high" });
    expect(capture().slice(1)).toEqual([
      { method: "Page.stopScreencast", params: undefined },
      {
        method: "Page.startScreencast",
        params: { format: "jpeg", quality: 80, everyNthFrame: 2, maxWidth: 3840, maxHeight: 3840 },
      },
    ]);
    expect(hub.mode).toBe("px");
    expect(sent.filter((message) => message.t === "mode").at(-1)).toMatchObject({ mode: "px" });

    // The same value, no value and an unknown value never restart the capture.
    const before = capture().length;
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px", quality: "high" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await controller.handle({
      t: "mode",
      tab: "tab-1",
      mode: "px",
      quality: "constructor" as never,
    });
    expect(capture()).toHaveLength(before);
    controller.dispose();
  });

  it("keeps an early first frame and replays it on repeated pixel requests", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    const sent: Down[] = [];
    const send: CdpSend = async (session, method) => {
      if (method === "Page.startScreencast") browser.frame(session, frame(1, "first"));
      return {};
    };
    const controller = createScreencast({
      browser: {
        send,
        onAttached: browser.onAttached.bind(browser),
        onDetached: browser.onDetached.bind(browser),
        onSessionEvent: browser.onSessionEvent.bind(browser),
      },
      hubFor: () => hub,
      publish: (message) => sent.push(message),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(sent.some((message) => message.t === "px" && message.data === "first")).toBe(true);
    expect(sent.slice(-2).map((message) => message.t)).toEqual(["mode", "px"]);
    sent.length = 0;
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(sent.map((message) => message.t)).toEqual(["mode", "px"]);
    controller.dispose();
  });

  it("toggles px/dom, acks every frame, drops backpressured frames, and leaves rrweb recording", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    hub.viewport = { w: 1280, h: 720, dpr: 1 };
    const fanout = new Fanout();
    const fastSocket = new MockSocket();
    const slowSocket = new MockSocket();
    const fast = new ViewerConn(fastSocket, () => hub.joinPayload());
    const slow = new ViewerConn(slowSocket, () => hub.joinPayload());
    fanout.addViewer(fast);
    fanout.addViewer(slow);
    const controller = createScreencast({
      browser,
      hubFor: (tabId) => (tabId === "tab-1" ? hub : undefined),
      publish: (message) => fanout.publish(message),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });

    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(hub.mode).toBe("px");
    expect(browser.calls.some(({ method }) => method === "Page.bringToFront")).toBe(true);
    expect(browser.calls.find(({ method }) => method === "Page.startScreencast")).toEqual({
      sessionId: "cdp-1",
      method: "Page.startScreencast",
      params: {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 2,
        maxWidth: 3840,
        maxHeight: 3840,
      },
    });

    // The semantic recorder remains live in px mode: it opens and advances the same TabHub.
    hub.ingest({
      kind: "hello",
      docId: 1,
      url: "https://video.test/",
      isTop: true,
      ts: 1,
    });
    hub.ingest(
      rrweb(1, {
        type: EventType.Meta,
        timestamp: 1,
        data: { href: "https://video.test/", width: 1280, height: 720 },
      }),
    );
    hub.ingest(
      rrweb(1, {
        type: EventType.FullSnapshot,
        timestamp: 2,
        data: {
          node: { type: 0, id: 1, childNodes: [] },
          initialOffset: { top: 0, left: 0 },
        },
      }),
    );
    hub.ingest(
      rrweb(1, {
        type: EventType.IncrementalSnapshot,
        timestamp: 3,
        data: { source: IncrementalSource.Scroll, id: 0, x: 0, y: 42 },
      }),
    );
    expect(hub.seq).toBe(2);
    expect(hub.deltas).toHaveLength(1);

    fastSocket.sent.splice(0);
    slowSocket.sent.splice(0);
    slowSocket.bufferedAmount = STALL_BYTES + 1;
    browser.frame("cdp-1", frame(101, "jpegAAAA"));
    browser.frame("cdp-1", frame(102, "jpegBBBB"));

    const acknowledgements = browser.calls.filter(
      ({ method }) => method === "Page.screencastFrameAck",
    );
    expect(acknowledgements).toEqual([
      {
        sessionId: "cdp-1",
        method: "Page.screencastFrameAck",
        params: { sessionId: 101 },
      },
      {
        sessionId: "cdp-1",
        method: "Page.screencastFrameAck",
        params: { sessionId: 102 },
      },
    ]);
    expect(fastSocket.messages().filter((message) => message.t === "px")).toEqual([
      { t: "px", tab: "tab-1", data: "jpegAAAA", w: 1280, h: 720 },
      { t: "px", tab: "tab-1", data: "jpegBBBB", w: 1280, h: 720 },
    ]);
    expect(slowSocket.messages().filter((message) => message.t === "px")).toEqual([]);
    expect(slow.isStalled).toBe(true);

    await controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    fanout.flushAll();
    expect(hub.mode).toBe("dom");
    expect(browser.calls.some(({ method }) => method === "Page.stopScreencast")).toBe(true);
    const fastMessages = fastSocket.messages();
    const domIndex = fastMessages.findIndex(
      (message) => message.t === "mode" && message.mode === "dom",
    );
    expect(domIndex).toBeGreaterThanOrEqual(0);
    expect(fastMessages.slice(domIndex + 1).some((message) => message.t === "resync")).toBe(true);
    expect(fastMessages.slice(domIndex + 1).some((message) => message.t === "snapshot")).toBe(true);
    expect(fastMessages.slice(domIndex + 1).some((message) => message.t === "delta")).toBe(true);

    // A frame already in flight when stop completes is still acknowledged and not forwarded.
    browser.frame("cdp-1", frame(103, "late-jpeg"));
    expect(
      browser.calls.filter(({ method }) => method === "Page.screencastFrameAck").at(-1),
    ).toEqual({
      sessionId: "cdp-1",
      method: "Page.screencastFrameAck",
      params: { sessionId: 103 },
    });
    expect(
      fastSocket.messages().some((message) => message.t === "px" && message.data === "late-jpeg"),
    ).toBe(false);

    controller.dispose();
    fanout.close();
  });

  it("serializes rapid mode transitions and reports unknown tabs", async () => {
    const browser = new MockBrowser();
    const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: vi.fn(),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });

    const toPx = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    const toDom = controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    await Promise.all([toPx, toDom]);

    expect(
      browser.calls
        .filter(
          ({ method }) => method === "Page.startScreencast" || method === "Page.stopScreencast",
        )
        .map(({ method }) => method),
    ).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
    expect(controller.modeFor("tab-1")).toBe("dom");
    await expect(controller.handle({ t: "mode", tab: "missing", mode: "px" })).rejects.toThrow(
      "unknown screencast tab",
    );
    controller.dispose();
  });

  it("bounds a hung start, restores DOM and join state, and leaves the mode queue usable", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser();
    browser.respond = async (_session, method) =>
      method === "Page.startScreencast" ? new Promise(() => {}) : {};
    const hub = recordedHub();
    const sent: Down[] = [];
    const onError = vi.fn();
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      onError,
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    const starting = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await vi.advanceTimersByTimeAsync(99);
    expect(hub.mode).toBe("dom");
    expect(sent.some((message) => message.t === "mode" && message.mode === "px")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Page.startScreencast timed out after 100ms" }),
    );
    expect(sent.map((message) => message.t)).toEqual(["mode", "resync", "snapshot"]);
    expect(hub.mode).toBe("dom");
    browser.respond = async (session, method) => {
      if (method === "Page.startScreencast") browser.frame(session, frame(2, "recovered"));
      return {};
    };
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(hub.mode).toBe("px");
    expect(sent.at(-1)).toMatchObject({ t: "px", data: "recovered" });
    controller.dispose();
  });

  it("restores DOM even when stopping the renderer never responds", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser();
    browser.respond = async (session, method) => {
      if (method === "Page.startScreencast") browser.frame(session, frame(1, "before-stop"));
      if (method === "Page.stopScreencast") return new Promise(() => {});
      return {};
    };
    const hub = recordedHub();
    const sent: Down[] = [];
    const onError = vi.fn();
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      onError,
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    const stopping = controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.mode).toBe("dom");
    expect(sent.at(-1)?.t).toBe("snapshot");
    browser.frame("cdp-1", frame(2, "after-stop"));
    expect(sent.some((message) => message.t === "px" && message.data === "after-stop")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Page.stopScreencast timed out after 100ms" }),
    );
    controller.dispose();
  });

  it("seeds a missing first frame once with a bounded viewport capture, without periodic screenshots", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser();
    browser.respond = async (_session, method) =>
      method === "Page.captureScreenshot" ? { data: "fallback-jpeg" } : {};
    const hub = recordedHub();
    hub.viewport = { w: 4000, h: 2000, dpr: 2 };
    const sent: Down[] = [];
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      firstFrameTimeoutMs: 20,
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px", quality: "medium" });
    expect(sent.map((message) => message.t)).toEqual(["mode"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(sent.at(-1)).toEqual({ t: "px", tab: "tab-1", data: "fallback-jpeg", w: 4000, h: 2000 });
    expect(browser.calls.find(({ method }) => method === "Page.captureScreenshot")?.params).toEqual(
      {
        format: "jpeg",
        quality: 65,
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 4000, height: 2000, scale: 0.24 },
      },
    );
    expect(
      browser.calls.find(({ method }) => method === "Page.startScreencast")?.params,
    ).toMatchObject({ maxWidth: 1920, maxHeight: 1920 });
    await vi.advanceTimersByTimeAsync(10000);
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(browser.calls.filter(({ method }) => method === "Page.captureScreenshot")).toHaveLength(
      1,
    );
    browser.frame("cdp-1", frame(3, "native-after-fallback"));
    expect(sent.at(-1)).toMatchObject({ t: "px", data: "native-after-fallback" });
    controller.dispose();
  });

  it("retries an empty repeated pixel request immediately and lets a native frame win the capture race", async () => {
    vi.useFakeTimers();
    let finishCapture!: (value: unknown) => void;
    const capture = new Promise((resolve) => {
      finishCapture = resolve;
    });
    const browser = new MockBrowser();
    browser.respond = async (_session, method) =>
      method === "Page.captureScreenshot" ? capture : {};
    const hub = recordedHub();
    const sent: Down[] = [];
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      firstFrameTimeoutMs: 50,
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(browser.calls.filter(({ method }) => method === "Page.captureScreenshot")).toHaveLength(
      1,
    );
    browser.frame("cdp-1", frame(4, "native-wins"));
    finishCapture({ data: "older-capture" });
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.mode).toBe("px");
    expect(sent.some((message) => message.t === "px" && message.data === "older-capture")).toBe(
      false,
    );
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(sent.at(-1)).toMatchObject({ t: "px", data: "native-wins" });
    expect(browser.calls.filter(({ method }) => method === "Page.captureScreenshot")).toHaveLength(
      1,
    );
    controller.dispose();
  });

  it("returns to DOM after an unresponsive first-frame capture instead of staying in empty pixel mode", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser();
    browser.respond = async (_session, method) =>
      method === "Page.captureScreenshot" ? new Promise(() => {}) : {};
    const hub = recordedHub();
    const sent: Down[] = [];
    const onError = vi.fn();
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      onError,
      firstFrameTimeoutMs: 20,
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await vi.advanceTimersByTimeAsync(120);
    expect(hub.mode).toBe("dom");
    expect(sent.slice(-3).map((message) => message.t)).toEqual(["mode", "resync", "snapshot"]);
    expect(sent.some((message) => message.t === "px")).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Page.captureScreenshot timed out after 100ms" }),
    );
    controller.dispose();
  });

  it.each(["detach", "dispose"])("ignores a late fallback result after %s", async (ending) => {
    vi.useFakeTimers();
    let finishCapture!: (value: unknown) => void;
    const capture = new Promise((resolve) => {
      finishCapture = resolve;
    });
    const browser = new MockBrowser();
    browser.respond = async (_session, method) =>
      method === "Page.captureScreenshot" ? capture : {};
    let hub = recordedHub();
    const sent: Down[] = [];
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      firstFrameTimeoutMs: 20,
      commandTimeoutMs: 100,
    });
    const original = { targetId: "tab-1", sessionId: "cdp-old", type: "page" } as const;
    browser.attach(original);
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await vi.advanceTimersByTimeAsync(20);
    expect(browser.calls.filter(({ method }) => method === "Page.captureScreenshot")).toHaveLength(
      1,
    );
    if (ending === "dispose") controller.dispose();
    else {
      browser.detach(original);
      hub = recordedHub();
      browser.attach({ targetId: "tab-1", sessionId: "cdp-new", type: "page" });
    }
    const publishedBeforeLateResult = sent.length;
    finishCapture({ data: "detached-jpeg" });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(publishedBeforeLateResult);
    if (ending === "detach") expect(controller.modeFor("tab-1")).toBe("dom");
    else expect(controller.modeFor("tab-1")).toBeUndefined();
    controller.dispose();
  });

  it("resets a dead startup synchronously and invalidates pixel requests already queued behind it", async () => {
    vi.useFakeTimers();
    let finishStart!: (value: unknown) => void;
    const starting = new Promise((resolve) => {
      finishStart = resolve;
    });
    const browser = new MockBrowser();
    browser.respond = async (_session, method) =>
      method === "Page.startScreencast" ? starting : {};
    const hub = recordedHub();
    const sent: Down[] = [];
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: (message) => sent.push(message),
      firstFrameTimeoutMs: 20,
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
    const toPx = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    const queuedPx = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    await vi.advanceTimersByTimeAsync(0);
    controller.reset("tab-1");
    expect(hub.mode).toBe("dom");
    expect(sent.map((message) => message.t)).toEqual(["mode", "resync", "snapshot"]);
    browser.frame("cdp-1", frame(10, "crashed-frame"));
    finishStart({});
    await Promise.all([toPx, queuedPx]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.some((message) => message.t === "mode" && message.mode === "px")).toBe(false);
    expect(sent.some((message) => message.t === "px")).toBe(false);
    expect(browser.calls.some(({ method }) => method === "Page.captureScreenshot")).toBe(false);
    expect(browser.calls.filter(({ method }) => method === "Page.startScreencast")).toHaveLength(1);
    expect(controller.modeFor("tab-1")).toBe("dom");
    controller.dispose();
  });
});

describe("shared pixel capacity hooks", () => {
  afterEach(() => vi.useRealTimers());

  it("reserves before yielding and holds the global slot until stop acknowledges", async () => {
    const browser = new MockBrowser(),
      capacity = createPixelCapacity(),
      hubA = recordedHub(),
      hubB = recordedHub();
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    browser.respond = async (session, method) => {
      if (method === "Page.startScreencast") browser.frame(session, frame(1, "native"));
      if (session === "cdp-a" && method === "Page.stopScreencast") await stopping;
      return {};
    };
    const acquireA = vi.fn((tab: string) => capacity.acquire("a", tab));
    const releaseA = vi.fn((tab: string) => capacity.release("a", tab));
    const a = createScreencast({
      browser,
      hubFor: (tab) => (tab === "a" ? hubA : undefined),
      publish: vi.fn(),
      acquirePixel: acquireA,
      releasePixel: releaseA,
    });
    const b = createScreencast({
      browser,
      hubFor: (tab) => (tab === "b" ? hubB : undefined),
      publish: vi.fn(),
      acquirePixel: (tab) => capacity.acquire("b", tab),
      releasePixel: (tab) => capacity.release("b", tab),
    });
    browser.attach({ targetId: "a", sessionId: "cdp-a", type: "page" });
    browser.attach({ targetId: "b", sessionId: "cdp-b", type: "page" });
    const first = a.handle({ t: "mode", tab: "a", mode: "px" });
    expect(capacity.holder()).toEqual({ sid: "a", tab: "a" });
    expect(browser.calls).toHaveLength(0);
    await b.handle({ t: "mode", tab: "b", mode: "px" });
    await first;
    expect(hubB.mode).toBe("dom");
    expect(browser.calls.some((call) => call.sessionId === "cdp-b")).toBe(false);
    await a.handle({ t: "mode", tab: "a", mode: "px" });
    expect(acquireA).toHaveBeenCalledOnce();
    const toDom = a.handle({ t: "mode", tab: "a", mode: "dom" });
    await vi.waitFor(() =>
      expect(browser.calls.some((call) => call.method === "Page.stopScreencast")).toBe(true),
    );
    expect(hubA.mode).toBe("dom");
    expect(releaseA).not.toHaveBeenCalled();
    await b.handle({ t: "mode", tab: "b", mode: "px" });
    expect(hubB.mode).toBe("dom");
    finishStop();
    await toDom;
    expect(releaseA).toHaveBeenCalledExactlyOnceWith("a");
    await b.handle({ t: "mode", tab: "b", mode: "px" });
    expect(hubB.mode).toBe("px");
    expect(capacity.holder()).toEqual({ sid: "b", tab: "b" });
    await b.handle({ t: "mode", tab: "b", mode: "dom" });
    a.dispose();
    b.dispose();
    expect(capacity.holder()).toBeUndefined();
  });

  it.each(["start failure", "first-frame failure"])(
    "releases after %s only when stop finishes",
    async (failure) => {
      vi.useFakeTimers();
      const browser = new MockBrowser(),
        capacity = createPixelCapacity(),
        hub = recordedHub();
      let finishStop!: () => void;
      const stop = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      browser.respond = async (_session, method) => {
        if (method === "Page.startScreencast" && failure === "start failure")
          throw new Error("start rejected");
        if (method === "Page.captureScreenshot") throw new Error("capture rejected");
        if (method === "Page.stopScreencast") await stop;
        return {};
      };
      const released = vi.fn((tab: string) => capacity.release("a", tab));
      const controller = createScreencast({
        browser,
        hubFor: () => hub,
        publish: vi.fn(),
        onError: vi.fn(),
        acquirePixel: (tab) => capacity.acquire("a", tab),
        releasePixel: released,
        firstFrameTimeoutMs: 10,
        commandTimeoutMs: 100,
      });
      browser.attach({ targetId: "tab-1", sessionId: "cdp-a", type: "page" });
      const starting = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
      await vi.advanceTimersByTimeAsync(10);
      expect(hub.mode).toBe("dom");
      expect(capacity.holder()).toEqual({ sid: "a", tab: "tab-1" });
      expect(released).not.toHaveBeenCalled();
      finishStop();
      await starting;
      await vi.advanceTimersByTimeAsync(0);
      expect(capacity.holder()).toBeUndefined();
      expect(released).toHaveBeenCalledOnce();
      controller.dispose();
      expect(released).toHaveBeenCalledOnce();
    },
  );

  it.each(["reset", "detach", "dispose", "process swap"])(
    "releases an active slot on %s after bounded stop",
    async (ending) => {
      const browser = new MockBrowser(),
        capacity = createPixelCapacity();
      let hub = recordedHub(),
        finishStop!: () => void;
      const stop = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      browser.respond = async (session, method) => {
        if (method === "Page.startScreencast") browser.frame(session, frame(1, "native"));
        if (method === "Page.stopScreencast") await stop;
        return {};
      };
      const released = vi.fn((tab: string) => capacity.release("a", tab));
      const controller = createScreencast({
        browser,
        hubFor: () => hub,
        publish: vi.fn(),
        acquirePixel: (tab) => capacity.acquire("a", tab),
        releasePixel: released,
      });
      const target = { targetId: "tab-1", sessionId: "cdp-old", type: "page" } as const;
      browser.attach(target);
      await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
      if (ending === "reset") controller.reset("tab-1");
      else if (ending === "detach") browser.detach(target);
      else if (ending === "dispose") controller.dispose();
      else {
        hub = recordedHub();
        browser.attach({ targetId: "tab-1", sessionId: "cdp-new", type: "page" });
        await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
        expect(
          browser.calls.some(
            (call) => call.sessionId === "cdp-new" && call.method === "Page.startScreencast",
          ),
        ).toBe(false);
      }
      expect(capacity.acquire("b", "other")).toBe(false);
      expect(released).not.toHaveBeenCalled();
      finishStop();
      await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
      expect(capacity.acquire("b", "other")).toBe(true);
      controller.dispose();
      expect(capacity.holder()).toEqual({ sid: "b", tab: "other" });
    },
  );

  it("releases a synchronous reservation on reset before any queued encoder starts", async () => {
    const browser = new MockBrowser(),
      capacity = createPixelCapacity(),
      hub = recordedHub();
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: vi.fn(),
      acquirePixel: (tab) => capacity.acquire("a", tab),
      releasePixel: (tab) => capacity.release("a", tab),
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-a", type: "page" });
    const starting = controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(capacity.holder()).toBeDefined();
    controller.reset("tab-1");
    expect(capacity.holder()).toBeUndefined();
    await starting;
    expect(browser.calls.some((call) => call.method === "Page.startScreencast")).toBe(false);
    controller.dispose();
  });

  it("releases on the stop deadline while keeping DOM immediately usable", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser(),
      capacity = createPixelCapacity(),
      hub = recordedHub();
    browser.respond = async (session, method) => {
      if (method === "Page.startScreencast") browser.frame(session, frame(1, "native"));
      if (method === "Page.stopScreencast") return new Promise(() => {});
      return {};
    };
    const controller = createScreencast({
      browser,
      hubFor: () => hub,
      publish: vi.fn(),
      onError: vi.fn(),
      acquirePixel: (tab) => capacity.acquire("a", tab),
      releasePixel: (tab) => capacity.release("a", tab),
      commandTimeoutMs: 100,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-a", type: "page" });
    await controller.handle({ t: "mode", tab: "tab-1", mode: "px" });
    const stopping = controller.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    await vi.advanceTimersByTimeAsync(99);
    expect(hub.mode).toBe("dom");
    expect(capacity.holder()).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(capacity.holder()).toBeUndefined();
    controller.dispose();
  });
});
