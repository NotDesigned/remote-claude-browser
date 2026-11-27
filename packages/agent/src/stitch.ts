/**
 * Re-requests cross-origin child snapshots after rrweb has registered their host iframe.
 *
 * rrweb 2.1.1 does not buffer child FullSnapshots that arrive before registration and does not
 * request another child snapshot after a top-level checkout. This private agent-to-agent message
 * closes both holes while keeping rrweb's parent-side iframe ID transform canonical.
 */

import { EventType, IncrementalSource, type eventWithTime } from "@mirror/protocol";

/** rrweb-snapshot's NodeType.Document. */
const DOCUMENT_NODE = 0;

export const STITCH_SYNC_MESSAGE_TYPE = "@mirror/stitch-sync";
export const STITCH_READY_MESSAGE_TYPE = "@mirror/stitch-ready";
/**
 * Sent down by the recorder that took in a child's snapshot. The answer to the child's ready
 * message only matters when its snapshot came before the frame was known and was dropped: one that
 * was taken in needs no second snapshot, which would rebuild the frame in the replay once more.
 */
export const STITCH_ACK_MESSAGE_TYPE = "@mirror/stitch-ack";
export const STITCH_SYNC_MIN_INTERVAL_MS = 250;

type StitchKind = "sync" | "sync-ready" | "ready" | "ack";
/**
 * Hardening: the value under the session's key for each message: 1 sync, 2 ready, 3 ack, and 4 the
 * sync that answers a ready (the `ready: true` of the fixed-name form).
 */
const KEYED: Record<StitchKind, number> = { sync: 1, ready: 2, ack: 3, "sync-ready": 4 };
let stitchKey = "";

/**
 * Hardening: frames of one browser exchange `{[key]: n}` instead of messages with fixed names a
 * page could look for, and a child passes its rrweb events up under the same key. Empty: the fixed
 * names. Set once, at agent start, before any listener is installed.
 */
export function setStitchKey(key: string): void {
  stitchKey = key;
}

function stitchMessage(kind: StitchKind): unknown {
  if (stitchKey !== "") return { [stitchKey]: KEYED[kind] };
  if (kind === "sync") return { type: STITCH_SYNC_MESSAGE_TYPE };
  if (kind === "sync-ready") return { type: STITCH_SYNC_MESSAGE_TYPE, ready: true };
  if (kind === "ready") return { type: STITCH_READY_MESSAGE_TYPE };
  return { type: STITCH_ACK_MESSAGE_TYPE };
}

/** The stitch message `data` is, if it is one. */
export function readStitchMessage(data: unknown): StitchKind | null {
  if (typeof data !== "object" || data === null) return null;
  if (stitchKey !== "") {
    const value = (data as Record<string, unknown>)[stitchKey];
    for (const kind of Object.keys(KEYED) as StitchKind[]) if (KEYED[kind] === value) return kind;
    return null;
  }
  const { type, ready } = data as { type?: unknown; ready?: unknown };
  if (type === STITCH_SYNC_MESSAGE_TYPE) return ready === true ? "sync-ready" : "sync";
  if (type === STITCH_READY_MESSAGE_TYPE) return "ready";
  if (type === STITCH_ACK_MESSAGE_TYPE) return "ack";
  return null;
}

/** An rrweb event passed up to the frame above, the way rrweb's own child recorder passes it. */
export function rrwebParentMessage(event: unknown, origin: string, isCheckout: boolean): unknown {
  if (stitchKey !== "") return { [stitchKey]: { event, origin, isCheckout } };
  return { type: "rrweb", event, origin, isCheckout };
}

export interface StitchSyncDependencies {
  isRecorderStarted(): boolean;
  onRecorderStarted(listener: () => void): () => void;
  /**
   * `framesAsked`: the request has just been passed to the frames below, so the snapshot need not
   * ask them again. A second request has them send their documents twice, and replay rebuilds the
   * frame a moment after it first showed, under whoever is already using it.
   */
  takeFullSnapshot(framesAsked: boolean): void;
  now?: () => number;
}

