/**
 * Translate the viewer wall clock into the gateway/page clock domain.
 *
 * A gateway timestamp is stamped before the message crosses the network. Approximating that
 * one-way trip as half of the best observed WebSocket RTT keeps the estimate insensitive to the
 * viewer machine's wall-clock offset. The best RTT is preferred because queueing can only make a
 * sample slower.
 */

/**
 * The replay's lag behind the page. Everything here arrives in order, so a larger cushion would
 * only delay what the viewer sees.
 */
export const DEFAULT_LIVE_BUFFER_MS = 10;

export interface ServerClockOptions {
  now?: () => number;
  bufferMs?: number;
}

export interface ServerClock {
  observeRtt(rttMs: number): void;
  observeServerTime(serverTs: number, receivedAt?: number): void;
  estimatedServerNow(): number;
  liveBufferMs(): number;
  liveBaseline(): number;
}

const MAX_LIVE_BUFFER_MS = 5_000;

function assertDuration(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function createServerClock(options: ServerClockOptions = {}): ServerClock {
  const now = options.now ?? Date.now;
  const bufferMs = assertDuration(
    "bufferMs",
    options.bufferMs ?? DEFAULT_LIVE_BUFFER_MS,
    0,
    MAX_LIVE_BUFFER_MS,
  );

  let bestRttMs: number | null = null;
  let clockOffsetMs: number | null = null;
  let lastReference: { serverTs: number; receivedAt: number } | null = null;

  const refreshOffset = () => {
    if (lastReference === null) return;
    const oneWayMs = bestRttMs === null ? 0 : bestRttMs / 2;
    clockOffsetMs = lastReference.serverTs + oneWayMs - lastReference.receivedAt;
  };

  const liveBufferMs = (): number => bufferMs;

  const estimatedServerNow = (): number => now() + (clockOffsetMs ?? 0);

  return {
    observeRtt(rttMs) {
      if (!Number.isFinite(rttMs) || rttMs < 0) return;
      if (bestRttMs === null || rttMs < bestRttMs) {
        bestRttMs = rttMs;
        refreshOffset();
      }
    },
    observeServerTime(serverTs, receivedAt = now()) {
      if (!Number.isFinite(serverTs) || !Number.isFinite(receivedAt)) return;
      lastReference = { serverTs, receivedAt };
      refreshOffset();
    },
    estimatedServerNow,
    liveBufferMs,
    liveBaseline: () => estimatedServerNow() - liveBufferMs(),
  };
}
