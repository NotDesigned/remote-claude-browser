import { readFile as readFsFile } from "node:fs/promises";
import { availableParallelism, cpus as hostCpus } from "node:os";

export interface ResourceSample {
  sampledAt: number;
  /** Total host CPU utilization, normalized over all logical CPUs to 0–100. */
  cpuPercent: number | null;
  cpuCount: number;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  /** This service's cgroup v2 memory.current, including its Chrome child processes. */
  browserMemoryBytes: number | null;
  /** The service's current hard memory quota. Null when unavailable or unlimited. */
  browserMemoryLimitBytes: number | null;
}

export interface ResourceSamplerOptions {
  readFile?: (path: string) => Promise<string>;
  cpus?: () => readonly unknown[];
  now?: () => number;
  /** Omit to discover this process's cgroup v2 path; null disables the optional reading. */
  cgroupMemoryPath?: string | null;
}

interface CpuReading {
  counters: bigint[];
  total: bigint;
  idle: bigint;
  cpuCount: number;
}

export function createResourceSampler(options: ResourceSamplerOptions = {}): {
  sample(): Promise<ResourceSample>;
} {
  const readFile = options.readFile ?? ((path: string) => readFsFile(path, "utf8"));
  const cpus = options.cpus ?? hostCpus;
  const now = options.now ?? Date.now;
  let previousCpu: CpuReading | null = null;
  let discoveredCgroupPath: string | undefined;
  let pending: Promise<ResourceSample> | undefined;

  const read = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  };
  const fallbackCpuCount = (): number => {
    try {
      const count = cpus().length;
      if (Number.isSafeInteger(count) && count > 0) return count;
    } catch {
      // The aggregate /proc/stat utilization remains independent of this metadata fallback.
    }
    return availableParallelism();
  };
  const readCgroupMemory = async () => {
    const unavailable = { browserMemoryBytes: null, browserMemoryLimitBytes: null };
    if (options.cgroupMemoryPath === null) return unavailable;
    let path = options.cgroupMemoryPath ?? discoveredCgroupPath;
    if (path === undefined) {
      const membership = await read("/proc/self/cgroup");
      const group = membership?.match(/^0::(\/[^\r\n]*)$/m)?.[1];
      if (group === undefined || group.split("/").some((part) => part === "." || part === ".."))
        return unavailable;
      path = `/sys/fs/cgroup${group === "/" ? "" : group}/memory.current`;
      discoveredCgroupPath = path;
    }
    const [current, limit] = await Promise.all([
      read(path),
      read(path.replace(/memory\.current$/, "memory.max")),
    ]);
    return {
      browserMemoryBytes: current === null ? null : unsignedBytes(current.trim()),
      browserMemoryLimitBytes: limit === null ? null : unsignedBytes(limit.trim()),
    };
  };
  const sampleOnce = async (): Promise<ResourceSample> => {
    const sampledAt = now();
    const [stat, meminfo, cgroupMemory] = await Promise.all([
      read("/proc/stat"),
      read("/proc/meminfo"),
      readCgroupMemory(),
    ]);
    const parsedCpu = stat === null ? null : cpuCounters(stat);
    const cpuCount = stat?.match(/^cpu\d+\s/gm)?.length || fallbackCpuCount();
    const currentCpu = parsedCpu === null ? null : { ...parsedCpu, cpuCount };
    let cpuPercent: number | null = null;
    if (previousCpu !== null && currentCpu !== null && previousCpu.cpuCount === cpuCount) {
      const reset = currentCpu.counters.some(
        (value, index) => value < previousCpu!.counters[index]!,
      );
      const total = currentCpu.total - previousCpu.total;
      const idle = currentCpu.idle - previousCpu.idle;
      if (!reset && total > 0n && idle >= 0n && idle <= total) {
        // Integer basis points avoid precision loss on hosts with long-running CPU counters.
        cpuPercent = Number(((total - idle) * 10_000n + total / 2n) / total) / 100;
      }
    }
    // An unavailable/malformed reading breaks the baseline; the next valid one warms up again.
    previousCpu = currentCpu;
    const memoryTotalBytes = memoryField(meminfo, "MemTotal");
    const available = memoryField(meminfo, "MemAvailable");
    const memoryUsedBytes =
      memoryTotalBytes !== null &&
      memoryTotalBytes > 0 &&
      available !== null &&
      available <= memoryTotalBytes
        ? memoryTotalBytes - available
        : null;
    return {
      sampledAt,
      cpuPercent,
      cpuCount,
      memoryUsedBytes,
      memoryTotalBytes: memoryTotalBytes === 0 ? null : memoryTotalBytes,
      ...cgroupMemory,
    };
  };

  return {
    sample() {
      // Coalesce overlapping timer ticks so a slower read cannot overwrite a newer CPU baseline.
      pending ??= sampleOnce().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

function cpuCounters(stat: string): Omit<CpuReading, "cpuCount"> | null {
  const values = stat
    .match(/^cpu\s+([^\r\n]+)$/m)?.[1]
    ?.trim()
    .split(/\s+/);
  if (values === undefined || values.length < 4) return null;
  const counters: bigint[] = [];
  for (let index = 0; index < 8; index += 1) {
    const value = values[index] ?? "0";
    if (!/^\d+$/.test(value)) return null;
    counters.push(BigInt(value));
  }
  // guest/guest_nice are already included in user/nice, so summing them again is incorrect.
  return {
    counters,
    total: counters.reduce((sum, value) => sum + value, 0n),
    idle: counters[3]! + counters[4]!,
  };
}

function memoryField(meminfo: string | null, name: "MemTotal" | "MemAvailable"): number | null {
  if (meminfo === null) return null;
  const value = meminfo.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, "m"))?.[1];
  return value === undefined ? null : unsignedBytes(value, 1024n);
}

function unsignedBytes(value: string, multiplier = 1n): number | null {
  if (!/^\d+$/.test(value)) return null;
  const bytes = BigInt(value) * multiplier;
  return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
}
