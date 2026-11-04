import { describe, expect, it, vi } from "vitest";
import { createFlvReader, ffmpegArguments, ffmpegGrabArguments, multipartFrame } from "./px-video";

const tag = (type: number, body: Buffer) => {
  const header = Buffer.alloc(11);
  header[0] = type;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body, Buffer.alloc(4)]);
};
const video = (frameType: number, packetType: number, payload: number[]) =>
  tag(9, Buffer.from([(frameType << 4) | 7, packetType, 0, 0, 0, ...payload]));
const avcC = [1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0];

describe("FLV reader", () => {
  const read = () => {
    const events = { onConfig: vi.fn(), onChunk: vi.fn() };
    return { events, feed: createFlvReader(events) };
  };
  const stream = Buffer.concat([
    Buffer.from("FLV\x01\x01\0\0\0\x09\0\0\0\0", "latin1"),
    tag(18, Buffer.from("metadata")),
    video(1, 0, avcC),
    video(1, 1, [0, 0, 0, 1, 0x65]),
    video(2, 1, [0, 0, 0, 1, 0x41, 9]),
  ]);

  it("reports the codec and one chunk per frame, marking keyframes", () => {
    const { events, feed } = read();
    feed(stream);
    expect(events.onConfig).toHaveBeenCalledWith({
      codec: "avc1.64001f",
      description: Buffer.from(avcC),
    });
    expect(events.onChunk.mock.calls.map(([data, key]) => [data.length, key])).toEqual([
      [5, true],
      [6, false],
    ]);
  });

  it("emits a frame as soon as it is complete, without waiting for the next", () => {
    const { events, feed } = read();
    feed(stream.subarray(0, stream.length - 1));
    expect(events.onChunk).toHaveBeenCalledTimes(1);
    feed(stream.subarray(stream.length - 1));
    expect(events.onChunk).toHaveBeenCalledTimes(2);
  });

  it("waits for a tag that arrives in pieces", () => {
    const { events, feed } = read();
    for (let at = 0; at < stream.length; at += 5) feed(stream.subarray(at, at + 5));
    expect(events.onChunk).toHaveBeenCalledTimes(2);
  });

  it("rejects something else instead of waiting forever", () => {
    const { feed } = read();
    expect(() => feed(Buffer.alloc(16))).toThrow("FLV");
  });
});

describe("multipart frames", () => {
  it("state the length of the JPEG they carry", () => {
    expect(multipartFrame(Buffer.from("abc")).toString()).toBe(
      "--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: 3\r\n\r\nabc\r\n",
    );
  });
});

describe("ffmpeg arguments", () => {
  it("emit frames without reordering, at the requested quality", () => {
    const args = ffmpegArguments(18).join(" ");
    expect(args).toContain("-crf 18");
    expect(args).toContain("-f mpjpeg");
    expect(args).toContain("-f flv");
    expect(args).toContain("-bf 0");
  });
});

describe("ffmpegGrabArguments", () => {
  it("reads its strip of the display without the pointer, and skips unchanged pictures", () => {
    const args = ffmpegGrabArguments(16, { left: 1280, width: 2160, height: 1350 }, ":99").join(
      " ",
    );
    expect(args).toContain("-f x11grab -draw_mouse 0 -framerate 30");
    expect(args).toContain("-video_size 2160x1350 -i :99+1280,0");
    expect(args).toContain("mpdecimate=hi=0:lo=0:frac=0:max=0");
    expect(args).toContain("out_color_matrix=bt709");
    expect(args).toContain("-crf 16");
  });
});
