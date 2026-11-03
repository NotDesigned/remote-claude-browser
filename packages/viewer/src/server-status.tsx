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

export function ServerStatusBar({
  sample,
  live,
  now,
}: {
  sample: ReceivedServerStatus | null;
  live: boolean;
  now: number;
}) {
  const fresh = live && sample !== null && now - sample.receivedAt <= SERVER_STATUS_STALE_MS;
  const value = fresh ? sample.value : null;
  const state = fresh ? "fresh" : sample === null ? "pending" : "stale";
  const memory =
    value?.memoryUsedBytes !== null &&
    value?.memoryUsedBytes !== undefined &&
    value.memoryTotalBytes !== null &&
    value.memoryTotalBytes > 0
      ? `${gib(value.memoryUsedBytes)}/${gib(value.memoryTotalBytes)} GiB`
      : "—";
  return (
    <section id="server-status" aria-label="服务器实时状态" data-status={state}>
      <span
        class="server-stat"
        data-stat="online"
        title="按设备统计的在线客户端数；同一浏览器多个窗口只计一个客户端"
      >
        <span>在线客户端</span>
        <strong>{value === null ? "—" : value.clientsOnline}</strong>
      </span>
      <span
        class="server-stat"
        data-stat="allocated"
        title="断开后保留 60 秒，随后自动回收，正在生成时暂缓"
      >
        <span>会话占用</span>
        <strong>{value === null ? "—" : `${value.clientsAllocated}/${value.clientsMax}`}</strong>
      </span>
      <span
        class="server-stat"
        data-stat="cpu"
        title={
          value === null ? undefined : `远程服务器，${value.cpuCount} 个逻辑 CPU，数值为整机使用率`
        }
      >
        <span>CPU</span>
        <strong>
          {value?.cpuPercent === null || value?.cpuPercent === undefined
            ? "—"
            : `${Math.round(value.cpuPercent)}%`}
        </strong>
      </span>
      <span
        class="server-stat"
        data-stat="memory"
        title={
          value?.browserMemoryBytes === null || value?.browserMemoryBytes === undefined
            ? "远程服务器整机内存使用量 / 总量"
            : `远程服务器整机内存，浏览器服务占用 ${gib(value.browserMemoryBytes)} GiB`
        }
      >
        <span>Mem</span>
        <strong>{memory}</strong>
      </span>
      <span
        class="server-status-freshness"
        title={
          fresh
            ? "每 3 秒采样；断线或超过 10 秒未更新时隐藏旧数值"
            : "状态不可用时显示 —，不代表资源占用为零"
        }
      >
        {fresh ? "实时状态" : sample === null ? "等待状态" : "数据已过期"}
      </span>
    </section>
  );
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Only used without an active session socket; never overlaps requests or retries bad auth. */
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
    )
  );
}
