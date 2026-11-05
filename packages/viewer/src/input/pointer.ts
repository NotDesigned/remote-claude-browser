/**
 * Pointer capture and forwarding.
 *
 * Listeners attach DIRECTLY inside the replayer iframe's document (same origin, we control it)
 * — never a transparent overlay (kills native selection). On pointer events resolve the target's
 * rrweb id via replayer.getMirror().getId(el) + its rect; send node-relative rx/ry in [0,1] plus
 * vx/vy viewport-px fallback. getId returns -1 for nodes rrweb didn't serialize — walk up to the
 * nearest serialized ancestor. mousemove throttled 30Hz leading+trailing (hover menus need it).
 * Re-attach after every resync rebuild (the iframe is new). Selection/copy/Ctrl-F stay local.
 */
import { Mod, type TabId, type Up } from "@mirror/protocol";

export type SendInput = (message: Up) => void;

export interface TouchMouseFilter {
  touch(point: Pick<Touch, "clientX" | "clientY"> & { target?: EventTarget | null }): void;
  ignore(event: MouseEvent): boolean;
}

/** Allow native tap focus while forwarding only one remote click per touch gesture. */
export function createTouchMouseFilter(now: () => number = Date.now): TouchMouseFilter {
  let lastTouch: { x: number; y: number; at: number; target: EventTarget | null } | null = null;
  return {
    touch(point) {
      lastTouch = { x: point.clientX, y: point.clientY, at: now(), target: point.target ?? null };
    },
    ignore(event) {
      const source = (
        event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null }
      ).sourceCapabilities;
      if (source) return source.firesTouchEvents;
      return (
        lastTouch !== null &&
        now() - lastTouch.at < 800 &&
        ((lastTouch.target !== null && event.target === lastTouch.target) ||
          Math.hypot(event.clientX - lastTouch.x, event.clientY - lastTouch.y) <= 4)
      );
    },
  };
}

