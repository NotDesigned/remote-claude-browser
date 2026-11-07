// @vitest-environment node
import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANVAS_SITES,
  matchesCanvasSite,
  startCanvasSampler,
  type CanvasSamplerNatives,
} from "./canvas-sampler";

const at = (hostname: string, pathname = "/") => ({ hostname, pathname });

describe("the sites whose canvases are sampled", () => {
  it("covers the challenge providers, and not the sites they run on", () => {
    expect(matchesCanvasSite(at("newassets.hcaptcha.com"), DEFAULT_CANVAS_SITES)).toBe(true);
    expect(
      matchesCanvasSite(at("www.google.com", "/recaptcha/api2/bframe"), DEFAULT_CANVAS_SITES),
    ).toBe(true);
    expect(matchesCanvasSite(at("www.google.com", "/search"), DEFAULT_CANVAS_SITES)).toBe(false);
    expect(matchesCanvasSite(at("challenges.cloudflare.com"), DEFAULT_CANVAS_SITES)).toBe(true);
    expect(matchesCanvasSite(at("claude.ai"), DEFAULT_CANVAS_SITES)).toBe(false);
    expect(matchesCanvasSite(at("nothcaptcha.com"), DEFAULT_CANVAS_SITES)).toBe(false);
  });

  it("can be every site, or none", () => {
    expect(matchesCanvasSite(at(""), ["*"])).toBe(true);
    expect(matchesCanvasSite(at("hcaptcha.com"), [])).toBe(false);
  });
});

describe("sampling canvases", () => {
  function harness(pictures: Map<object, string>) {
    const canvases = [...pictures.keys()].map((key) => key as HTMLCanvasElement);
    const document = {
      querySelectorAll: (selector: string) => (selector === "canvas" ? canvases : []),
    } as unknown as Document;
    const natives: CanvasSamplerNatives = {
      createImageBitmap: async (canvas) => {
        const picture = pictures.get(canvas);
        if (picture === "unreadable") throw new DOMException("tainted", "SecurityError");
        return { picture, close() {} } as unknown as ImageBitmap;
      },
      OffscreenCanvas: class {
        drawn = "";
        getContext() {
          return { drawImage: (bitmap: { picture: string }) => (this.drawn = bitmap.picture) };
        }
        async convertToBlob() {
          const drawn = this.drawn;
          return {
            type: "image/webp",
            arrayBuffer: async () => new TextEncoder().encode(drawn).buffer,
          };
        }
      } as unknown as typeof OffscreenCanvas,
    };
    const events: eventWithTime[] = [];
    let clock = 0;
    let pending: (() => void) | null = null;
    const sampler = startCanvasSampler({
      document,
      natives,
      getId: (node) => canvases.indexOf(node as HTMLCanvasElement) + 10,
      emit: (event) => events.push(event),
      now: () => clock,
      setTimer: (callback) => {
        pending = callback;
        return 1;
      },
      clearTimer: () => (pending = null),
    });
    const tick = async (advance = 250) => {
      clock += advance;
      const run = pending;
      pending = null;
      run?.();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return { events, sampler, tick, setClock: (value: number) => (clock = value) };
  }
  const canvas = (width = 40, height = 30) =>
    ({
      width,
      height,
      isConnected: true,
      getBoundingClientRect: () => ({ width, height }),
    }) as object;
  const picture = (event: eventWithTime) =>
    atob(
      (
        event.data as unknown as {
          commands: { args: [{ args: [{ data: [{ base64: string }] }] }] }[];
        }
      ).commands[1]!.args[0].args[0].data[0].base64,
    );

  it("sends a picture in the shape of rrweb's canvas snapshots, and only when it changed", async () => {
    const shown = canvas();
    const pictures = new Map<object, string>([[shown, "first"]]);
    const { events, tick } = harness(pictures);

    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.CanvasMutation,
        id: 10,
        type: 0,
        commands: [{ property: "clearRect", args: [0, 0, 40, 30] }, { property: "drawImage" }],
      },
    });
    expect(picture(events[0]!)).toBe("first");

    await tick();
    expect(events).toHaveLength(1);
    pictures.set(shown, "second");
    await tick();
    expect(events.map(picture)).toEqual(["first", "second"]);
  });

  it("sends an unchanged picture again after a while, and at once after a reset", async () => {
    const pictures = new Map<object, string>([[canvas(), "still"]]);
    const { events, sampler, tick } = harness(pictures);
    await tick();
    await tick(11_000);
    expect(events).toHaveLength(2);
    sampler.reset();
    await tick();
    expect(events).toHaveLength(3);
  });

  it("skips empty and unreadable canvases, and keeps sampling the rest", async () => {
    const pictures = new Map<object, string>([
      [canvas(0, 0), "empty"],
      [canvas(), "unreadable"],
      [canvas(), "fine"],
    ]);
    const { events, tick } = harness(pictures);
    await tick();
    expect(events.map(picture)).toEqual(["fine"]);
    expect(events[0]!.data).toMatchObject({ id: 12 });
  });

  it("stops", async () => {
    const pictures = new Map<object, string>([[canvas(), "one"]]);
    const { events, sampler, tick } = harness(pictures);
    sampler.stop();
    await tick();
    expect(events).toHaveLength(0);
  });
});
