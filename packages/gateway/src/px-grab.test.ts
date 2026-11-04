import type { Down } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FlatSessionEventMap } from "./browser/launch";
import { TabHub } from "./hub/tabhub";
import { createScreencast } from "./px";
import type { GrabRegion, VideoEncoderEvents } from "./px-video";
import type { TargetRef } from "./types";

const PX = { t: "mode", tab: "tab-1", mode: "px", quality: "smooth", video: true } as const;
const DOM = { t: "mode", tab: "tab-1", mode: "dom" } as const;
const TICK_MS = 250;

function setup(options: { slot?: number | null; placeFails?: boolean; dpr?: number } = {}) {
  vi.useFakeTimers();
  let attached: ((target: TargetRef) => void) | undefined;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const hub = new TabHub({ sessionId: "session", tabId: "tab-1" });
  hub.viewport = { w: 1441, h: 900, dpr: options.dpr ?? 1 };
  const slots = { next: options.slot === undefined ? 1280 : options.slot, released: 0 };
  const encoders: { region: GrabRegion; events: VideoEncoderEvents; closed: boolean }[] = [];
  const window = {
    place: vi.fn(async (_target: string, _left: number, _w: number, _h: number) => {
      if (options.placeFails) throw new Error("no such window");
    }),
    keepOnTop: vi.fn(async () => {}),
    restore: vi.fn(async () => {
      calls.push({ method: "restore window" });
    }),
  };
  const published: Down[] = [];
  const errors: unknown[] = [];
  const backlog = { value: false };
  const controller = createScreencast({
    browser: {
      send: (async (_session: string, method: string, params?: Record<string, unknown>) => {
        calls.push({ method, ...(params ? { params } : {}) });
        if (method === "Runtime.evaluate") return { result: { value: options.dpr ?? 1 } };
        return {};
      }) as never,
      onAttached: (callback: (target: TargetRef) => void) => void (attached = callback),
      onDetached: () => {},
      onSessionEvent: (() => () => {}) as unknown as <K extends keyof FlatSessionEventMap>(
        method: K,
        callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
      ) => () => void,
    },
    hubFor: () => hub,
    publish: (message) => {
      published.push(message);
      if (message.t === "mode") calls.push({ method: `mode ${message.mode}` });
    },
    onError: (error) => errors.push(error),
    backlogged: () => backlog.value,
    browserZoom: {
      press: async (_target, level) => {
        calls.push({ method: `press ${level}` });
      },
      forget: () => {},
    },
    createVideoEncoder: () => ({ write: () => {}, close: () => {} }),
    grab: {
      window,
      acquire: () => {
        const left = slots.next;
        slots.next = null;
        return left;
      },
      release: () => {
        slots.released++;
        slots.next = 1280;
      },
      available: () => slots.next !== null,
      createEncoder: (_crf, region, events) => {
        const encoder = { region, events, closed: false };
        encoders.push(encoder);
        return {
          write: () => {},
          close: () => {
            encoder.closed = true;
          },
        };
      },
    },
  });
  attached!({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });
  const started = () => calls.filter(({ method }) => method === "Page.startScreencast").length;
  const metrics = () =>
    calls
      .filter(({ method }) => method === "Emulation.setDeviceMetricsOverride")
      .map((c) => c.params);
  return {
    calls,
    hub,
    slots,
    encoders,
    window,
    published,
    errors,
    backlog,
    controller,
    started,
    metrics,
  };
}

