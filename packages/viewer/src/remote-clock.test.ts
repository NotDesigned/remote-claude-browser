import { describe, expect, it } from "vitest";
import { formatRemoteClock, msToNextMinute, zonePlace } from "./remote-clock";

// 2026-11-11 11:05:30 UTC, a Wednesday.
const at = new Date(Date.UTC(2026, 10, 11, 11, 5, 30));

describe("the remote browser's clock", () => {
  it("shows the place and the time there", () => {
    expect(formatRemoteClock("America/Los_Angeles", at)).toEqual({
      label: "洛杉矶 03:05",
      title: "2026-11-11 周三 03:05 · America/Los_Angeles（GMT-8）",
    });
    expect(formatRemoteClock("Asia/Shanghai", at)?.label).toBe("中国 19:05");
  });

  it("calls UTC by name", () => {
    expect(zonePlace("Etc/UTC", at)).toBe("UTC");
    expect(formatRemoteClock("Etc/UTC", at)?.label).toBe("UTC 11:05");
  });

  it("shows nothing for a zone it does not know, or none", () => {
    expect(formatRemoteClock("Mars/Olympus", at)).toBeNull();
    expect(formatRemoteClock(undefined, at)).toBeNull();
    expect(formatRemoteClock("", at)).toBeNull();
  });

  it("ticks on the minute", () => {
    expect(msToNextMinute(at.getTime())).toBe(30_000);
  });
});
