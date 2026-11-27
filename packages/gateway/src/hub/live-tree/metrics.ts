/**
 * How page sync goes, process-wide: why pages were asked for snapshots, how viewers were caught
 * up, how the live trees fare and what they cost. Counts and timings only, never page content.
 * The admin overview shows them (pageSync), and each state change logs one debug line.
 */

/** Why a page snapshot was taken (asked for by the gateway, or the page's own). */
export type PageSnapshotCause =
  | "nav"
  | "viewport"
  | "stream-loss"
  | "broken"
  | "verify"
  | "recompact"
  | "dormant"
  | "page-initiated"
  | "resync-legacy";

const PAGE_CAUSES: readonly PageSnapshotCause[] = [
  "nav",
  "viewport",
  "stream-loss",
  "broken",
  "verify",
  "recompact",
  "dormant",
  "page-initiated",
  "resync-legacy",
];

/** A bounded sample of recent timings, for percentiles. */
class Reservoir {
  private readonly values: number[] = [];
  private next = 0;
  count = 0;
  total = 0;

  constructor(private readonly size = 4096) {}

  add(value: number): void {
    this.count += 1;
    this.total += value;
    if (this.values.length < this.size) this.values.push(value);
    else {
      this.values[this.next] = value;
      this.next = (this.next + 1) % this.size;
    }
  }

  summary(): { count: number; mean: number; p50: number; p95: number; p99: number } {
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return {
      count: this.count,
      mean: this.count === 0 ? 0 : this.total / this.count,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    };
  }
}

function counters<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export const pageSyncMetrics = {
  pageSnapshots: counters(PAGE_CAUSES),
  synthSnapshots: 0,
  catchUp: { tail: 0, synth: 0 },
  subtree: { served: 0, fallback: 0 },
  treeBroken: {} as Record<string, number>,
  verify: { match: 0, mismatch: 0, styleOrForm: 0 },
  anomalies: {} as Record<string, number>,
  dormant: 0,
  fallback: {} as Record<string, number>,
  /** Microseconds per applied event. */
  apply: new Reservoir(),
  /** Milliseconds per synthesized snapshot (not the memoized repeats). */
  synth: new Reservoir(512),
};

export function notePageSnapshot(cause: PageSnapshotCause): void {
  pageSyncMetrics.pageSnapshots[cause] += 1;
}

export function noteTreeBroken(kind: string): void {
  pageSyncMetrics.treeBroken[kind] = (pageSyncMetrics.treeBroken[kind] ?? 0) + 1;
}

export function noteFallback(kind: string): void {
  pageSyncMetrics.fallback[kind] = (pageSyncMetrics.fallback[kind] ?? 0) + 1;
}

export function noteAnomalies(delta: Record<string, number>): void {
  for (const [key, value] of Object.entries(delta))
    if (value > 0) pageSyncMetrics.anomalies[key] = (pageSyncMetrics.anomalies[key] ?? 0) + value;
}

/** For tests: back to zero. */
export function resetPageSyncMetrics(): void {
  pageSyncMetrics.pageSnapshots = counters(PAGE_CAUSES);
  pageSyncMetrics.synthSnapshots = 0;
  pageSyncMetrics.catchUp = { tail: 0, synth: 0 };
  pageSyncMetrics.subtree = { served: 0, fallback: 0 };
  pageSyncMetrics.treeBroken = {};
  pageSyncMetrics.verify = { match: 0, mismatch: 0, styleOrForm: 0 };
  pageSyncMetrics.anomalies = {};
  pageSyncMetrics.dormant = 0;
  pageSyncMetrics.fallback = {};
  pageSyncMetrics.apply = new Reservoir();
  pageSyncMetrics.synth = new Reservoir(512);
}

export interface TabTreeGauge {
  tab: string;
  state: string;
  nodes: number;
  estBytes: number;
  sidecar: number;
  ring: number;
}

/** What the admin overview shows. */
export function pageSyncDiagnostics(tabs: readonly TabTreeGauge[]) {
  const m = pageSyncMetrics;
  return {
    pageSnapshots: { ...m.pageSnapshots },
    synthSnapshots: m.synthSnapshots,
    catchUp: { ...m.catchUp },
    subtree: { ...m.subtree },
    treeBroken: { ...m.treeBroken },
    verify: { ...m.verify },
    anomalies: { ...m.anomalies },
    dormant: m.dormant,
    fallback: { ...m.fallback },
    applyMicros: m.apply.summary(),
    synthMs: m.synth.summary(),
    tabs,
  };
}

/** One line per state change, for the operator's log (ids and counts only). */
export function logTree(message: string): void {
  if (process.env.MIRROR_LIVE_TREE_LOG === "0") return;
  console.debug(`live-tree: ${message}`);
}
