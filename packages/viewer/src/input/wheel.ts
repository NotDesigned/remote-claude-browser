/**
 * Wheel-event forwarding without double-applying local scroll.
 *
 * Intercept `wheel` in the mirror. Walk up for a scrollable ancestor and let the browser scroll
 * it locally; if nothing consumed it (scrollTop/scrollLeft unchanged and no scrollable ancestor
 * — the maps/canvas/wheel-hijack case), forward `ptr kind:"wheel"` with dx,dy. Consumed-locally
 * scrolls reach the server ONLY via the 10Hz `scroll` sync. One path or the other, never both.
 *
 * Replay can rebuild a frame's document in place while a wheel over it is still being checked: the
 * rebuild drops the scroll the wheel started, and these listeners with it. Such a wheel, with no
 * scroll of its own seen in the document since, is forwarded then; otherwise it would reach neither
 * side.
 */
import type { TabId } from "@mirror/protocol";
import { isElement, pointerPosition, resolvePointerTarget, type SendInput } from "./pointer";
import { eventMods } from "./encode";

interface ScrollCandidate {
  target: Element | Window;
  x: number;
  y: number;
}

export interface WheelCaptureOptions {
  doc: Document;
  rootDoc?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  now?: () => number;
  settleMs?: number;
  movementEpsilonPx?: number;
  /** Schedule one verification tick; called repeatedly until movement or the settle deadline. */
  afterEvent?: (callback: () => void) => void;
}

export function attachWheelCapture(options: WheelCaptureOptions): () => void {
  const now = options.now ?? (() => options.doc.defaultView?.performance?.now() ?? Date.now());
  const settleMs = options.settleMs ?? 80;
  const movementEpsilonPx = options.movementEpsilonPx ?? 0.5;
  const afterEvent =
    options.afterEvent ??
    ((callback: () => void) => {
      const view = options.doc.defaultView;
      if (view !== null) view.requestAnimationFrame(callback);
      else setTimeout(callback, 16);
    });
  let active = true;
  /** Wheels still being checked, and whether the document has scrolled for each since. */
  const checking = new Set<{
    forward: () => void;
    scrolled: boolean;
    follows: (target: EventTarget | null) => boolean;
  }>();

  const onWheel = (event: WheelEvent) => {
    if (!event.isTrusted) return;
    const candidates = scrollCandidates(event.target, options.doc, event.deltaX, event.deltaY);
    // Where the wheel was, read now: the element can be gone by the time it is forwarded.
    const position = pointerPosition(
      event,
      resolvePointerTarget(event.target, options.getNodeId),
      options.doc,
      options.rootDoc,
    );
    const forward = () => {
      options.send({
        t: "ptr",
        tab: options.tab,
        kind: "wheel",
        ...position,
        buttons: event.buttons,
        mods: eventMods(event),
        dx: event.deltaX,
        dy: event.deltaY,
      });
    };

    if (candidates.length === 0) {
      event.preventDefault();
      forward();
      return;
    }

    // Only a scroll of what the wheel could move, in its direction, is the wheel's. Replay putting a
    // rebuilt element back where it was scrolled fires the same event, and is not.
    const follows = (target: EventTarget | null) =>
      candidates.some((candidate) => {
        const element = candidate.target === options.doc.defaultView ? null : candidate.target;
        const scrolled =
          element === null
            ? target === options.doc ||
              target === options.doc.defaultView ||
              target === options.doc.documentElement ||
              target === options.doc.scrollingElement
            : target === element;
        if (!scrolled) return false;
        const next = scrollPosition(candidate.target, options.doc);
        return (
          movedWith(next.x - candidate.x, event.deltaX, movementEpsilonPx) ||
          movedWith(next.y - candidate.y, event.deltaY, movementEpsilonPx)
        );
      });
    const wheel = { forward, scrolled: false, follows };
    checking.add(wheel);
    const startedAt = now();
    const verifyConsumed = () => {
      if (!active || !checking.has(wheel)) return;
      const consumed = candidates.some(({ target, x, y }) => {
        const next = scrollPosition(target, options.doc);
        return Math.abs(next.x - x) > movementEpsilonPx || Math.abs(next.y - y) > movementEpsilonPx;
      });
      if (consumed) {
        checking.delete(wheel);
        return;
      }
      if (now() - startedAt >= settleMs) {
        checking.delete(wheel);
        forward();
        return;
      }
      afterEvent(verifyConsumed);
    };
    afterEvent(verifyConsumed);
  };
  const onScroll = (event: Event) => {
    for (const wheel of checking) if (!wheel.scrolled) wheel.scrolled = wheel.follows(event.target);
  };

  options.doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
  options.doc.addEventListener("scroll", onScroll, true);
  return () => {
    active = false;
    options.doc.removeEventListener("wheel", onWheel, true);
    options.doc.removeEventListener("scroll", onScroll, true);
    const unseen = [...checking].filter((wheel) => !wheel.scrolled);
    checking.clear();
    for (const wheel of unseen) wheel.forward();
  };
}

export function scrollCandidates(
  target: EventTarget | null,
  doc: Document,
  dx: number,
  dy: number,
): ScrollCandidate[] {
  const result: ScrollCandidate[] = [];
  let element = isElement(target) ? target : null;
  while (element !== null) {
    const view = doc.defaultView;
    const style = view?.getComputedStyle(element);
    if (style !== undefined && canConsume(element, style, dx, dy)) {
      result.push({ target: element, x: element.scrollLeft, y: element.scrollTop });
    }
    element = element.parentElement;
  }

  const view = doc.defaultView;
  const root = doc.scrollingElement;
  if (
    view !== null &&
    root !== null &&
    canConsumeViewport(root, view.getComputedStyle(root), dx, dy)
  ) {
    result.push({ target: view, x: view.scrollX, y: view.scrollY });
  }
  return result;
}

function canConsumeViewport(
  element: Element,
  style: CSSStyleDeclaration,
  dx: number,
  dy: number,
): boolean {
  return (
    (!axisBlocked(style.overflowX) &&
      canMove(element.scrollLeft, element.scrollWidth - element.clientWidth, dx)) ||
    (!axisBlocked(style.overflowY) &&
      canMove(element.scrollTop, element.scrollHeight - element.clientHeight, dy))
  );
}

function canConsume(element: Element, style: CSSStyleDeclaration, dx: number, dy: number): boolean {
  return (
    (axisScrollable(style.overflowX) &&
      canMove(element.scrollLeft, element.scrollWidth - element.clientWidth, dx)) ||
    (axisScrollable(style.overflowY) &&
      canMove(element.scrollTop, element.scrollHeight - element.clientHeight, dy))
  );
}

function canMove(position: number, maximum: number, delta: number): boolean {
  return delta < 0 ? position > 0 : delta > 0 ? position < maximum : false;
}

/** Moved by more than `epsilon`, the way `delta` points. */
function movedWith(moved: number, delta: number, epsilon: number): boolean {
  return delta < 0 ? moved < -epsilon : delta > 0 ? moved > epsilon : false;
}

function axisScrollable(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function axisBlocked(overflow: string): boolean {
  return overflow === "hidden" || overflow === "clip";
}

function scrollPosition(target: Element | Window, doc: Document): { x: number; y: number } {
  if (target === doc.defaultView) {
    const view = target as Window;
    return { x: view.scrollX, y: view.scrollY };
  }
  const element = target as Element;
  return { x: element.scrollLeft, y: element.scrollTop };
}
