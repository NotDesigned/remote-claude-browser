import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRemoteClock,
  formatStatusClock,
  msToNextMinute,
  remoteClockNow,
  zonePlace,
} from "./remote-clock";
import { receiveServerStatus, type ReceivedServerStatus } from "./server-status";

// 2026-11-11 11:05:30 UTC, a Wednesday.
const at = new Date(Date.UTC(2026, 10, 11, 11, 5, 30));
const status = (timeZone: string): ReceivedServerStatus => ({
  receivedAt: Date.now(),
  value: {
    t: "server-status",
    sampledAt: at.getTime(),
    timeZone,
    clientsOnline: 1,
    clientsAllocated: 1,
    clientsMax: 8,
    pixelsActive: 0,
    pixelsMax: null,
    cpuPercent: null,
    cpuCount: 1,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    browserMemoryBytes: null,
  },
});
afterEach(() => vi.useRealTimers());

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

  it("uses server UTC even when the device clock is years ahead, then advances from receipt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-01-01T01:02:03Z"));
    const sample = status("America/Los_Angeles");
    expect(formatStatusClock(sample)?.label).toBe("洛杉矶 03:05");
    expect(msToNextMinute(remoteClockNow(sample))).toBe(30_000);
    vi.advanceTimersByTime(30_000);
    expect(formatStatusClock(sample)?.label).toBe("洛杉矶 03:06");
    expect(remoteClockNow(sample)).toBe(at.getTime() + 30_000);
  });

  it("changes to the next profile's exit zone as soon as its status arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T01:02:03Z"));
    const first = status("America/Los_Angeles");
    expect(formatStatusClock(first)?.title).toContain("America/Los_Angeles");
    vi.advanceTimersByTime(30_000);
    const next = receiveServerStatus(
      first,
      { ...first.value, sampledAt: at.getTime() + 30_000, timeZone: "Asia/Tokyo" },
      Date.now(),
    );
    expect(formatStatusClock(next)).toEqual({
      label: "日本 20:06",
      title: "2026-11-11 周三 20:06 · Asia/Tokyo（GMT+9）",
    });
  });

  it("waits for a server sample instead of showing the device's local clock", () => {
    expect(formatStatusClock(null)).toBeNull();
  });
});
