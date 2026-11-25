import type { ServerStatusMsg } from "@mirror/protocol";
import type { ExitMetadata } from "../egress/timezone";
import type { ResourceSample } from "./resources";

/** A sample older than this shows no figures rather than old ones. */
const STALE_SAMPLE_MS = 10_000;

export interface ServerStatusDeps {
  resources(): ResourceSample;
  /** How many devices have a viewer connected. */
  onlineOwners(): number;
  /** How many workspaces exist. */
  allocated(): number;
  pixelsActive(): number;
  /** The exit a session's browser uses: its running account's, else its profile's last one. */
  exitFor(sid: string): Partial<ExitMetadata> | undefined;
}

/** The `server-status` message: host resources, totals, and a session's exit. */
export function createServerStatus(deps: ServerStatusDeps) {
  let lastStatusAt = 0;
  return (sid?: string): ServerStatusMsg => {
    // Strictly increasing, so a viewer can tell a newer status from an older one.
    lastStatusAt = Math.max(Date.now(), lastStatusAt + 1);
    const resources = deps.resources();
    const stale = Date.now() - resources.sampledAt > STALE_SAMPLE_MS;
    const exit = sid ? deps.exitFor(sid) : undefined;
    return {
      ...resources,
      sampledAt: lastStatusAt,
      ...(stale
        ? {
            cpuPercent: null,
            memoryUsedBytes: null,
            memoryTotalBytes: null,
            browserMemoryBytes: null,
          }
        : {}),
      t: "server-status",
      clientsOnline: deps.onlineOwners(),
      clientsAllocated: deps.allocated(),
      pixelsActive: deps.pixelsActive(),
      pixelsMax: null,
      ...(exit
        ? { timeZone: exit.timeZone, exitCity: exit.exitCity, exitCountry: exit.exitCountry }
        : {}),
    };
  };
}
