/**
 * MIRROR_LIVE_TREE and its limits (docs/configuration.md). Read once at startup, which refuses a
 * value it cannot use.
 */
import { totalmem } from "node:os";

export interface LiveTreeConfig {
  enabled: boolean;
  /** Events and bytes a tab keeps for tails (resume, tab switch, drain). */
  ringEvents: number;
  ringBytes: number;
  /** Above either, a document's tree is dropped for the legacy store. */
  maxNodes: number;
  maxBytes: number;
  /** All trees together; above it, the least recently viewed background tab goes dormant. */
  totalMaxBytes: number;
  /** Sheet edits kept per document before one recompaction snapshot. */
  maxSidecar: number;
  /** Compare the tree with a page snapshot on idle tabs now and then. */
  verify: boolean;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIVE_TREE: LiveTreeConfig = {
  enabled: true,
  ringEvents: 2_000,
  ringBytes: 2 * MiB,
  maxNodes: 400_000,
  maxBytes: 48 * MiB,
  totalMaxBytes: Math.min(256 * MiB, Math.floor(totalmem() / 10)),
  maxSidecar: 20_000,
  verify: false,
};

function positive(name: string, raw: string | undefined, fallback: number, unit = 1): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value * unit;
}

function flag(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new RangeError(`${name} must be 0 or 1, got ${JSON.stringify(raw)}`);
}

export function liveTreeConfig(
  env: Record<string, string | undefined> = process.env,
): LiveTreeConfig {
  return {
    enabled: flag("MIRROR_LIVE_TREE", env.MIRROR_LIVE_TREE, DEFAULT_LIVE_TREE.enabled),
    ringEvents: positive(
      "MIRROR_LIVE_TREE_RING_EVENTS",
      env.MIRROR_LIVE_TREE_RING_EVENTS,
      DEFAULT_LIVE_TREE.ringEvents,
    ),
    ringBytes: positive(
      "MIRROR_LIVE_TREE_RING_BYTES",
      env.MIRROR_LIVE_TREE_RING_BYTES,
      DEFAULT_LIVE_TREE.ringBytes,
    ),
    maxNodes: positive(
      "MIRROR_LIVE_TREE_TAB_MAX_NODES",
      env.MIRROR_LIVE_TREE_TAB_MAX_NODES,
      DEFAULT_LIVE_TREE.maxNodes,
    ),
    maxBytes: positive(
      "MIRROR_LIVE_TREE_TAB_MAX_MB",
      env.MIRROR_LIVE_TREE_TAB_MAX_MB,
      DEFAULT_LIVE_TREE.maxBytes,
      MiB,
    ),
    totalMaxBytes: positive(
      "MIRROR_LIVE_TREE_TOTAL_MAX_MB",
      env.MIRROR_LIVE_TREE_TOTAL_MAX_MB,
      DEFAULT_LIVE_TREE.totalMaxBytes,
      MiB,
    ),
    maxSidecar: positive(
      "MIRROR_LIVE_TREE_MAX_SIDECAR",
      env.MIRROR_LIVE_TREE_MAX_SIDECAR,
      DEFAULT_LIVE_TREE.maxSidecar,
    ),
    verify: flag("MIRROR_LIVE_TREE_VERIFY", env.MIRROR_LIVE_TREE_VERIFY, DEFAULT_LIVE_TREE.verify),
  };
}

let current: LiveTreeConfig | undefined;

/** The process's configuration, read from the environment the first time. */
export function processLiveTreeConfig(): LiveTreeConfig {
  current ??= liveTreeConfig();
  return current;
}