export interface PointerCaptureOptions {
  doc: Document;
  /** Top replay document; viewport fallbacks must not include viewer chrome outside this root. */
  rootDoc?: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  beforePointerDown?(): void;
  /** A link this press belongs to is opened here, so the remote page must not be clicked. */
  opensLocally?(event: MouseEvent): boolean;
  ignoreMouse?(event: MouseEvent): boolean;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface ResolvedPointerTarget {
  nodeId: number;
  element: Element;
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">;
}

export function eventMods(
  event: Pick<MouseEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): number {
  return (
    (event.altKey ? Mod.Alt : 0) |
    (event.ctrlKey ? Mod.Ctrl : 0) |
    (event.metaKey ? Mod.Meta : 0) |
    (event.shiftKey ? Mod.Shift : 0)
  );
}

export function resolvePointerTarget(
  target: EventTarget | null,
  getNodeId: (node: Node) => number,
): ResolvedPointerTarget | null {
  let element = isElement(target) ? target : null;
  while (element !== null) {
    const nodeId = getNodeId(element);
    if (nodeId >= 0) return { nodeId, element, rect: element.getBoundingClientRect() };
    element = element.parentElement;
  }
  return null;
}

const CLICK_CONTROL = "button,a[href],summary,[role='button'],[role='menuitem'],[role='tab']";

/**
 * The gateway finds a pointer's place from where its target is in the remote page right now. What is
 * inside a control can be mid-animation there (Claude's "scroll to bottom" button pulses a dot while
 * generating), which sends the click outside the control, while the control itself stays put.
 */
export function resolveClickTarget(
  target: EventTarget | null,
  getNodeId: (node: Node) => number,
): ResolvedPointerTarget | null {
  const control = isElement(target) ? target.closest(CLICK_CONTROL) : null;
  return resolvePointerTarget(
    control !== null && getNodeId(control) >= 0 ? control : target,
    getNodeId,
  );
}

/** DOM nodes come from the iframe realm, so parent-realm `instanceof Element` is incorrect. */
export function isElement(target: EventTarget | null): target is Element {
  return target !== null && typeof target === "object" && (target as Node).nodeType === 1;
}

export function pointerPosition(
  event: Pick<MouseEvent, "clientX" | "clientY">,
  target: ResolvedPointerTarget | null,
  doc?: Document,
  rootDoc: Document | undefined = doc,
): Pick<Extract<Up, { t: "ptr" }>, "nodeId" | "rx" | "ry" | "vx" | "vy"> {
  const rect = target?.rect;
  const viewport =
    doc === undefined || rootDoc === undefined
      ? event
      : toRootViewport(event.clientX, event.clientY, doc, rootDoc);
  return {
    nodeId: target?.nodeId ?? -1,
    rx:
      rect === undefined || rect.width <= 0
        ? 0.5
        : clamp01((event.clientX - rect.left) / rect.width),
    ry:
      rect === undefined || rect.height <= 0
        ? 0.5
        : clamp01((event.clientY - rect.top) / rect.height),
    vx: viewport.clientX,
    vy: viewport.clientY,
  };
}

/** Compose coordinates from a same-origin child viewport into the replay root viewport. */
export function toRootViewport(
  clientX: number,
  clientY: number,
  doc: Document,
  rootDoc: Document = doc,
): { clientX: number; clientY: number } {
  let current = doc;
  const visited = new Set<Document>();
  while (current !== rootDoc && !visited.has(current)) {
    visited.add(current);
    let frame: Element | null;
    try {
      frame = current.defaultView?.frameElement ?? null;
    } catch {
      break;
    }
    if (frame === null) break;
    const rect = frame.getBoundingClientRect();
    const layoutFrame = frame as HTMLElement;
    // getBoundingClientRect is in the painted parent space; client/offset metrics are in the
    // frame's layout space. Apply their ratio for author transform/zoom on nested frames.
    const scaleX = layoutFrame.offsetWidth > 0 ? rect.width / layoutFrame.offsetWidth : 1;
    const scaleY = layoutFrame.offsetHeight > 0 ? rect.height / layoutFrame.offsetHeight : 1;
    clientX = rect.left + (clientX + frame.clientLeft) * scaleX;
    clientY = rect.top + (clientY + frame.clientTop) * scaleY;
    current = frame.ownerDocument;
  }
  return { clientX, clientY };
}

export function attachPointerCapture(options: PointerCaptureOptions): () => void {
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let lastMoveAt = Number.NEGATIVE_INFINITY;
  let trailingMove: MouseEvent | null = null;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  let localPress = false;

  const sendPointer = (event: MouseEvent, kind: "move" | "down" | "up") => {
    const target = resolveClickTarget(event.target, options.getNodeId);
    options.send({
      t: "ptr",
      tab: options.tab,
      kind,
      ...pointerPosition(event, target, options.doc, options.rootDoc),
      button: mouseButton(event.button),
      buttons: event.buttons,
      mods: eventMods(event),
      clicks: event.detail >= 2 ? 2 : 1,
    });
  };

  const flushMove = () => {
    trailingTimer = null;
    const event = trailingMove;
    trailingMove = null;
    if (event === null) return;
    lastMoveAt = now();
    sendPointer(event, "move");
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!event.isTrusted || options.ignoreMouse?.(event)) return;
    const elapsed = now() - lastMoveAt;
    if (elapsed >= 33) {
      if (trailingTimer !== null) cancel(trailingTimer);
      trailingTimer = null;
      trailingMove = null;
      lastMoveAt = now();
      sendPointer(event, "move");
      return;
    }
    trailingMove = event;
    if (trailingTimer === null) trailingTimer = schedule(flushMove, Math.max(0, 33 - elapsed));
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.isTrusted && !options.ignoreMouse?.(event)) {
      localPress = options.opensLocally?.(event) === true;
      if (localPress) return;
      options.beforePointerDown?.();
      if (trailingTimer !== null) cancel(trailingTimer);
      if (trailingMove !== null) flushMove();
      sendPointer(event, "down");
    }
  };
  const onMouseUp = (event: MouseEvent) => {
    if (!event.isTrusted || options.ignoreMouse?.(event)) return;
    if (localPress) localPress = false;
    else sendPointer(event, "up");
  };
  const onContextMenu = (event: MouseEvent) => {
    if (event.isTrusted) event.preventDefault();
  };

  options.doc.addEventListener("mousemove", onMouseMove, true);
  options.doc.addEventListener("mousedown", onMouseDown, true);
  options.doc.addEventListener("mouseup", onMouseUp, true);
  options.doc.addEventListener("contextmenu", onContextMenu, true);
  return () => {
    options.doc.removeEventListener("mousemove", onMouseMove, true);
    options.doc.removeEventListener("mousedown", onMouseDown, true);
    options.doc.removeEventListener("mouseup", onMouseUp, true);
    options.doc.removeEventListener("contextmenu", onContextMenu, true);
    if (trailingTimer !== null) cancel(trailingTimer);
  };
}

function mouseButton(button: number): 0 | 1 | 2 | undefined {
  return button === 0 || button === 1 || button === 2 ? button : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
