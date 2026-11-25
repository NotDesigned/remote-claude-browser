import { describe, expect, it } from "vitest";
import { SESSION_IDLE_GRACE_MS, sessionIdleGraceMs } from "./resource-policy";

describe("session idle grace", () => {
  it("defaults to 15 minutes, one minute in end-to-end tests", () => {
    expect(sessionIdleGraceMs(undefined, false)).toBe(SESSION_IDLE_GRACE_MS);
    expect(sessionIdleGraceMs("", false)).toBe(SESSION_IDLE_GRACE_MS);
    expect(sessionIdleGraceMs(undefined, true)).toBe(60_000);
  });
  it("takes MIRROR_IDLE_GRACE_MS in any mode", () => {
    expect(sessionIdleGraceMs("60000", false)).toBe(60_000);
    expect(sessionIdleGraceMs(" 0 ", true)).toBe(0);
  });
  it("refuses a value that is not whole milliseconds", () => {
    for (const bad of ["1.5", "-1", "15m", "abc"])
      expect(() => sessionIdleGraceMs(bad, false)).toThrow(/MIRROR_IDLE_GRACE_MS/);
  });
});
