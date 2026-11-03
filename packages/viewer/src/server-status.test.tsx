// @vitest-environment node
import type { ComponentChildren, VNode } from "preact";
import type { ServerStatusMsg } from "@mirror/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollServerStatus, receiveServerStatus, ServerStatusBar } from "./server-status";

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
function text(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "object" && "props" in value) return text((value as VNode).props.children);
  return String(value);
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.useRealTimers());

describe("server B status", () => {
  it("renders dynamic capacity, host CPU and memory without treating unknowns as zero", () => {
    const sample = receiveServerStatus(null, value, 50_000);
    const tree = ServerStatusBar({ sample, live: true, now: 50_100 });
    expect(tree.props["data-status"]).toBe("fresh");
    expect(text(tree)).toContain("在线客户端1会话占用2/16CPU30%Mem1.2/1.9 GiB");
    expect(text(tree)).not.toContain("图像");
    const unknown = ServerStatusBar({
      sample: receiveServerStatus(null, { ...value, cpuPercent: null, memoryUsedBytes: null }, 0),
      live: true,
      now: 1,
    });
    expect(text(unknown)).toContain("CPU—Mem—");
    expect(text(ServerStatusBar({ sample: null, live: false, now: 0 }))).not.toContain("0/5");
  });

  it("expires after ten seconds or a disconnect and ignores duplicate/late sample timestamps", () => {
    const sample = receiveServerStatus(null, value, 100);
    expect(receiveServerStatus(sample, value, 9_999)).toBe(sample);
    expect(receiveServerStatus(sample, { ...value, sampledAt: 0 }, 9_999)).toBe(sample);
    for (const props of [
      { live: false, now: 101 },
      { live: true, now: 10_101 },
    ]) {
      const tree = ServerStatusBar({ sample, ...props });
      expect(tree.props["data-status"]).toBe("stale");
      expect(text(tree)).toContain("在线客户端—");
      expect(text(tree)).toContain("数据已过期");
    }
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
