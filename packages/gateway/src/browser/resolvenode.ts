/**
 * Resolve a viewer-visible rrweb node id to the live agent target that owns it.
 *
 * Resolution is deliberately performed for every dispatch. OOPIF target ids are stable frame
 * ids, but their flat CDP sessions can be replaced after a crash or process transition, so every
 * raw CDP operation consults the caller's live target registry.
 */
import { MIRROR_NODE_FN_NAME, type ResolveResult } from "@mirror/protocol";

import type { AgentLink, CdpSend } from "../types";

export interface ResolveNodeDeps {
  agentLink: AgentLink;
  send: CdpSend;
  /** Production's page-invisible RemoteObject bridge; omitted only by legacy/unit harnesses. */
  callBridge?: (sessionId: string, method: "node", args: readonly unknown[]) => Promise<unknown>;
  /** The same, in one particular frame. Without it, only frames with their own target resolve. */
  callFrame?: (
    sessionId: string,
    frameId: string,
    method: "node",
    args: readonly unknown[],
  ) => Promise<unknown>;
  /** Live targetId -> flat CDP sessionId lookup. */
  sessionFor(targetId: string): string | undefined;
}

export interface FrameHop {
  /** Target containing the iframe element. */
  targetId: string;
  /** The frame containing it, when that is not the one the target's bridge belongs to. */
  frameId?: string;
  iframeNodeId: number;
  /** OOPIF frameId, which Chromium also uses as the child targetId. */
  childTargetId: string;
}

export interface ResolvedNode {
  targetId: string;
  /** The frame within that target to send commands to, once a frame boundary has been crossed. */
  frameId?: string;
  localId: number;
  /** Outer-to-inner OOPIF boundaries, used only for rect composition. */
  frameHops: FrameHop[];
}

interface RuntimeEvaluateResult {
  result?: {
    objectId?: string;
    description?: string;
  };
  exceptionDetails?: unknown;
}

interface DescribeNodeResult {
  node?: { frameId?: string };
}

function mirrorNodeExpression(nodeId: number): string {
  return `(0,globalThis[${JSON.stringify(MIRROR_NODE_FN_NAME)}])(${JSON.stringify(nodeId)})`;
}

function asResolveResult(value: unknown): ResolveResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<ResolveResult> & {
    iframeNodeId?: unknown;
    remoteId?: unknown;
  };
  if (candidate.kind === "local") return { kind: "local" };
  if (
    candidate.kind === "remote" &&
    typeof candidate.iframeNodeId === "number" &&
    Number.isSafeInteger(candidate.iframeNodeId) &&
    typeof candidate.remoteId === "number" &&
    Number.isSafeInteger(candidate.remoteId)
  ) {
    return {
      kind: "remote",
      iframeNodeId: candidate.iframeNodeId,
      remoteId: candidate.remoteId,
    };
  }
  return undefined;
}

async function iframeTargetId(
  deps: ResolveNodeDeps,
  parentTargetId: string,
  iframeNodeId: number,
  parentFrameId: string | undefined,
): Promise<string> {
  const sessionId = deps.sessionFor(parentTargetId);
  if (sessionId === undefined) {
    throw new Error(`OOPIF parent target ${parentTargetId} is detached`);
  }

  const evaluated = (await (parentFrameId !== undefined && deps.callFrame !== undefined
    ? deps.callFrame(sessionId, parentFrameId, "node", [iframeNodeId])
    : deps.callBridge === undefined
      ? deps.send(sessionId, "Runtime.evaluate", {
          expression: mirrorNodeExpression(iframeNodeId),
          returnByValue: false,
        })
      : deps.callBridge(sessionId, "node", [iframeNodeId]))) as RuntimeEvaluateResult;
  const objectId = evaluated.result?.objectId;
  if (evaluated.exceptionDetails !== undefined || objectId === undefined) {
    throw new Error(`Could not obtain iframe node ${iframeNodeId} on target ${parentTargetId}`);
  }

  let frameId: string | undefined;
  try {
    const described = (await deps.send(sessionId, "DOM.describeNode", {
      objectId,
    })) as DescribeNodeResult;
    frameId = described.node?.frameId;
  } finally {
    await deps.send(sessionId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  }

  if (frameId === undefined || frameId.length === 0) {
    throw new Error(`DOM.describeNode did not return a frameId for iframe node ${iframeNodeId}`);
  }

  // This lookup is intentionally live and its result is not retained. AgentLink and the next
  // raw CDP operation independently consult their current target/session state. A frame in its
  // parent's process has no target, and is reached through its parent's session by frame id.
  if (deps.sessionFor(frameId) === undefined && deps.callFrame === undefined) {
    throw new Error(`OOPIF child target ${frameId} is not attached`);
  }
  return frameId;
}

/** Resolve a unified rrweb id through any number of attached OOPIF boundaries. */
export async function resolveNode(
  deps: ResolveNodeDeps,
  tabId: string,
  nodeId: number,
): Promise<ResolvedNode> {
  let targetId = tabId;
  let frameId: string | undefined;
  let localId = nodeId;
  const frameHops: FrameHop[] = [];
  const visited = new Set<string>();

  while (true) {
    const visitKey = `${targetId}\0${frameId ?? ""}\0${localId}`;
    if (visited.has(visitKey)) throw new Error("OOPIF node resolution cycle detected");
    visited.add(visitKey);

    const response = await deps.agentLink.sendCmd(
      targetId,
      { cmd: "resolve", nodeId: localId },
      frameId,
    );
    if (!response.ok) {
      throw new Error(response.err ?? `Agent could not resolve node ${localId}`);
    }
    const resolution = asResolveResult(response.data);
    if (resolution === undefined) {
      throw new Error(`Agent returned an invalid resolve result for node ${localId}`);
    }
    if (resolution.kind === "local") {
      return { targetId, ...(frameId === undefined ? {} : { frameId }), localId, frameHops };
    }

    const childFrameId = await iframeTargetId(deps, targetId, resolution.iframeNodeId, frameId);
    frameHops.push({
      targetId,
      ...(frameId === undefined ? {} : { frameId }),
      iframeNodeId: resolution.iframeNodeId,
      childTargetId: childFrameId,
    });
    if (deps.sessionFor(childFrameId) !== undefined) targetId = childFrameId;
    frameId = deps.callFrame === undefined ? undefined : childFrameId;
    localId = resolution.remoteId;
  }
}
