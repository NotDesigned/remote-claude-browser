// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createVideoStream } from "./px-video";

const frame = (seq: number, key = false) => ({
  t: "vid" as const,
  tab: "tab",
  seq,
  key,
  w: 800,
  h: 600,
  data: new Uint8Array([1]),
});
const config = { t: "vid-cfg" as const, tab: "tab", codec: "avc1.64001f", description: "AQ==" };

function setup() {
  let clock = 10_000;
  const decoded: { type: string }[] = [];
  const decoders: { init: VideoDecoderInit; configure: ReturnType<typeof vi.fn> }[] = [];
  const requestKeyframe = vi.fn();
  const onUnusable = vi.fn();
  const onFrame = vi.fn();
  const stream = createVideoStream({
    onFrame,
    requestKeyframe,
    onUnusable,
    now: () => clock,
    createChunk: (init) => init as unknown as EncodedVideoChunk,
    createDecoder: (init) => {
      const configure = vi.fn();
      decoders.push({ init, configure });
      return {
        state: "configured",
        decodeQueueSize: 0,
        configure,
        close: vi.fn(),
        decode: (chunk: { type: string }) => decoded.push(chunk),
      } as unknown as VideoDecoder;
    },
  });
  return {
    stream,
    decoded,
    decoders,
    requestKeyframe,
    onUnusable,
    onFrame,
    advance: (ms: number) => (clock += ms),
  };
}

describe("video stream", () => {
  it("starts decoding at a keyframe with the stream's description", () => {
    const { stream, decoded, decoders } = setup();
    stream.configure(config);
    expect(decoders[0]!.configure.mock.calls[0]![0]).toMatchObject({
      codec: "avc1.64001f",
      optimizeForLatency: true,
      description: new Uint8Array([1]),
    });
    stream.decode(frame(0));
    expect(decoded).toEqual([]);
    stream.decode(frame(1, true));
    stream.decode(frame(2));
    expect(decoded.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
  });

  it("asks for a keyframe when it has no stream, without flooding the gateway", () => {
    const { stream, requestKeyframe, advance } = setup();
    stream.decode(frame(0));
    stream.decode(frame(1));
    expect(requestKeyframe).toHaveBeenCalledOnce();
    advance(1_000);
    stream.decode(frame(2));
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
  });

  it("stops at a dropped frame until the next keyframe", () => {
    const { stream, decoded, requestKeyframe } = setup();
    stream.configure(config);
    stream.decode(frame(0, true));
    stream.decode(frame(2));
    stream.decode(frame(3));
    expect(decoded).toHaveLength(1);
    expect(requestKeyframe).toHaveBeenCalledOnce();
    stream.decode(frame(4, true));
    expect(decoded).toHaveLength(2);
  });

  it("reports the frame's page size with the decoded picture", () => {
    const { stream, decoders, onFrame } = setup();
    stream.configure(config);
    stream.decode(frame(0, true));
    const picture = { close: vi.fn() } as unknown as VideoFrame;
    decoders[0]!.init.output(picture);
    expect(onFrame).toHaveBeenCalledWith(picture, 800, 600);
  });

  it("gives up after repeated decoder errors", () => {
    const { stream, decoders, onUnusable, requestKeyframe, advance } = setup();
    for (let attempt = 0; attempt < 3; attempt++) {
      stream.configure(config);
      decoders.at(-1)!.init.error(new DOMException("bad"));
      advance(1_000);
    }
    expect(requestKeyframe).toHaveBeenCalledTimes(2);
    expect(onUnusable).toHaveBeenCalledOnce();
  });
});
