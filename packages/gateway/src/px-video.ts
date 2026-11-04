/**
 * H.264 encoder for the pixel view: JPEG frames from the screencast go into ffmpeg, and one
 * length-prefixed access unit per frame comes back out of a fragmented MP4 stream.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface VideoConfig {
  /** WebCodecs codec string, such as avc1.64001f. */
  codec: string;
  /** The stream's avcC record, which the decoder needs as its description. */
  description: Buffer;
}

export interface VideoEncoderEvents {
  onConfig(config: VideoConfig): void;
  onChunk(data: Buffer, key: boolean): void;
  /** The encoder ended by itself: ffmpeg is missing or failed. */
  onFailure(error: Error): void;
}

export interface VideoEncoder {
  /** Frames have piled up in front of the encoder; a new one would only add delay. */
  busy?(): boolean;
  write(jpeg: Buffer): void;
  close(): void;
}

const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

export type VideoEncoderFactory = (crf: number, events: VideoEncoderEvents) => VideoEncoder;

/** Splits a fragmented MP4 stream into its configuration and one sample per fragment. */
export function createFmp4Reader(
  events: Pick<VideoEncoderEvents, "onConfig" | "onChunk">,
): (chunk: Buffer) => void {
  let buffered: Buffer = Buffer.alloc(0);
  let lengthSize = 4;
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 8) {
      const size = buffered.readUInt32BE(0);
      if (size < 8) throw new Error("Unsupported MP4 box size");
      if (buffered.length < size) return;
      const type = buffered.toString("latin1", 4, 8);
      const body = buffered.subarray(8, size);
      if (type === "moov") {
        const at = body.indexOf("avcC", 0, "latin1");
        if (at < 4) throw new Error("Video stream has no avcC record");
        const description = Buffer.from(body.subarray(at + 4, at - 4 + body.readUInt32BE(at - 4)));
        lengthSize = (description[4]! & 3) + 1;
        events.onConfig({
          codec: `avc1.${description.subarray(1, 4).toString("hex")}`,
          description,
        });
      } else if (type === "mdat") {
        events.onChunk(Buffer.from(body), containsKeyframe(body, lengthSize));
      }
      buffered = buffered.subarray(size);
    }
  };
}

function containsKeyframe(sample: Buffer, lengthSize: number): boolean {
  for (let at = 0; at + lengthSize < sample.length;) {
    if ((sample[at + lengthSize]! & 0x1f) === 5) return true;
    at += lengthSize + sample.readUIntBE(at, lengthSize);
  }
  return false;
}

export function ffmpegArguments(crf: number): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0"],
    ...["-f", "image2pipe", "-c:v", "mjpeg", "-i", "-"],
    // JPEG is full-range; an unconverted stream would show washed-out text.
    ...[
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv:out_color_matrix=bt709,format=yuv420p",
    ],
    ...["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", String(crf)],
    ...["-threads", "3", "-g", "600", "-bf", "0", "-fps_mode", "passthrough"],
    ...["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709"],
    ...["-color_trc", "bt709"],
    ...["-flush_packets", "1", "-f", "mp4"],
    ...["-movflags", "empty_moov+default_base_moof+frag_every_frame", "-"],
  ];
}

export const createFfmpegEncoder: VideoEncoderFactory = (crf, events) => {
  let closed = false;
  const process: ChildProcessWithoutNullStreams = spawn(
    globalThis.process.env.MIRROR_FFMPEG ?? "ffmpeg",
    ffmpegArguments(crf),
  );
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    process.kill("SIGKILL");
    events.onFailure(error);
  };
  const read = createFmp4Reader(events);
  process.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    try {
      read(chunk);
    } catch (error) {
      fail(error as Error);
    }
  });
  let lastError = "";
  process.stderr.on("data", (chunk: Buffer) => (lastError = String(chunk).slice(0, 300)));
  process.stdin.on("error", () => {});
  process.on("error", fail);
  process.on("exit", (code) => fail(new Error(`ffmpeg exited with ${code}: ${lastError}`)));
  return {
    busy: () => process.stdin.writableLength > MAX_QUEUED_INPUT_BYTES,
    write(jpeg) {
      if (!closed && process.stdin.writable) process.stdin.write(jpeg);
    },
    close() {
      if (closed) return;
      closed = true;
      process.kill("SIGKILL");
    },
  };
};