/**
 * rrweb briefly creates a hidden blank frame to read untouched prototypes. A recorder in it would
 * create another, each inside the last, hundreds deep, and the replayer loses whole batches of
 * changes to frames that are already gone. In a sandboxed parent the frame has its own origin and
 * cannot see its element, but then the parent cannot write to it either, so it is empty for good.
 */
export function isHiddenBlankFrame(target: Window = window): boolean {
  if (target.parent === target || target.location.href !== "about:blank") return false;
  try {
    const frame = target.frameElement as HTMLElement | null;
    return frame === null || frame.style.display === "none";
  } catch {
    return true;
  }
}

export function isCrossOriginChild(target: Window = window): boolean {
  if (target.parent === target) return false;

  try {
    // Keep this probe aligned with rrweb 2.1.1's passEmitsToParent detection.
    void target.parent.document;
    return false;
  } catch {
    return true;
  }
}

export function broadcastStitchSync(target: Window = window): void {
  for (const frame of Array.from(target.frames)) {
    frame.postMessage(stitchMessage("sync"), "*");
  }
}

export function installStitchReadyListener(target: Window = window): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (readStitchMessage(event.data) !== "ready" || event.source === null) return;

    // Reply directly to the ready child. A nested child forwards the resulting sync to its own
    // descendants, preserving the depth>=2 path without waking unrelated sibling recorders.
    (event.source as Window).postMessage(stitchMessage("sync-ready"), "*");
  };

  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}

interface SerializedTree {
  id: number;
  type?: number;
  tagName?: string;
  childNodes?: SerializedTree[];
}

function framesIn(node: SerializedTree, found: number[] = []): number[] {
  if (node.tagName === "iframe") found.push(node.id);
  for (const child of node.childNodes ?? []) framesIn(child, found);
  return found;
}

/**
 * A page can move a frame without reloading it, as Claude does when an artifact panel reopens, and
 * with moveBefore as its documents open. The frames inside never restart, so nothing else tells them
 * that the replay has built a new, empty frame and lost their content. Such a frame comes back with
 * the same id, as does a document. A snapshot requests the reports itself, and a report arriving is
 * only remembered, since treating it as a return would ask for another report forever.
 */
export function createReturnedDocumentCheck(): (
  event: eventWithTime,
  /** The frames in the snapshot, or in each added tree, when the caller has already walked them. */
  framesFound?: readonly (readonly number[])[],
) => boolean {
  const attached = new Set<number>();
  const frames = new Set<number>();
  return (event, framesFound) => {
    if (event.type === EventType.FullSnapshot) {
      attached.clear();
      frames.clear();
      const found = framesFound?.[0] ?? framesIn(event.data.node as unknown as SerializedTree);
      for (const id of found) frames.add(id);
      return false;
    }
    if (event.type !== EventType.IncrementalSnapshot) return false;
    if (event.data.source !== IncrementalSource.Mutation) return false;
    let returned = false;
    for (const [index, { node }] of event.data.adds.entries()) {
      const found = framesFound?.[index] ?? framesIn(node as unknown as SerializedTree);
      if (node.type === DOCUMENT_NODE) {
        if (attached.has(node.id)) returned = true;
        attached.add(node.id);
      } else if (found.some((id) => frames.has(id))) {
        returned = true;
      }
      for (const id of found) frames.add(id);
    }
    return returned;
  };
}

/**
 * rrweb turns a child's snapshot that it takes in into an attachment of the child's document to its
 * frame. Tell that frame's document, so it can leave out the snapshot the ready answer asks for.
 */
