/**
 * H.264 encoder for the pixel view. Pictures come from the X display directly, or as JPEG frames in
 * multipart, whose frames state their own length. They leave as FLV tags, which do too. Other formats
 * make ffmpeg wait for the next frame to find where one ends, which is two more frames of input delay.
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

const GRAB_FPS = 24;

export type VideoEncoderFactory = (crf: number, events: VideoEncoderEvents) => VideoEncoder;

/** The part of the screen to read, starting at its top edge. */
export interface GrabRegion {
  left: number;
  width: number;
  height: number;
}

export type GrabEncoderFactory = (
  crf: number,
  region: GrabRegion,
  events: VideoEncoderEvents,
) => VideoEncoder;

/** Splits an FLV stream into its configuration and one H.264 frame per video tag. */
export function createFlvReader(
  events: Pick<VideoEncoderEvents, "onConfig" | "onChunk">,
): (chunk: Buffer) => void {
  const FILE_HEADER = 13;
  const TAG_HEADER = 11;
  const VIDEO_TAG = 9;
  const VIDEO_HEADER = 5;
  let buffered: Buffer = Buffer.alloc(0);
  let started = false;
  return (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    if (!started) {
      if (buffered.length < FILE_HEADER) return;
      if (buffered.toString("latin1", 0, 3) !== "FLV") throw new Error("Not an FLV stream");
      buffered = buffered.subarray(FILE_HEADER);
      started = true;
    }
    while (buffered.length >= TAG_HEADER) {
      const size = buffered.readUIntBE(1, 3);
      const total = TAG_HEADER + size + 4;
      if (buffered.length < total) return;
      if (buffered[0] === VIDEO_TAG && size > VIDEO_HEADER) {
        const video = buffered.subarray(TAG_HEADER, TAG_HEADER + size);
        const payload = Buffer.from(video.subarray(VIDEO_HEADER));
        if (video[1] === 0)
          events.onConfig({
            codec: `avc1.${payload.subarray(1, 4).toString("hex")}`,
            description: payload,
          });
        else if (video[1] === 1) events.onChunk(payload, video[0]! >> 4 === 1);
      }
      buffered = buffered.subarray(total);
    }
  };
}

/** One JPEG as ffmpeg's multipart demuxer reads it. */
export function multipartFrame(jpeg: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${jpeg.length}\r\n\r\n`),
    jpeg,
    Buffer.from("\r\n"),
  ]);
}

/** JPEG and the display are both full-range; an unconverted stream would show washed-out text. */
const TO_VIDEO_COLORS =
  "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv:out_color_matrix=bt709,format=yuv420p";

const encodingArguments = (crf: number, filter: string): string[] => [
  ...["-vf", filter],
  ...["-c:v", "libx264", "-preset", "superfast", "-tune", "zerolatency", "-crf", String(crf)],
  ...["-threads", "3", "-g", "600", "-bf", "0", "-fps_mode", "passthrough"],
  ...["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709"],
  ...["-color_trc", "bt709"],
  ...["-flush_packets", "1", "-f", "flv", "-flvflags", "no_duration_filesize", "-"],
];

export function ffmpegArguments(crf: number): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0"],
    ...["-f", "mpjpeg", "-i", "-"],
    ...encodingArguments(crf, TO_VIDEO_COLORS),
  ];
}

export function ffmpegGrabArguments(crf: number, region: GrabRegion, display: string): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error"],
    ...["-fflags", "nobuffer", "-flags", "low_delay"],
    ...["-f", "x11grab", "-draw_mouse", "0", "-framerate", String(GRAB_FPS)],
    ...["-video_size", `${region.width}x${region.height}`, "-i", `${display}+${region.left},0`],
    // Only a picture that changed at all goes on, so a still page costs nothing to send or show.
    ...encodingArguments(crf, `${TO_VIDEO_COLORS},mpdecimate=hi=0:lo=0:frac=0:max=0`),
  ];
}

const startFfmpeg = (
  args: string[],
  events: VideoEncoderEvents,
  env?: NodeJS.ProcessEnv,
): VideoEncoder => {
  let closed = false;
  const process: ChildProcessWithoutNullStreams = spawn(
    globalThis.process.env.MIRROR_FFMPEG ?? "ffmpeg",
    args,
    { ...(env ? { env: { ...globalThis.process.env, ...env } } : {}) },
  );
  const fail = (error: Error) => {
    if (closed) return;
    closed = true;
    process.kill("SIGKILL");
    events.onFailure(error);
  };
  const read = createFlvReader(events);
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
      if (!closed && process.stdin.writable) process.stdin.write(multipartFrame(jpeg));
    },
    close() {
      if (closed) return;
      closed = true;
      process.kill("SIGKILL");
    },
  };
};

export const createFfmpegEncoder: VideoEncoderFactory = (crf, events) =>
  startFfmpeg(ffmpegArguments(crf), events);

export const createGrabEncoder: GrabEncoderFactory = (crf, region, events) => {
  const display = globalThis.process.env.DISPLAY;
  if (!display) throw new Error("Grabbing the screen needs a display");
  return startFfmpeg(ffmpegGrabArguments(crf, region, display), events);
};

/** X11 capture must use the same account authorization as its browser/window controller. */
export const grabEncoderForDisplay =
  (env: { DISPLAY: string; XAUTHORITY: string }): GrabEncoderFactory =>
  (crf, region, events) =>
    startFfmpeg(ffmpegGrabArguments(crf, region, env.DISPLAY), events, env);
