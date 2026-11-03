import { describe, expect, it, vi } from "vitest";
import { createResourceSampler } from "./resources";

const meminfo = "MemTotal: 2048 kB\nMemFree: 64 kB\nMemAvailable: 1024 kB\nCached: 900 kB\n";
const stat = (values: string, count = 2) =>
  `cpu ${values}\n${Array.from({ length: count }, (_, index) => `cpu${index} 1 0 1 1`).join(
    "\n",
  )}\nintr 0\n`;
const denied = async () => {
  throw new Error("EACCES");
};

function harness(stats: string[], extra: Record<string, string> = {}) {
  const files = new Map(Object.entries({ "/proc/meminfo": meminfo, ...extra }));
  const readFile = vi.fn(async (path: string) => {
    if (path === "/proc/stat") {
      const current = stats.shift();
      if (current === undefined) throw new Error("stat unavailable");
      return current;
    }
    const value = files.get(path);
    if (value === undefined) throw new Error("file unavailable");
    return value;
  });
  const sampler = createResourceSampler({
    readFile,
    cpus: () => [{}],
    now: () => 1234,
    cgroupMemoryPath: "/fixture/memory.current",
  });
  return { files, readFile, sampler };
}

describe("host resource sampler", () => {
  it("reads a raised service quota without retaining the old memory budget", async () => {
    const h = harness([stat("1 0 1 8"), stat("2 0 1 9"), stat("3 0 1 10")], {
      "/fixture/memory.current": String(1200 * 1048576),
      "/fixture/memory.max": String(1600 * 1048576),
    });
    expect((await h.sampler.sample()).browserMemoryLimitBytes).toBe(1600 * 1048576);
    h.files.set("/fixture/memory.max", String(3328 * 1048576));
    expect((await h.sampler.sample()).browserMemoryLimitBytes).toBe(3328 * 1048576);
    h.files.set("/fixture/memory.max", "max\n");
    expect(await h.sampler.sample()).toMatchObject({
      browserMemoryBytes: 1200 * 1048576,
      browserMemoryLimitBytes: null,
    });
  });

  it("warms up CPU, normalizes all cores, excludes duplicate guest time and uses MemAvailable", async () => {
    const h = harness(
      [stat("100 10 40 800 40 0 0 10 50 5"), stat("130 10 50 850 50 0 0 10 80 5")],
      { "/fixture/memory.current": "786432\n" },
    );
    expect(await h.sampler.sample()).toEqual({
      sampledAt: 1234,
      cpuPercent: null,
      cpuCount: 2,
      memoryUsedBytes: 1024 * 1024,
      memoryTotalBytes: 2048 * 1024,
      browserMemoryBytes: 786432,
      browserMemoryLimitBytes: null,
    });
    expect((await h.sampler.sample()).cpuPercent).toBe(40);
  });

  it("rebases on counter reset, invalid data, zero elapsed ticks and CPU hotplug", async () => {
    const h = harness([
      stat("100 0 100 800"),
      stat("10 0 10 80"),
      stat("20 0 10 90"),
      stat("20 0 10 90"),
      stat("invalid 0 10 90"),
      stat("30 0 10 100"),
      stat("40 0 10 110", 3),
      stat("50 0 10 120", 3),
    ]);
    const samples = [];
    for (let index = 0; index < 8; index += 1) samples.push(await h.sampler.sample());
    expect(samples.map((sample) => sample.cpuPercent)).toEqual([
      null,
      null,
      50,
      null,
      null,
      null,
      null,
      50,
    ]);
    expect(samples[6]?.cpuCount).toBe(3);
  });

  it("reports unavailable fields as null while preserving independent successful readings", async () => {
    const sampler = createResourceSampler({ readFile: denied, cpus: () => [{}, {}], now: () => 1 });
    expect(await sampler.sample()).toEqual({
      sampledAt: 1,
      cpuPercent: null,
      cpuCount: 2,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      browserMemoryBytes: null,
      browserMemoryLimitBytes: null,
    });
    const h = harness([stat("1 0 1 8")], { "/fixture/memory.current": "0\n" });
    h.files.set("/proc/meminfo", "MemTotal: 2048 kB\nMemFree: 1024 kB\n");
    expect(await h.sampler.sample()).toMatchObject({
      memoryTotalBytes: 2048 * 1024,
      memoryUsedBytes: null,
      browserMemoryBytes: 0,
    });
  });

  it("rejects inconsistent memory counters and byte counts beyond safe integer precision", async () => {
    const h = harness([stat("1 0 1 8"), stat("2 0 1 9")], {
      "/fixture/memory.current": "9007199254740992",
    });
    h.files.set("/proc/meminfo", "MemTotal: 100 kB\nMemAvailable: 101 kB\n");
    expect(await h.sampler.sample()).toMatchObject({
      memoryUsedBytes: null,
      browserMemoryBytes: null,
    });
    h.files.set("/proc/meminfo", "MemTotal: 9007199254740992 kB\nMemAvailable: 0 kB\n");
    expect(await h.sampler.sample()).toMatchObject({
      memoryTotalBytes: null,
      memoryUsedBytes: null,
    });
  });

  it("discovers the service cgroup v2 path once and retries a failed memory reading", async () => {
    let current = "not-a-number";
    const readFile = vi.fn(async (path: string) => {
      if (path === "/proc/stat") return stat("1 0 1 8");
      if (path === "/proc/meminfo") return meminfo;
      if (path === "/proc/self/cgroup") return "0::/claude-browser.slice/claude-browser.service\n";
      if (path === "/sys/fs/cgroup/claude-browser.slice/claude-browser.service/memory.current")
        return current;
      throw new Error("unexpected path");
    });
    const sampler = createResourceSampler({ readFile });
    expect((await sampler.sample()).browserMemoryBytes).toBeNull();
    current = "1048576\n";
    expect((await sampler.sample()).browserMemoryBytes).toBe(1048576);
    expect(readFile.mock.calls.filter(([path]) => path === "/proc/self/cgroup")).toHaveLength(1);
  });

  it("never resolves cgroup traversal outside the mount and can disable optional cgroup reads", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === "/proc/stat") return stat("1 0 1 8");
      if (path === "/proc/meminfo") return meminfo;
      if (path === "/proc/self/cgroup") return "0::/../../other\n";
      throw new Error("unexpected path");
    });
    expect((await createResourceSampler({ readFile }).sample()).browserMemoryBytes).toBeNull();
    expect(readFile.mock.calls.some(([path]) => path.startsWith("/sys/"))).toBe(false);
    readFile.mockClear();
    expect(
      (await createResourceSampler({ readFile, cgroupMemoryPath: null }).sample())
        .browserMemoryBytes,
    ).toBeNull();
    expect(readFile.mock.calls.map(([path]) => path).sort()).toEqual([
      "/proc/meminfo",
      "/proc/stat",
    ]);
  });

  it("coalesces overlapping samples instead of racing CPU baselines", async () => {
    let resolveStat!: (value: string) => void;
    const pendingStat = new Promise<string>((resolve) => {
      resolveStat = resolve;
    });
    const readFile = vi.fn(async (path: string) => (path === "/proc/stat" ? pendingStat : meminfo));
    const sampler = createResourceSampler({ readFile, cgroupMemoryPath: null });
    const first = sampler.sample();
    const second = sampler.sample();
    expect(first).toBe(second);
    expect(readFile.mock.calls.filter(([path]) => path === "/proc/stat")).toHaveLength(1);
    resolveStat(stat("100 0 100 800"));
    expect((await first).cpuPercent).toBeNull();
    expect(await second).toEqual(await first);
  });
});