describe("screen grab", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the page off the display, in its slot, with no screencast", async () => {
    const { controller, window, encoders, started, published } = setup();
    await controller.handle(PX);
    expect(started()).toBe(0);
    // An odd side cannot be encoded, so the last column stays out of the picture.
    expect(window.place).toHaveBeenCalledWith("tab-1", 1280, 1440, 900);
    expect(encoders[0]!.region).toEqual({ left: 1280, width: 1440, height: 900 });
    expect(published).toContainEqual({ t: "mode", tab: "tab-1", mode: "px" });
    controller.dispose();
  });

  it("draws at a density of 1 so the page fills the window, and gives the real one back", async () => {
    const { controller, metrics, window, slots, encoders } = setup({ dpr: 2 });
    await controller.handle(PX);
    expect(metrics().at(-1)).toMatchObject({ width: 1441, height: 900, deviceScaleFactor: 1 });
    await controller.handle(DOM);
    expect(metrics().at(-1)).toMatchObject({ deviceScaleFactor: 2 });
    expect(window.restore).toHaveBeenCalledWith("tab-1");
    expect(slots.released).toBe(1);
    expect(encoders[0]!.closed).toBe(true);
    controller.dispose();
  });

  it("never lays the page out narrow, and shows it only once it is back in shape", async () => {
    const { controller, calls } = setup({ dpr: 2 });
    await controller.handle({ ...PX, quality: "sharp" });
    const zoomed = calls.findIndex(({ method }) => method === "press 2");
    const widened = calls.findIndex(
      ({ method, params }) =>
        method === "Emulation.setDeviceMetricsOverride" && params?.width === 2882,
    );
    expect(widened).toBeLessThan(zoomed);

    calls.length = 0;
    await controller.handle(DOM);
    const order = calls
      .map(({ method, params }) =>
        method === "Emulation.setDeviceMetricsOverride"
          ? `metrics ${String(params?.width)}`
          : method,
      )
      .filter((step) => /^(press|metrics|mode|restore)/.test(step));
    expect(order.indexOf("press 1")).toBeLessThan(order.indexOf("metrics 1441"));
    expect(order.at(-1)).toBe("mode dom");
    expect(order).toContain("restore window");
    controller.dispose();
  });

  it("uses the screencast while the screen is full and moves over when a slot frees up", async () => {
    const { controller, slots, started, window, encoders } = setup({ slot: null });
    await controller.handle(PX);
    expect(started()).toBe(1);
    expect(window.place).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(window.place).not.toHaveBeenCalled();

    slots.next = 5120;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(window.place).toHaveBeenCalledWith("tab-1", 5120, 1440, 900);
    expect(encoders).toHaveLength(1);
    controller.dispose();
  });

  it("falls back to the screencast when the window cannot be placed", async () => {
    const { controller, started, slots, errors } = setup({ placeFails: true });
    await controller.handle(PX);
    expect(started()).toBe(1);
    expect(slots.released).toBe(1);
    expect(errors).toHaveLength(1);
    // That lasts for this session, rather than retrying every check.
    await vi.advanceTimersByTimeAsync(TICK_MS * 4);
    expect(started()).toBe(1);
    controller.dispose();
  });

  it("falls back to the screencast when the grab dies, and leaves the display", async () => {
    const { controller, encoders, started, window, slots } = setup();
    await controller.handle(PX);
    encoders[0]!.events.onFailure(new Error("ffmpeg exited"));
    await vi.advanceTimersByTimeAsync(0);
    expect(started()).toBe(1);
    expect(window.restore).toHaveBeenCalled();
    expect(slots.released).toBe(1);
    controller.dispose();
  });

  it("follows the viewer's size and keeps other windows off the picture", async () => {
    const { controller, hub, window, encoders } = setup();
    await controller.handle(PX);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(window.keepOnTop).toHaveBeenCalledWith("tab-1");
    expect(window.place).toHaveBeenCalledTimes(1);

    hub.viewport = { w: 1000, h: 700, dpr: 1 };
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(window.place).toHaveBeenLastCalledWith("tab-1", 1280, 1000, 700);
    expect(encoders[0]!.closed).toBe(true);
    expect(encoders[1]!.region).toEqual({ left: 1280, width: 1000, height: 700 });
    controller.dispose();
  });

  it("starts a new stream once a viewer that fell behind has caught up", async () => {
    const { controller, encoders, published, backlog } = setup();
    await controller.handle(PX);
    const sent = () => published.filter((message) => message.t === "vid").length;
    const chunk = Buffer.from([1]);

    encoders[0]!.events.onChunk(chunk, true);
    expect(sent()).toBe(1);
    backlog.value = true;
    encoders[0]!.events.onChunk(chunk, false);
    backlog.value = false;
    // Everything up to a new keyframe would decode wrongly, so none of it is sent.
    encoders[0]!.events.onChunk(chunk, false);
    expect(sent()).toBe(1);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(encoders[0]!.closed).toBe(true);
    encoders[1]!.events.onChunk(chunk, true);
    expect(sent()).toBe(2);
    controller.dispose();
  });

  it("starts a new stream for a viewer that joins a still page", async () => {
    const { controller, encoders } = setup();
    await controller.handle(PX);
    controller.requestKeyframe("tab-1");
    expect(encoders).toHaveLength(2);
    expect(encoders[0]!.closed).toBe(true);
    controller.dispose();
  });
});
