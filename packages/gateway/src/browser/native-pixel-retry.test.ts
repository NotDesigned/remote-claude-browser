import { describe, expect, it, vi } from "vitest";
import type { Down } from "@mirror/protocol";
import { createNativePixelRetry } from "./native-pixel-retry";

describe("native pixel startup recovery", () => {
  it("retries a failed first frame without falling back to an empty DOM view", async () => {
    vi.useFakeTimers();
    const published: Down[] = [];
    const start = vi.fn(async () => {});
    const retry = createNativePixelRetry({
      current: () => true,
      start,
      publish: (m) => published.push(m),
    });
    retry.request("t");
    retry.observe({ t: "mode", tab: "t", mode: "dom" });
    expect(published).toEqual([{ t: "mode", tab: "t", mode: "px" }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledWith("t");
    retry.dispose();
    vi.useRealTimers();
  });
  it("stops after three retries and lets an explicit request recover", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const start = vi.fn(async () => {});
    const retry = createNativePixelRetry({ current: () => true, start, publish });
    retry.request("t");
    for (let i = 0; i < 5; i++) {
      retry.observe({ t: "mode", tab: "t", mode: "dom" });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(start).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledWith({ t: "tab-state", tab: "t", state: "failed" });
    retry.request("t");
    retry.observe({ t: "mode", tab: "t", mode: "dom" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).toHaveBeenCalledTimes(4);
    retry.dispose();
    vi.useRealTimers();
  });
  it("cancels pending retries after a frame, tab switch, or disposal", async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => {});
    const publish = vi.fn();
    const retry = createNativePixelRetry({ current: () => true, start, publish });
    retry.request("a");
    retry.observe({ t: "mode", tab: "a", mode: "dom" });
    retry.observe({ t: "px", tab: "a" } as Down);
    retry.request("b");
    retry.observe({ t: "mode", tab: "b", mode: "dom" });
    retry.stop("b");
    retry.request("c");
    retry.observe({ t: "mode", tab: "c", mode: "dom" });
    retry.dispose();
    await vi.advanceTimersByTimeAsync(3000);
    expect(start).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith({ t: "tab-state", tab: "a", state: "ready" });
    vi.useRealTimers();
  });
});
