/**
 * Scroll echo suppression.
 *
 * Per-node `userScrolling` flag (500ms decay after last local scroll); drop incoming rrweb
 * scroll events for that node while set. Server-originated scrolls (anchor jumps, SPA route
 * changes) still apply. Window scroll is nodeId 0 — special-case; iframes have their own
 * scrollers; throttle upstream `scroll` msgs per node (<=10Hz), not globally. Same mechanism
 * family as echo — both are pipeline stages.
 */
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type TabId,
  type Up,
} from "@mirror/protocol";
import type { Replayer } from "@rrweb/replay";
import { isElement } from "../input/pointer";
import type { PipelineCtx, Stage } from "./index";

interface UserScrollState {
  lastLocalTs: number;
  lastSentTs: number;
  pending: { x: number; y: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ExpectedServerScroll {
  x: number;
  y: number;
  expiresAt: number;
  arrived?: boolean;
  /** Where the scroller was last seen on its way there, if known. */
  from?: { x: number; y: number };
}

interface DocumentScrollReconcile {
  snap(x: number, y: number): void;
  /** Preserve rrweb's smooth phase for this long before enforcing the exact server position. */
  settleMs: number;
}

interface PendingServerSnap {
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  respectLocalSuppression: boolean;
}

/** Browser/scaling/anchoring differences below this distance are the same semantic position. */
export const SCROLL_MATCH_EPSILON_PX = 3;
/** Replay's smooth scroll keeps stepping for a moment after coming within the distance above. */
const SERVER_SCROLL_TAIL_MS = 200;

export interface ScrollFilter extends Stage {
  localScroll(tab: TabId, nodeId: number, x: number, y: number): void;
  /**
   * Replay itself moved this scroller (putting a rebuilt document back where the page has it): the
   * native scroll event on its way is not the person's.
   */
  expectReplayScroll(nodeId: number, x: number, y: number): void;
  registerDocumentScroll(
    eventNodeId: number,
    nodeId: number,
    reconcile?: DocumentScrollReconcile,
  ): () => void;
  reset(): void;
}

export interface ScrollFilterOptions {
  send(message: Extract<Up, { t: "scroll" }>): void;
  now?: () => number;
  throttleMs?: number;
  suppressMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Where a scroller of the page in view is now, if known. */
  position?(nodeId: number): { x: number; y: number } | null;
}

export function createScrollFilter(options: ScrollFilterOptions): ScrollFilter {
  const now = options.now ?? Date.now;
  const throttleMs = options.throttleMs ?? 100;
  const suppressMs = options.suppressMs ?? 500;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const userScrolling = new Map<number, UserScrollState>();
  const expectedServer = new Map<number, ExpectedServerScroll>();
  // rrweb identifies viewport scroll events by the serialized Document id. The wire protocol
  // deliberately uses nodeId 0 for the top window and the child documentElement id for iframe
  // windows, so native and replay events need an explicit key translation before reconciliation.
  const documentScrollNodes = new Map<number, { nodeId: number; token: object }>();
  const documentReconciles = new Map<
    number,
    { reconcile: DocumentScrollReconcile; token: object }
  >();
  const pendingServerSnaps = new Map<number, PendingServerSnap>();

  const near = (a: { x: number; y: number }, x: number, y: number) =>
    Math.abs(a.x - x) <= SCROLL_MATCH_EPSILON_PX && Math.abs(a.y - y) <= SCROLL_MATCH_EPSILON_PX;

  const expectServerScroll = (nodeId: number, x: number, y: number, timestamp: number) => {
    // Already there: replay moves nothing, so no scroll event comes to mark the arrival, and
    // waiting for one would take the person's own scrolls for replay's for the next two seconds.
    const current = options.position?.(nodeId) ?? null;
    if (current !== null && near(current, x, y)) {
      expectedServer.set(nodeId, {
        x,
        y,
        expiresAt: timestamp + SERVER_SCROLL_TAIL_MS,
        arrived: true,
      });
      return;
    }
    expectedServer.set(nodeId, {
      x,
      y,
      expiresAt: timestamp + 2_000,
      ...(current === null ? {} : { from: current }),
    });
  };

  const snapAuthoritative = (nodeId: number, x: number, y: number, timestamp: number): boolean => {
    const registration = documentReconciles.get(nodeId);
    if (registration === undefined) return false;
    expectServerScroll(nodeId, x, y, timestamp);
    registration.reconcile.snap(x, y);
    return true;
  };

  const scheduleReconcile = (
    nodeId: number,
    x: number,
    y: number,
    delayMs: number,
    respectLocalSuppression: boolean,
  ) => {
    const previous = pendingServerSnaps.get(nodeId);
    if (previous !== undefined) cancel(previous.timer);
    const timer = schedule(
      () => {
        const pending = pendingServerSnaps.get(nodeId);
        if (pending?.timer !== timer) return;
        const local = userScrolling.get(nodeId);
        const remaining = local === undefined ? 0 : suppressMs - (now() - local.lastLocalTs);
        if (pending.respectLocalSuppression && remaining > 0) {
          scheduleReconcile(nodeId, pending.x, pending.y, remaining, true);
          return;
        }
        pendingServerSnaps.delete(nodeId);
        snapAuthoritative(nodeId, pending.x, pending.y, now());
      },
      Math.max(0, delayMs),
    );
    pendingServerSnaps.set(nodeId, { x, y, timer, respectLocalSuppression });
  };

  const filter = ((event: eventWithTime, ctx: PipelineCtx): eventWithTime | null => {
    if (event.type !== EventType.IncrementalSnapshot) return event;
    const data = event.data;
    if (data.source !== IncrementalSource.Scroll) return event;
    const nodeId = documentScrollNodes.get(data.id)?.nodeId ?? data.id;
    const local = userScrolling.get(nodeId);
    const reconcile = documentReconciles.get(nodeId)?.reconcile;
    if (local !== undefined && ctx.nowMs - local.lastLocalTs < suppressMs) {
      if (reconcile !== undefined) {
        scheduleReconcile(
          nodeId,
          data.x,
          data.y,
          suppressMs - (ctx.nowMs - local.lastLocalTs),
          true,
        );
      }
      return null;
    }
    if (reconcile !== undefined) {
      if (reconcile.settleMs === 0) {
        snapAuthoritative(nodeId, data.x, data.y, ctx.nowMs);
        return null;
      }
      expectServerScroll(nodeId, data.x, data.y, ctx.nowMs);
      scheduleReconcile(nodeId, data.x, data.y, reconcile.settleMs, false);
      return event;
    }
    expectServerScroll(nodeId, data.x, data.y, ctx.nowMs);
    return event;
  }) as ScrollFilter;

  const send = (tab: TabId, nodeId: number, state: UserScrollState, x: number, y: number) => {
    state.lastSentTs = now();
    state.pending = null;
    state.timer = null;
    options.send({ t: "scroll", tab, nodeId, x, y });
  };

  filter.localScroll = (tab, nodeId, x, y) => {
    const expected = expectedServer.get(nodeId);
    if (expected !== undefined) {
      const nearTarget = near(expected, x, y);
      // Replay only ever gets closer to its target. A target it cannot reach (the mirror's
      // scroller is shorter) never marks an arrival, so on the way a scroll back away from it is
      // the person's, rather than all of them for the next two seconds.
      const distance = (position: { x: number; y: number }) =>
        Math.abs(position.x - expected.x) + Math.abs(position.y - expected.y);
      const backAway =
        !nearTarget &&
        expected.arrived !== true &&
        expected.from !== undefined &&
        distance({ x, y }) > distance(expected.from) + SCROLL_MATCH_EPSILON_PX;
      if (!nearTarget && expected.arrived !== true) expected.from = { x, y };
      // Once replay has arrived, a scroll away from the target is the person's.
      if (expected.expiresAt >= now() && !backAway && (nearTarget || expected.arrived !== true)) {
        if (nearTarget && expected.arrived !== true) {
          expected.arrived = true;
          expected.expiresAt = Math.min(expected.expiresAt, now() + SERVER_SCROLL_TAIL_MS);
        }
        // Smooth replay produces intermediate native scroll events before reaching the server
        // target. None of those steps are fresh user input and must be echoed upstream.
        return;
      }
      expectedServer.delete(nodeId);
    }

    const timestamp = now();
    const state = userScrolling.get(nodeId) ?? {
      lastLocalTs: timestamp,
      lastSentTs: Number.NEGATIVE_INFINITY,
      pending: null,
      timer: null,
    };
    state.lastLocalTs = timestamp;
    userScrolling.set(nodeId, state);

    const elapsed = timestamp - state.lastSentTs;
    if (elapsed >= throttleMs) {
      if (state.timer !== null) cancel(state.timer);
      send(tab, nodeId, state, x, y);
      return;
    }

    state.pending = { x, y };
    if (state.timer === null) {
      state.timer = schedule(
        () => {
          const current = userScrolling.get(nodeId);
          if (current === undefined || current.pending === null) return;
          send(tab, nodeId, current, current.pending.x, current.pending.y);
        },
        Math.max(0, throttleMs - elapsed),
      );
    }
  };

  filter.expectReplayScroll = (nodeId, x, y) => {
    // The position is already written, and its scroll event is still to come.
    expectedServer.set(nodeId, { x, y, expiresAt: now() + 2_000 });
  };

  filter.registerDocumentScroll = (eventNodeId, nodeId, reconcile) => {
    const token = {};
    documentScrollNodes.set(eventNodeId, { nodeId, token });
    if (reconcile !== undefined) documentReconciles.set(nodeId, { reconcile, token });
    return () => {
      if (documentScrollNodes.get(eventNodeId)?.token === token) {
        documentScrollNodes.delete(eventNodeId);
      }
      if (reconcile !== undefined && documentReconciles.get(nodeId)?.token === token) {
        documentReconciles.delete(nodeId);
      }
    };
  };

  filter.reset = () => {
    for (const state of userScrolling.values()) {
      if (state.timer !== null) cancel(state.timer);
    }
    for (const pending of pendingServerSnaps.values()) cancel(pending.timer);
    userScrolling.clear();
    expectedServer.clear();
    documentScrollNodes.clear();
    documentReconciles.clear();
    pendingServerSnaps.clear();
  };
  return filter;
}

export interface ScrollSyncOptions {
  doc: Document;
  rootDoc?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  filter: ScrollFilter;
  now?: () => number;
}

/**
 * How long after an edit in the replay a scroll of a box around the edited field is the browser
 * keeping the caret in view rather than the person scrolling. The scroll event comes with the next
 * frame after the edit; a slow phone can take a few.
 */
export const EDIT_REVEAL_MS = 250;

/**
 * Capture native mirror scrolling; wheel events themselves take the mutually exclusive D5 path.
 *
 * Typing or pasting into a field of the replay (the legacy path edits the replay's own copy) makes
 * the browser scroll the boxes around the field to keep the caret in view, here as on the page.
 * That scroll is not the person's: the page keeps its own caret in view, and the replay follows
 * its scroll events. Sent upstream, the replay's position (its own text, laid out with this
 * device's fonts, and the page's changes to it held back while typing) would scroll the page's box
 * away from the page's caret and hold the page's next scrolls off for half a second.
 */
export function attachScrollSync(options: ScrollSyncOptions): () => void {
  const now = options.now ?? (() => performance.now());
  const rootDoc = options.rootDoc ?? options.doc;
  const eventNodeId = options.getNodeId(options.doc);
  const nodeId = options.doc === rootDoc ? 0 : options.getNodeId(options.doc.documentElement);
  const view = options.doc.defaultView;
  const unregisterDocument =
    eventNodeId < 0 || nodeId < 0
      ? () => {}
      : options.filter.registerDocumentScroll(
          eventNodeId,
          nodeId,
          view !== null
            ? {
                snap: (x, y) => view.scrollTo({ left: x, top: y, behavior: "auto" }),
                settleMs: options.doc === rootDoc ? 0 : 500,
              }
            : undefined,
        );
  /** The field last edited here, and when; forgotten when the person scrolls by hand. */
  let edited: { field: Node; at: number } | null = null;
  const onInput = (event: Event) => {
    if (event.isTrusted && isElement(event.target)) edited = { field: event.target, at: now() };
  };
  const onScrollGesture = () => {
    edited = null;
  };
  const revealsEdit = (target: EventTarget | null) => {
    if (edited === null || now() - edited.at > EDIT_REVEAL_MS) return false;
    // The document's own scroller is the person's to move (and the page's).
    if (!isElement(target)) return false;
    return target === edited.field || target.contains(edited.field);
  };
  const onScroll = (event: Event) => {
    if (revealsEdit(event.target)) return;
    const target = resolveScrollTarget(event.target, options.doc, options.getNodeId, rootDoc);
    if (target !== null) options.filter.localScroll(options.tab, target.nodeId, target.x, target.y);
  };
  const gesture = { capture: true, passive: true } as const;
  options.doc.addEventListener("input", onInput, true);
  options.doc.addEventListener("wheel", onScrollGesture, gesture);
  options.doc.addEventListener("touchmove", onScrollGesture, gesture);
  options.doc.addEventListener("scroll", onScroll, true);
  return () => {
    unregisterDocument();
    options.doc.removeEventListener("input", onInput, true);
    options.doc.removeEventListener("wheel", onScrollGesture, gesture);
    options.doc.removeEventListener("touchmove", onScrollGesture, gesture);
    options.doc.removeEventListener("scroll", onScroll, true);
  };
}

export function resolveScrollTarget(
  target: EventTarget | null,
  doc: Document,
  getNodeId: (node: Node) => number,
  rootDoc: Document = doc,
): { nodeId: number; x: number; y: number } | null {
  if (
    target === doc ||
    target === doc.defaultView ||
    target === doc.documentElement ||
    target === doc.body ||
    target === doc.scrollingElement
  ) {
    const view = doc.defaultView;
    const root = doc.scrollingElement;
    const nodeId = doc === rootDoc ? 0 : getNodeId(doc.documentElement);
    if (nodeId < 0) return null;
    return {
      nodeId,
      x: view?.scrollX ?? root?.scrollLeft ?? 0,
      y: view?.scrollY ?? root?.scrollTop ?? 0,
    };
  }
  if (!isElement(target)) return null;
  let element: Element | null = target;
  while (element !== null) {
    const nodeId = getNodeId(element);
    if (nodeId >= 0) return { nodeId, x: target.scrollLeft, y: target.scrollTop };
    element = element.parentElement;
  }
  return null;
}

/** A scroller of a replayed page, as the wire names it, and how far it is scrolled. */
function replayScroller(
  replayer: Pick<Replayer, "iframe" | "getMirror">,
  node: Node,
): { nodeId: number; read(): { x: number; y: number } } | null {
  if (!isElement(node)) return null;
  const doc = node.ownerDocument;
  if (node === doc.documentElement || node === doc.body || node === doc.scrollingElement) {
    const view = doc.defaultView;
    if (view === null || doc.documentElement === null) return null;
    const nodeId =
      doc === replayer.iframe.contentDocument ? 0 : replayer.getMirror().getId(doc.documentElement);
    if (nodeId < 0) return null;
    return { nodeId, read: () => ({ x: view.scrollX, y: view.scrollY }) };
  }
  const nodeId = replayer.getMirror().getId(node);
  if (nodeId < 0) return null;
  return { nodeId, read: () => ({ x: node.scrollLeft, y: node.scrollTop }) };
}

/** How far a scroller of the replayed page (wire node id; 0 is its window) is scrolled. */
export function replayScrollPosition(
  replayer: Pick<Replayer, "iframe" | "getMirror"> | null,
  nodeId: number,
): { x: number; y: number } | null {
  if (replayer === null) return null;
  try {
    if (nodeId === 0) {
      const view = replayer.iframe.contentWindow;
      return view === null ? null : { x: view.scrollX, y: view.scrollY };
    }
    const node = replayer.getMirror().getNode(nodeId);
    return node === null ? null : (replayScroller(replayer, node)?.read() ?? null);
  } catch {
    return null;
  }
}

/**
 * Replay puts each element of a document it builds back where the page has it scrolled (rebuild,
 * and the patched attachment of a frame's document). The browser reports that with the same scroll
 * event as the person's scrolling; sent upstream, it would scroll the page back to where it was,
 * after a wheel the person had just forwarded. The patched replay announces each such element
 * before writing it ("scroll-restore"), and the position it ends up at is expected, not sent.
 */
export function watchReplayScrollRestores(
  replayer: Pick<Replayer, "iframe" | "getMirror" | "on" | "off">,
  filter: Pick<ScrollFilter, "expectReplayScroll">,
): () => void {
  const onRestore = (payload: unknown) => {
    try {
      const scroller = replayScroller(replayer, payload as Node);
      if (scroller === null) return;
      const before = scroller.read();
      // Written right after the announcement, in the same task.
      queueMicrotask(() => {
        try {
          const after = scroller.read();
          if (after.x !== before.x || after.y !== before.y)
            filter.expectReplayScroll(scroller.nodeId, after.x, after.y);
        } catch {
          // A document gone in between has nothing to report.
        }
      });
    } catch {
      // Never let this break the replay that announced it.
    }
  };
  replayer.on("scroll-restore", onRestore);
  return () => {
    replayer.off("scroll-restore", onRestore);
  };
}
