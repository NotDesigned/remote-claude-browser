/** WebCodecs decoder for the pixel view's H.264 stream. */
import type { Down } from "@mirror/protocol";

type VideoConfigMessage = Extract<Down, { t: "vid-cfg" }>;
type VideoFrameMessage = Extract<Down, { t: "vid" }>;

const KEY_REQUEST_INTERVAL_MS = 1_000;
const MAX_DECODE_QUEUE = 8;
const MAX_FAILURES = 3;
const FAILURE_WINDOW_MS = 10_000;
/** High profile at the level of a 4K stream, the most this view asks a browser to decode. */
const PROBE_CODEC = "avc1.640033";

let supported = false;
let disabled = false;
try {
  void globalThis.VideoDecoder?.isConfigSupported({ codec: PROBE_CODEC }).then(
    (result) => (supported = result.supported === true),
    () => {},
  );
} catch {
  // A browser without WebCodecs keeps JPEG frames.
}

/** The field a `mode` request carries; an omitted one leaves the gateway's choice in place. */
export function videoOption(): { video?: boolean } {
  if (disabled) return { video: false };
  return supported ? { video: true } : {};
}

export interface VideoStreamOptions {
  onFrame(frame: VideoFrame, w: number, h: number): void;
  requestKeyframe(): void;
  /** Decoding keeps failing here, so the view should go back to JPEG frames. */
  onUnusable(): void;
  now?: () => number;
  createDecoder?: (init: VideoDecoderInit) => VideoDecoder;
  createChunk?: (init: EncodedVideoChunkInit) => EncodedVideoChunk;
}

export interface VideoStream {
  configure(message: VideoConfigMessage): void;
  decode(message: VideoFrameMessage): void;
  /** No stream is running, or none can be decoded from here without a keyframe. */
  needKeyframe(): void;
  close(): void;
}

export function createVideoStream(options: VideoStreamOptions): VideoStream {
  const now = options.now ?? Date.now;
  const createDecoder = options.createDecoder ?? ((init) => new VideoDecoder(init));
  const createChunk = options.createChunk ?? ((init) => new EncodedVideoChunk(init));
  let decoder: VideoDecoder | null = null;
  let waitingForKey = true;
  let nextSeq: number | null = null;
  let lastKeyRequestAt = Number.NEGATIVE_INFINITY;
  let timestamp = 0;
  let size = { w: 1, h: 1 };
  let failures: number[] = [];
  let closed = false;
  const repeats = new Set<number>();

  const closeDecoder = () => {
    if (decoder !== null && decoder.state !== "closed") decoder.close();
    decoder = null;
  };
  const needKeyframe = () => {
    waitingForKey = true;
    if (now() - lastKeyRequestAt < KEY_REQUEST_INTERVAL_MS) return;
    lastKeyRequestAt = now();
    options.requestKeyframe();
  };
  const fail = () => {
    closeDecoder();
    if (closed) return;
    const at = now();
    failures = [...failures.filter((time) => at - time < FAILURE_WINDOW_MS), at];
    if (failures.length >= MAX_FAILURES) {
      disabled = true;
      options.onUnusable();
    } else needKeyframe();
  };

  return {
    configure(message) {
      closeDecoder();
      repeats.clear();
      waitingForKey = true;
      nextSeq = null;
      try {
        decoder = createDecoder({
          output(frame) {
            if (closed || repeats.delete(frame.timestamp)) frame.close();
            else options.onFrame(frame, size.w, size.h);
          },
          error: fail,
        });
        decoder.configure({
          codec: message.codec,
          description: Uint8Array.from(atob(message.description), (char) => char.charCodeAt(0)),
          optimizeForLatency: true,
        });
      } catch {
        fail();
      }
    },
    decode(message) {
      if (decoder === null || decoder.state !== "configured") return needKeyframe();
      if (nextSeq !== null && message.seq !== nextSeq) needKeyframe();
      nextSeq = message.seq + 1;
      if (waitingForKey && !message.key) return needKeyframe();
      // A decoder this far behind will not catch up frame by frame.
      if (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !message.key) return needKeyframe();
      waitingForKey = false;
      size = { w: message.w, h: message.h };
      try {
        timestamp += 33_333;
        if (message.repeat) repeats.add(timestamp);
        decoder.decode(
          createChunk({
            type: message.key ? "key" : "delta",
            timestamp,
            data: message.data,
          }),
        );
      } catch {
        fail();
      }
    },
    needKeyframe,
    close() {
      closed = true;
      closeDecoder();
    },
  };
}
