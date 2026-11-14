import { describe, expect, it } from "vitest";
import { screenMetrics } from "./screen-metrics";

describe("session screen geometry", () => {
  it("keeps the shared X display outside desktop page metrics", () => {
    expect(screenMetrics(1050, 893, false)).toEqual({
      screenWidth: 1920,
      screenHeight: 1080,
      positionX: 0,
      positionY: 0,
    });
  });
  it("never reports a screen smaller than the viewport", () => {
    expect(screenMetrics(2560, 1440, false)).toMatchObject({
      screenWidth: 2560,
      screenHeight: 1440,
    });
  });
  it("uses negotiated phone dimensions without inventing a phone model", () => {
    expect(screenMetrics(390, 844, true)).toMatchObject({ screenWidth: 390, screenHeight: 844 });
  });
});
