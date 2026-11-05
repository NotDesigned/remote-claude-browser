import { describe, expect, it } from "vitest";
import { decodeVoiceSamples, encodeVoiceSamples } from "./voice";

describe("voice samples", () => {
  it("survive the trip, including negative values", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const decoded = decodeVoiceSamples(encodeVoiceSamples(samples));
    expect(decoded).toHaveLength(5);
    samples.forEach((sample, index) => expect(decoded[index]).toBeCloseTo(sample, 3));
  });

  it("clip what is out of range instead of wrapping around", () => {
    const decoded = decodeVoiceSamples(encodeVoiceSamples(new Float32Array([2, -2])));
    expect(decoded[0]).toBeCloseTo(1, 3);
    expect(decoded[1]).toBeCloseTo(-1, 3);
  });
});