export function acknowledgeAttachedDocument(
  event: eventWithTime,
  nodeFor: (id: number) => Node | null,
): void {
  if (
    event.type !== EventType.IncrementalSnapshot ||
    event.data.source !== IncrementalSource.Mutation ||
    event.data.isAttachIframe !== true
  )
    return;
  for (const { parentId, node } of event.data.adds) {
    if (node.type !== DOCUMENT_NODE) continue;
    const frame = nodeFor(parentId) as HTMLIFrameElement | null;
    try {
      frame?.contentWindow?.postMessage(stitchMessage("ack"), "*");
    } catch {
      // A frame on its way out has no window to tell.
    }
  }
}

/**
 * A same-origin child has no recorder of its own, as the frame above records its document. Its
 * cross-origin descendants still need the request, or they stay empty after a new snapshot.
 */
export function installStitchSyncForwarder(target: Window = window): () => void {
  const onMessage = (event: MessageEvent): void => {
    const kind = readStitchMessage(event.data);
    if (kind === "sync" || kind === "sync-ready") broadcastStitchSync(target);
  };
  target.addEventListener("message", onMessage);
  return () => target.removeEventListener("message", onMessage);
}

export function installStitchSyncListener(
  target: Window,
  dependencies: StitchSyncDependencies,
): () => void {
  const now = dependencies.now ?? Date.now;
  let lastSnapshotAt = Number.NEGATIVE_INFINITY;
  let pendingSnapshot = false;
  /** The frame above took in this document's latest snapshot. */
  let acknowledged = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `request`: called for a request that has just come. A snapshot taken now passes it to the
   * frames below first, as it follows the request down. One put off asks them itself when it is
   * taken (index.ts), and one that turns out not to be needed has nothing to ask them for.
   */
  const honorPendingSnapshot = (request = false): void => {
    if (!pendingSnapshot || !dependencies.isRecorderStarted()) return;

    const snapshotAt = now();
    const elapsed = snapshotAt - lastSnapshotAt;
    if (elapsed < STITCH_SYNC_MIN_INTERVAL_MS) {
      if (pendingTimer === null) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          honorPendingSnapshot();
        }, STITCH_SYNC_MIN_INTERVAL_MS - elapsed);
      }
      return;
    }

    if (request) broadcastStitchSync(target);
    try {
      dependencies.takeFullSnapshot(request);
      pendingSnapshot = false;
      acknowledged = false;
      lastSnapshotAt = snapshotAt;
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
    } catch {
      // Keep the request queued if rrweb's recording flag trails our FullSnapshot readiness
      // signal. The stitch-ready response provides another attempt from a later task.
    }
  };

  const removeRecorderStartedListener = dependencies.onRecorderStarted(() => {
    // The recorder's first snapshot has just gone up, after any request that came while it was
    // starting: that request is answered. The snapshot counts for the rate limit, and the answer to
    // the ready message below asks for another only if the frame above dropped it.
    lastSnapshotAt = now();
    acknowledged = false;
    pendingSnapshot = false;
    target.parent.postMessage(stitchMessage("ready"), "*");
  });

  const onMessage = (event: MessageEvent): void => {
    const kind = readStitchMessage(event.data);
    if (kind === "ack") {
      acknowledged = true;
      // The frame above took in a snapshot of this document after the request that is waiting
      // was sent, which is all that request asked for.
      if (pendingSnapshot) {
        pendingSnapshot = false;
        if (pendingTimer !== null) clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      return;
    }
    if (kind !== "sync" && kind !== "sync-ready") return;
    // The answer to this document's ready message, whose snapshot the frame above already has.
    if (kind === "sync-ready" && acknowledged && !pendingSnapshot) return;

    pendingSnapshot = true;
    // Forward even while this recorder is starting so an intermediate frame cannot prevent a
    // ready descendant from honoring the request.
    if (!dependencies.isRecorderStarted()) {
      broadcastStitchSync(target);
      return;
    }
    // Only a snapshot taken now follows the request on its way down. One taken later, after the
    // frames below have answered, rebuilds them in the replay and has to ask them again.
    honorPendingSnapshot(true);
  };

  target.addEventListener("message", onMessage);
  return () => {
    removeRecorderStartedListener();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    target.removeEventListener("message", onMessage);
  };
}
