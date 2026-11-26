/**
 * Phase timings of one request, such as opening a profile's browser, without threading a recorder
 * through every call: the request runs inside `withTiming`, and code on its path wraps its steps
 * in `timed`. The route sends them as a Server-Timing header (only durations and fixed phase
 * names, nothing about the profile or its exit), which the browser's network panel and
 * scripts/perf-load.mjs show.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export interface TimingPhase {
  name: string;
  ms: number;
}

export class Timing {
  readonly phases: TimingPhase[] = [];
  private readonly started = performance.now();

  add(name: string, ms: number): void {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || !Number.isFinite(ms) || ms < 0) return;
    this.phases.push({ name, ms });
  }

  /** Server-Timing, with the whole request as `total`. */
  header(): string {
    return [...this.phases, { name: "total", ms: performance.now() - this.started }]
      .map(({ name, ms }) => `${name};dur=${ms.toFixed(1)}`)
      .join(", ");
  }
}

const storage = new AsyncLocalStorage<Timing>();

export function withTiming<T>(timing: Timing, operation: () => T): T {
  return storage.run(timing, operation);
}

/** Runs `operation` and records how long it took under `name`, when a request is being timed. */
export async function timed<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  const timing = storage.getStore();
  if (!timing) return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    timing.add(name, performance.now() - started);
  }
}

/** Records phases measured elsewhere, such as the runtime broker's, under a prefix. */
export function recordPhases(prefix: string, phases: unknown): void {
  const timing = storage.getStore();
  if (!timing || typeof phases !== "object" || phases === null) return;
  for (const [name, ms] of Object.entries(phases))
    if (typeof ms === "number") timing.add(`${prefix}${name}`, ms);
}
