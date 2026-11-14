import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRemoteClock,
  formatStatusClock,
  msToNextMinute,
  remoteClockNow,
} from "./remote-clock";
import { receiveServerStatus, type ReceivedServerStatus } from "./server-status";

// 2026-11-11 11:05:30 UTC, a Wednesday.
const at = new Date(Date.UTC(2026, 10, 11, 11, 5, 30));
const status = (
  timeZone: string,
  exitCity?: string,
  exitCountry?: string,
): ReceivedServerStatus => ({
  receivedAt: Date.now(),
  value: {
    t: "server-status",
    sampledAt: at.getTime(),
    timeZone,
    exitCity,
    exitCountry,
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
  it("shows the actual exit city, independently of the IANA zone's city", () => {
    expect(formatRemoteClock("Asia/Taipei", at, { city: "高雄", country: "台湾" })).toEqual({
      label: "高雄 · 19:05",
      title: "高雄，台湾 · 2026-11-11 周三 19:05 · Asia/Taipei（GMT+8）",
    });
    expect(
      formatRemoteClock("America/Los_Angeles", at, { city: "西雅图", country: "美国" }),
    ).toEqual({
      label: "西雅图 · 03:05",
      title: "西雅图，美国 · 2026-11-11 周三 03:05 · America/Los_Angeles（GMT-8）",
    });
  });

  it("uses the country or a generic label when location metadata is missing", () => {
    expect(formatRemoteClock("Asia/Taipei", at, { country: "台湾" })?.label).toBe("台湾 · 19:05");
    expect(formatRemoteClock("Asia/Taipei", at)?.label).toBe("当地时间 · 19:05");
    expect(formatRemoteClock("Etc/UTC", at)?.label).toBe("当地时间 · 11:05");
  });

  it("does not repeat an identical city and country in the details", () => {
    expect(
      formatRemoteClock("Asia/Singapore", at, { city: "新加坡", country: "新加坡" })?.title,
    ).toBe("新加坡 · 2026-11-11 周三 19:05 · Asia/Singapore（GMT+8）");
  });

  it("keeps the exit location while the zone observes summer time", () => {
    const summer = new Date(Date.UTC(2026, 6, 11, 11, 5, 30));
    expect(
      formatRemoteClock("America/Los_Angeles", summer, { city: "西雅图", country: "美国" }),
    ).toEqual({
      label: "西雅图 · 04:05",
      title: "西雅图，美国 · 2026-07-11 周六 04:05 · America/Los_Angeles（GMT-7）",
    });
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
    const sample = status("America/Los_Angeles", "西雅图", "美国");
    expect(formatStatusClock(sample)?.label).toBe("西雅图 · 03:05");
    expect(msToNextMinute(remoteClockNow(sample))).toBe(30_000);
    vi.advanceTimersByTime(30_000);
    expect(formatStatusClock(sample)?.label).toBe("西雅图 · 03:06");
    expect(remoteClockNow(sample)).toBe(at.getTime() + 30_000);
  });

  it("changes to the next profile's exit zone as soon as its status arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2020-01-01T01:02:03Z"));
    const first = status("America/Los_Angeles", "西雅图", "美国");
    expect(formatStatusClock(first)?.title).toContain("America/Los_Angeles");
    vi.advanceTimersByTime(30_000);
    const next = receiveServerStatus(
      first,
      {
        ...first.value,
        sampledAt: at.getTime() + 30_000,
        timeZone: "Asia/Tokyo",
        exitCity: "大阪",
        exitCountry: "日本",
      },
      Date.now(),
    );
    expect(formatStatusClock(next)).toEqual({
      label: "大阪 · 20:06",
      title: "大阪，日本 · 2026-11-11 周三 20:06 · Asia/Tokyo（GMT+9）",
    });
  });

  it("waits for a server sample instead of showing the device's local clock", () => {
    expect(formatStatusClock(null)).toBeNull();
  });
});
