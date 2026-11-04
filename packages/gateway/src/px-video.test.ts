import { describe, expect, it, vi } from "vitest";
import { createFmp4Reader, ffmpegArguments } from "./px-video";

const box = (type: string, body: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
};
const sample = (...nals: number[][]) =>
  Buffer.concat(
    nals.flatMap((nal) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(nal.length);
      return [length, Buffer.from(nal)];
    }),
  );
const avcC = Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0]);

describe("fragmented MP4 reader", () => {
  const read = () => {
    const events = { onConfig: vi.fn(), onChunk: vi.fn() };
    return { events, feed: createFmp4Reader(events) };
  };
  const stream = Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box("moov", Buffer.concat([Buffer.from("xxxx"), box("avcC", avcC)])),
    box("moof", Buffer.from("ignored")),
    box("mdat", sample([0x65, 1, 2])),
    box("moof", Buffer.from("ignored")),
    box("mdat", sample([0x06, 9], [0x41, 3])),
    box("mfra", Buffer.from("ignored")),
  ]);

  it("reports the codec and one chunk per frame, marking keyframes", () => {
    const { events, feed } = read();
    feed(stream);
    expect(events.onConfig).toHaveBeenCalledWith({ codec: "avc1.64001f", description: avcC });
    expect(events.onChunk.mock.calls.map(([data, key]) => [data.length, key])).toEqual([
      [7, true],
      [12, false],
    ]);
  });

  it("waits for a box that arrives in pieces", () => {
    const { events, feed } = read();
    for (let at = 0; at < stream.length; at += 5) feed(stream.subarray(at, at + 5));
    expect(events.onChunk).toHaveBeenCalledTimes(2);
  });

  it("rejects a broken stream instead of waiting forever", () => {
    const { feed } = read();
    expect(() => feed(Buffer.alloc(8))).toThrow("box size");
  });
});

describe("ffmpeg arguments", () => {
  it("emit frames without reordering, at the requested quality", () => {
    const args = ffmpegArguments(18).join(" ");
    expect(args).toContain("-crf 18");
    expect(args).toContain("-bf 0");
    expect(args).toContain("frag_every_frame");
  });
});
