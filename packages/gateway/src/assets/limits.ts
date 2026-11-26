/**
 * Bounds on one proxied asset body: how many bytes it may carry, how long it may take in all,
 * and how long it may go without a byte. A body that breaks one is destroyed, which (through
 * stream.pipeline) also aborts the upstream fetch and discards whatever the cache had written.
 */
import { Transform, type TransformCallback } from "node:stream";

/** Fits large images and fonts; a page subresource larger than this is not worth a disk copy. */
export const DEFAULT_ASSET_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ASSET_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_ASSET_IDLE_TIMEOUT_MS = 30_000;

export interface AssetLimits {
  /** Bytes one response body may carry; Infinity for none. */
  maxBytes: number;
  /** Milliseconds the whole body may take; Infinity for none. */
  timeoutMs: number;
  /** Milliseconds between two chunks; Infinity for none. */
  idleTimeoutMs: number;
}

export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  maxBytes: DEFAULT_ASSET_MAX_BYTES,
  timeoutMs: DEFAULT_ASSET_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_ASSET_IDLE_TIMEOUT_MS,
};

export class AssetLimitError extends Error {}

/** MIRROR_ASSET_MAX_BYTES overrides the byte cap; anything but a positive integer is ignored. */
export function assetLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): AssetLimits {
  const raw = env.MIRROR_ASSET_MAX_BYTES?.trim();
  const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return {
    ...DEFAULT_ASSET_LIMITS,
    ...(Number.isSafeInteger(value) && value > 0 ? { maxBytes: value } : {}),
  };
}

/** A pass-through that fails once the body breaks one of the limits. */
export function createAssetLimiter(limits: AssetLimits): Transform {
  let size = 0;
  let idle: NodeJS.Timeout | undefined;
  let total: NodeJS.Timeout | undefined;
  const clear = () => {
    if (idle) clearTimeout(idle);
    if (total) clearTimeout(total);
    idle = total = undefined;
  };
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      size += chunk.length;
      if (size > limits.maxBytes) {
        callback(new AssetLimitError("Asset body exceeds the byte limit"));
        return;
      }
      armIdle();
      callback(null, chunk);
    },
    flush(callback) {
      clear();
      callback();
    },
    destroy(error, callback) {
      clear();
      callback(error);
    },
  });
  const fail = (message: string) => limiter.destroy(new AssetLimitError(message));
  function armIdle() {
    if (!Number.isFinite(limits.idleTimeoutMs)) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => fail("Asset body stalled"), limits.idleTimeoutMs);
    idle.unref?.();
  }
  if (Number.isFinite(limits.timeoutMs)) {
    total = setTimeout(() => fail("Asset body took too long"), limits.timeoutMs);
    total.unref?.();
  }
  armIdle();
  return limiter;
}

/** The declared Content-Length, when there is exactly one valid one. */
export function declaredLength(headers: Record<string, string | string[]>): number | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-length") continue;
    const text = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
    if (text === undefined || !/^\d+$/.test(text.trim())) return undefined;
    const length = Number(text.trim());
    return Number.isSafeInteger(length) ? length : undefined;
  }
  return undefined;
}
