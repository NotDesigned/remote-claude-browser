// @vitest-environment node
import type { ServerStatusMsg } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollServerStatus, receiveServerStatus } from "./server-status";
import { resourceWarning } from "./shell-bar";

const value: ServerStatusMsg = {
  t: "server-status",
  sampledAt: 1,
  clientsOnline: 1,
  clientsAllocated: 2,
  clientsMax: 16,
  pixelsActive: 2,
  pixelsMax: null,
  cpuPercent: 30.2,
  cpuCount: 2,
  memoryUsedBytes: 1.2 * 1024 ** 3,
  memoryTotalBytes: 1.9 * 1024 ** 3,
  browserMemoryBytes: 0.8 * 1024 ** 3,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.useRealTimers());

describe("resource warning", () => {
  const warned = (change: Partial<ServerStatusMsg>) =>
    resourceWarning({ value: { ...value, ...change }, receivedAt: 1 });

  it("names full sessions and short memory, and otherwise says nothing", () => {
    expect(warned({})).toBeNull();
    expect(resourceWarning(null)).toBeNull();
    expect(warned({ clientsAllocated: 16 })).toContain("会话名额已满");
    expect(warned({ memoryUsedBytes: 1.7 * 1024 ** 3 })).toContain("内存紧张");
  });
});

describe("server B status", () => {
  it("ignores duplicate and late sample timestamps", () => {
    const sample = receiveServerStatus(null, value, 100);
    expect(receiveServerStatus(sample, value, 9_999)).toBe(sample);
    expect(receiveServerStatus(sample, { ...value, sampledAt: 0 }, 9_999)).toBe(sample);
    expect(receiveServerStatus(sample, { ...value, sampledAt: 2 }, 9_999).receivedAt).toBe(9_999);
  });

  it.each([401, 403])("stops polling after HTTP %i", async (status) => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response({}, status));
    const onAuthFailure = vi.fn();
    const onReachable = vi.fn();
    const onSample = vi.fn();
    const stop = pollServerStatus({ fetcher, onAuthFailure, onReachable, onSample });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledOnce();
    expect(onReachable).toHaveBeenCalledWith(false);
    expect(onSample).not.toHaveBeenCalled();
    stop();
  });

  it("polls with the auth cookie, recovers from network failure, and aborts on cleanup", async () => {
    vi.useFakeTimers();
    const request: { signal: AbortSignal | null } = { signal: null };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(value))
      .mockImplementationOnce((_url, init) => {
        request.signal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      });
    const onSample = vi.fn(),
      onReachable = vi.fn();
    const stop = pollServerStatus({ fetcher, onSample, onReachable, onAuthFailure: vi.fn() });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(onReachable.mock.calls).toEqual([[false], [true]]);
    expect(onSample).toHaveBeenCalledWith(value);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/status",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    stop();
    expect(request.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
