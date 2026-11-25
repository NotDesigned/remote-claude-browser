import type { ResourceSample, createResourceSampler } from "./resources";

/** The latest resource sample, and whether memory is too short for another browser or page. */
export function createResourceMonitor(
  sampler: ReturnType<typeof createResourceSampler>,
  first: ResourceSample,
) {
  let current = first;
  const sample = async () => (current = await sampler.sample());
  return {
    current: () => current,
    sample,
    /** Samples again; whether starting something that needs `extraBytes` more would be unsafe. */
    async memoryShort(extraBytes = 0): Promise<boolean> {
      const resources = await sample();
      const available =
        resources.memoryTotalBytes === null || resources.memoryUsedBytes === null
          ? null
          : resources.memoryTotalBytes - resources.memoryUsedBytes;
      const memoryBudget =
        resources.browserMemoryLimitBytes ??
        (resources.memoryTotalBytes === null ? 1600 * 1048576 : resources.memoryTotalBytes * 0.8);
      const workspaceHeadroom = Math.max(300 * 1048576, memoryBudget * 0.1) + extraBytes;
      return (
        (resources.browserMemoryBytes !== null &&
          resources.browserMemoryBytes > memoryBudget - workspaceHeadroom) ||
        (available !== null && available < 256 * 1048576 + extraBytes)
      );
    },
  };
}

export type ResourceMonitor = ReturnType<typeof createResourceMonitor>;
