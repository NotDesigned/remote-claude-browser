/**
 * Exit processes started for a user's use of a proxy node (CPA authorizations, browser profiles
 * through the broker). Each (user, node) pair has its own scope, so stopping one user's exits
 * never touches another's.
 */
import { createHash } from "node:crypto";
import type { MihomoProxy } from "./mihomo";
import type { createRuntimeClient } from "./runtime-client";

type RuntimeClient = Pick<ReturnType<typeof createRuntimeClient>, "startEgress" | "stopEgress">;

/** The runtime's name for a user's exit through a node. */
export const egressScope = (userId: string, nodeId: string) =>
  `scope-${createHash("sha256").update(`${userId}/${nodeId}`).digest("hex").slice(0, 32)}`;

export function createScopedExits(runtime: RuntimeClient) {
  /** The scopes started per node. */
  const started = new Map<string, Set<string>>();
  return {
    /** Starts (or reuses) the user's exit through the node; its proxy URL for outside processes. */
    async start(userId: string, nodeId: string, node: MihomoProxy): Promise<string> {
      const scope = egressScope(userId, nodeId);
      const scopes = started.get(nodeId) ?? new Set<string>();
      scopes.add(scope);
      started.set(nodeId, scopes);
      return (await runtime.startEgress(scope, node)).externalProxyUrl;
    },
    /** The node changed or went away: stop every user's exit through it. */
    async stopNode(nodeId: string, enabled: boolean): Promise<void> {
      if (enabled) for (const scope of started.get(nodeId) ?? []) await runtime.stopEgress(scope);
      started.delete(nodeId);
    },
    /**
     * Stops the user's exits, except through nodes `keep` names (a shared CPA instance still
     * uses them). Collects failures and goes on.
     */
    async stopUser(userId: string, keep: (nodeId: string) => boolean, failures: unknown[]) {
      for (const [nodeId, scopes] of started) {
        const scope = egressScope(userId, nodeId);
        if (!scopes.has(scope)) continue;
        if (keep(nodeId)) continue;
        try {
          await runtime.stopEgress(scope);
          scopes.delete(scope);
          if (!scopes.size) started.delete(nodeId);
        } catch (error) {
          failures.push(error);
        }
      }
    },
  };
}

export type ScopedExits = ReturnType<typeof createScopedExits>;
