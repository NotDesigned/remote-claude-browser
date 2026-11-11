/** Server B telemetry; receipt time avoids comparing clocks on different machines. */
import type { ServerStatusMsg } from "@mirror/protocol";

export const SERVER_STATUS_STALE_MS = 10_000;
export const SERVER_STATUS_POLL_MS = 3_000;

export interface ReceivedServerStatus {
  value: ServerStatusMsg;
  receivedAt: number;
}

export function receiveServerStatus(
  previous: ReceivedServerStatus | null,
  value: ServerStatusMsg,
  now: number,
): ReceivedServerStatus {
  // A cached/late reply must not make an old sample look new indefinitely.
  return previous !== null && value.sampledAt <= previous.value.sampledAt
    ? previous
    : { value, receivedAt: now };
}

export function pollServerStatus({
  onSample,
  onReachable,
  onAuthFailure,
  fetcher = fetch,
}: {
  onSample(value: ServerStatusMsg): void;
  onReachable(reachable: boolean): void;
  onAuthFailure(): void;
  fetcher?: typeof fetch;
}): () => void {
  let stopped = false;
  let pending: AbortController | null = null;
  const poll = async () => {
    if (stopped || pending !== null) return;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetcher("/api/status", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (stopped) return;
      if (response.status === 401 || response.status === 403) {
        stopped = true;
        clearInterval(timer);
        onReachable(false);
        onAuthFailure();
        return;
      }
      if (!response.ok) throw new Error("status unavailable");
      const value: unknown = await response.json();
      if (stopped) return;
      if (!isServerStatus(value)) throw new Error("invalid status response");
      onSample(value);
      onReachable(true);
    } catch {
      if (!stopped) onReachable(false);
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    }
  };
  const timer = setInterval(() => void poll(), SERVER_STATUS_POLL_MS);
  void poll();
  return () => {
    stopped = true;
    clearInterval(timer);
    pending?.abort();
  };
}

function isServerStatus(value: unknown): value is ServerStatusMsg {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const nonnegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const integer = (v: unknown) => nonnegative(v) && Number.isSafeInteger(v);
  return (
    item.t === "server-status" &&
    nonnegative(item.sampledAt) &&
    [item.clientsOnline, item.clientsAllocated, item.pixelsActive].every(integer) &&
    integer(item.clientsMax) &&
    (item.clientsMax as number) > 0 &&
    (item.pixelsMax === null || (integer(item.pixelsMax) && (item.pixelsMax as number) > 0)) &&
    integer(item.cpuCount) &&
    (item.cpuCount as number) > 0 &&
    [item.cpuPercent, item.memoryUsedBytes, item.memoryTotalBytes, item.browserMemoryBytes].every(
      (v) => v === null || nonnegative(v),
    ) &&
    (item.timeZone === undefined || typeof item.timeZone === "string")
  );
}
