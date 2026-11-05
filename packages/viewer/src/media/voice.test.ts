// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createDownsampler } from "./voice";

describe("createDownsampler", () => {
  it("halves the rate by averaging", () => {
    const downsample = createDownsampler(48_000, 24_000);
    expect([...downsample(new Float32Array([0, 1, 0.5, 0.5]))]).toEqual([0.5, 0.5]);
  });

  it("keeps its place across frames at an uneven ratio", () => {
    const downsample = createDownsampler(44_100, 24_000);
    let written = 0;
    for (let frame = 0; frame < 10; frame++) written += downsample(new Float32Array(2048)).length;
    expect(Math.abs(written - (20_480 * 24_000) / 44_100)).toBeLessThanOrEqual(1);
  });

  it("copies when the rates already match", () => {
    const input = new Float32Array([0.25, -0.25]);
    expect([...createDownsampler(24_000, 24_000)(input)]).toEqual([0.25, -0.25]);
  });
});
