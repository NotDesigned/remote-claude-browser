import type { TabId } from "@mirror/protocol";
import {
  eventMods,
  pointerPosition,
  resolveClickTarget,
  type SendInput,
  type TouchMouseFilter,
} from "./pointer";
import { scrollCandidates } from "./wheel";

export interface TouchCaptureOptions {
  linkToOpen?(target: EventTarget | null): string | null;
  openLink?(url: string): void;
  doc: Document;
  rootDoc?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  beforePointerDown?(): void;
  mouseFilter?: TouchMouseFilter;
  now?: () => number;
  settleMs?: number;
  movementEpsilonPx?: number;
  /** Schedule one verification tick; called repeatedly until movement or the settle deadline. */
  afterEvent?: (callback: () => void) => void;
}

const TOUCH_SLOP_PX = 10;
/** A swipe this many times wider than tall is sideways. */
const SIDEWAYS_RATIO = 2;

interface TouchGesture {
  mode: "pending" | "scroll-pan" | "hijack-wheel" | "drag";
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  target: EventTarget;
  latestEvent: TouchEvent | null;
  latestTouch: Touch | null;
  verifyConsumed: (() => void) | null;
}

export function attachTouchCapture(options: TouchCaptureOptions): () => void {
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
  let gesture: TouchGesture | null = null;
  let active = true;

  const forwardWheel = (
    current: TouchGesture,
    touch: Touch,
    event: TouchEvent,
    dx: number,
    dy: number,
  ) => {
    const target = resolveClickTarget(current.target, options.getNodeId);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind: "wheel",
      ...pointerPosition(touch, target, options.doc, options.rootDoc),
      buttons: 0,
      mods: eventMods(event),
      dx,
      dy,
    });
  };

  const forwardTap = (current: TouchGesture, touch: Touch, event: TouchEvent) => {
    const url = options.linkToOpen?.(current.target);
    if (url) {
      // Stops the click that would follow, and the link would open a second time.
      event.preventDefault();
      options.openLink?.(url);
      return;
    }
    options.beforePointerDown?.();
    const target = resolveClickTarget(current.target, options.getNodeId);
    const position = pointerPosition(touch, target, options.doc, options.rootDoc);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind: "move",
      ...position,
      buttons: 0,
      mods: eventMods(event),
    });
    options.send({
      t: "ptr",
      tab: options.tab,
      kind: "down",
      ...position,
      button: 0,
      buttons: 1,
      mods: eventMods(event),
      clicks: 1,
    });
    options.send({
      t: "ptr",
      tab: options.tab,
      kind: "up",
      ...position,
      button: 0,
      buttons: 0,
      mods: eventMods(event),
      clicks: 1,
    });
  };

  /**
   * Presses at the start of the swipe and moves with the finger, as a mouse drag would. The
   * gateway places each move from where the press landed, so the node pressed is all it needs.
   */
  const dragPointer = (
    current: TouchGesture,
    point: Pick<Touch, "clientX" | "clientY">,
    event: TouchEvent,
    kind: "move" | "down" | "up",
    buttons: number,
  ) => {
    const target = resolveClickTarget(current.target, options.getNodeId);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind,
      ...pointerPosition(point, target, options.doc, options.rootDoc),
      ...(kind === "move" ? {} : { button: 0, clicks: 1 }),
      buttons,
      mods: eventMods(event),
    });
    current.lastX = point.clientX;
    current.lastY = point.clientY;
  };

  const startDrag = (current: TouchGesture, touch: Touch, event: TouchEvent) => {
    current.mode = "drag";
    event.preventDefault();
    options.beforePointerDown?.();
    const start = { clientX: current.startX, clientY: current.startY };
    dragPointer(current, start, event, "move", 0);
    dragPointer(current, start, event, "down", 1);
    dragPointer(current, touch, event, "move", 1);
  };

  /** A drag the browser took away, or a second finger joined, still lets go of the button. */
  const releaseDrag = (event: TouchEvent) => {
    if (gesture?.mode === "drag")
      dragPointer(gesture, { clientX: gesture.lastX, clientY: gesture.lastY }, event, "up", 0);
  };

  const onTouchStart = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    if (event.touches.length !== 1) {
      releaseDrag(event);
      gesture = null;
      return;
    }
    const touch = event.touches[0]!;
    options.mouseFilter?.touch(touch);
    gesture = {
      mode: "pending",
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      target: touch.target,
      latestEvent: null,
      latestTouch: null,
      verifyConsumed: null,
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    if (gesture === null) return;
    if (event.touches.length !== 1) {
      releaseDrag(event);
      gesture = null;
      return;
    }

    const touch = event.touches[0]!;
    if (gesture.mode === "pending") {
      const distance = Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
      if (distance <= TOUCH_SLOP_PX) return;

      const deltaX = -(touch.clientX - gesture.startX);
      const deltaY = -(touch.clientY - gesture.startY);
      // Sideways over something that cannot scroll that way, such as a slider: drag it.
      if (
        Math.abs(deltaX) > SIDEWAYS_RATIO * Math.abs(deltaY) &&
        scrollCandidates(gesture.target, options.doc, deltaX, 0).length === 0
      ) {
        startDrag(gesture, touch, event);
        return;
      }
      const candidates = scrollCandidates(gesture.target, options.doc, deltaX, deltaY);
      if (candidates.length > 0) {
        gesture.mode = "scroll-pan";
        gesture.latestEvent = event;
        gesture.latestTouch = touch;
        const verifyingGesture = gesture;
        const startedAt = now();
        const verifyConsumed = () => {
          if (!active || gesture !== verifyingGesture || verifyingGesture.mode !== "scroll-pan") {
            return true;
          }
          const consumed = candidates.some(({ target, x, y }) => {
            const next = scrollPosition(target, options.doc);
            return (
              Math.abs(next.x - x) > movementEpsilonPx || Math.abs(next.y - y) > movementEpsilonPx
            );
          });
          if (consumed) {
            verifyingGesture.verifyConsumed = null;
            return true;
          }
          if (now() - startedAt < settleMs) return false;

          const latestEvent = verifyingGesture.latestEvent;
          const latestTouch = verifyingGesture.latestTouch;
          if (latestEvent === null || latestTouch === null) return true;
          verifyingGesture.mode = "hijack-wheel";
          verifyingGesture.verifyConsumed = null;
          latestEvent.preventDefault();
          forwardWheel(
            verifyingGesture,
            latestTouch,
            latestEvent,
            -(latestTouch.clientX - verifyingGesture.startX),
            -(latestTouch.clientY - verifyingGesture.startY),
          );
          verifyingGesture.lastX = latestTouch.clientX;
          verifyingGesture.lastY = latestTouch.clientY;
          return true;
        };
        const verifyAfterEvent = () => {
          if (!verifyConsumed()) afterEvent(verifyAfterEvent);
        };
        verifyingGesture.verifyConsumed = () => {
          verifyConsumed();
        };
        afterEvent(verifyAfterEvent);
        return;
      }
      gesture.mode = "hijack-wheel";
    }

    if (gesture.mode === "drag") {
      event.preventDefault();
      dragPointer(gesture, touch, event, "move", 1);
      return;
    }

    if (gesture.mode === "scroll-pan") {
      gesture.latestEvent = event;
      gesture.latestTouch = touch;
      gesture.verifyConsumed?.();
      return;
    }

    event.preventDefault();
    forwardWheel(
      gesture,
      touch,
      event,
      -(touch.clientX - gesture.lastX),
      -(touch.clientY - gesture.lastY),
    );
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
  };

  const clearGesture = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    const current = gesture;
    const touch = event.changedTouches[0];
    if (current?.mode === "drag") {
      // No click follows a drag.
      event.preventDefault();
      dragPointer(
        current,
        touch ?? { clientX: current.lastX, clientY: current.lastY },
        event,
        "up",
        0,
      );
    } else if (
      current?.mode === "pending" &&
      touch !== undefined &&
      Math.hypot(touch.clientX - current.startX, touch.clientY - current.startY) <= TOUCH_SLOP_PX
    ) {
      options.mouseFilter?.touch(touch);
      forwardTap(current, touch, event);
    }
    gesture = null;
  };
  const cancelGesture = (event: TouchEvent) => {
    if (!event.isTrusted) return;
    if (event.changedTouches[0]) options.mouseFilter?.touch(event.changedTouches[0]);
    releaseDrag(event);
    gesture = null;
  };

  const listenerOptions = { capture: true, passive: false } as const;
  options.doc.addEventListener("touchstart", onTouchStart, listenerOptions);
  options.doc.addEventListener("touchmove", onTouchMove, listenerOptions);
  options.doc.addEventListener("touchend", clearGesture, listenerOptions);
  options.doc.addEventListener("touchcancel", cancelGesture, listenerOptions);
  return () => {
    active = false;
    gesture = null;
    options.doc.removeEventListener("touchstart", onTouchStart, true);
    options.doc.removeEventListener("touchmove", onTouchMove, true);
    options.doc.removeEventListener("touchend", clearGesture, true);
    options.doc.removeEventListener("touchcancel", cancelGesture, true);
  };
}

function scrollPosition(target: Element | Window, doc: Document): { x: number; y: number } {
  if (target === doc.defaultView) {
    const view = target as Window;
    return { x: view.scrollX, y: view.scrollY };
  }
  const element = target as Element;
  return { x: element.scrollLeft, y: element.scrollTop };
}
