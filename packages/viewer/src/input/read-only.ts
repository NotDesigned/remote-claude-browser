/**
 * Single-writer input keeps the replay's text fields read-only, without rewriting their
 * `readonly` or `contenteditable` (which changes how a page's CSS draws them).
 *
 * A press on a text field still goes to the page (pointer.ts forwards it), which places its own
 * caret; here its default is prevented, so the replay field never takes focus, and the proxy is
 * focused in the same gesture so that a phone opens its keyboard. Mouse focus happens on
 * `mousedown` and a tap's focus on the compatibility mouse events after `touchend`, so those are
 * the events that matter; a field that takes focus anyway gives it to the proxy at once, and
 * nothing a field would do with text (beforeinput, drop, cut) happens here.
 *
 * With the field never focused here, nothing draws its caret or selection either: each press,
 * drag and release in it (and each tap) is handed to the proxy, which shows the caret or the
 * selection it makes at once (a double press a word, a triple one a line, Shift a longer
 * selection) until the page's answer says where they are.
 */
import { isElement } from "./pointer";
import { isTextEditable } from "./keys";
import type { ProxyPointer } from "./proxy-input";

export interface ReadOnlyOptions {
  doc: Document;
  /** Proxy mode is on now (caps, driver, override). */
  active(): boolean;
  /** Before focusing the proxy for a press: commit what it composes. */
  flush(): void;
  focus(point?: { clientX: number; clientY: number }): void;
  /** The field pressed, before the proxy is focused for it. */
  pressed?(field: Element): void;
  /** A click anywhere but a text field (a send button, say). */
  clickedElsewhere?(): void;
  /** A press, drag or release in a text field, or a tap on one (in `doc`'s coordinates). */
  pointer?(field: Element, press: ProxyPointer): void;
  /** Maps a point in `doc` to the viewer document (the replay may be scaled or nested). */
  toViewer?(point: { clientX: number; clientY: number }): { clientX: number; clientY: number };
}

/** A tap moves less than this, in CSS pixels, and lasts less than TAP_MS. */
const TAP_SLOP = 10;
const TAP_MS = 500;

/** The text field or editing host an event is about, if any. */
export function textFieldOf(target: EventTarget | null): Element | null {
  if (!isElement(target)) return null;
  const field = target.closest?.("input, textarea, [contenteditable]") ?? null;
  if (field !== null && isTextEditable(field)) return field;
  return isTextEditable(target) ? target : null;
}

/** A mouse event a touch made (its tap is handled at touchend). */
function isTouchMouse(event: MouseEvent): boolean {
  const source = (
    event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null }
  ).sourceCapabilities;
  return source?.firesTouchEvents === true;
}

export function attachReadOnly(options: ReadOnlyOptions): () => void {
  const { doc } = options;
  const point = (event: MouseEvent | Touch) => {
    const local = { clientX: event.clientX, clientY: event.clientY };
    return options.toViewer?.(local) ?? local;
  };
  /** The field a mouse press went down in, while its button is held. */
  let dragging: Element | null = null;
  const press = (event: MouseEvent, phase: ProxyPointer["phase"]): ProxyPointer => ({
    phase,
    clientX: event.clientX,
    clientY: event.clientY,
    detail: event.detail,
    shift: event.shiftKey,
  });
  const onMouseDown = (event: MouseEvent) => {
    if (!event.isTrusted || !options.active() || event.button !== 0) return;
    const field = textFieldOf(event.target);
    if (field === null) return;
    event.preventDefault();
    options.flush();
    options.pressed?.(field);
    options.focus(point(event));
    if (isTouchMouse(event)) return; // a tap: placed at touchend
    dragging = field;
    options.pointer?.(field, press(event, "down"));
  };
  const onMouseMove = (event: MouseEvent) => {
    if (dragging === null || !event.isTrusted) return;
    if ((event.buttons & 1) === 0 || !options.active()) {
      dragging = null;
      return;
    }
    options.pointer?.(dragging, press(event, "move"));
  };
  const onMouseUp = (event: MouseEvent) => {
    if (dragging === null || !event.isTrusted || event.button !== 0) return;
    const field = dragging;
    dragging = null;
    if (options.active()) options.pointer?.(field, press(event, "up"));
  };
  let touchStart: { x: number; y: number; at: number } | null = null;
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    touchStart =
      event.touches.length === 1 && touch !== undefined
        ? { x: touch.clientX, y: touch.clientY, at: event.timeStamp }
        : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (!event.isTrusted || !options.active()) return;
    const field = textFieldOf(event.target);
    if (field === null) return;
    const touch = event.changedTouches[0];
    options.flush();
    options.pressed?.(field);
    options.focus(touch === undefined ? undefined : point(touch));
    const start = touchStart;
    touchStart = null;
    // A tap places the caret; a long press or a drag is the page's to answer.
    if (
      touch !== undefined &&
      start !== null &&
      Math.hypot(touch.clientX - start.x, touch.clientY - start.y) < TAP_SLOP &&
      event.timeStamp - start.at < TAP_MS
    ) {
      const tap = { clientX: touch.clientX, clientY: touch.clientY, detail: 1, shift: false };
      options.pointer?.(field, { ...tap, phase: "down" });
      options.pointer?.(field, { ...tap, phase: "up" });
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (!options.active()) return;
    const field = textFieldOf(event.target);
    if (field === null) return;
    (field as HTMLElement).blur?.();
    options.focus();
  };
  const prevent = (event: Event) => {
    if (!options.active() || textFieldOf(event.target) === null) return;
    event.preventDefault();
  };
  doc.addEventListener("mousedown", onMouseDown, true);
  doc.addEventListener("mousemove", onMouseMove, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("beforeinput", prevent, true);
  doc.addEventListener("drop", prevent, true);
  doc.addEventListener("cut", prevent, true);
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted || !options.active() || textFieldOf(event.target) !== null) return;
    options.clickedElsewhere?.();
  };
  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("mousemove", onMouseMove, true);
    doc.removeEventListener("mouseup", onMouseUp, true);
    doc.removeEventListener("touchstart", onTouchStart, true);
    doc.removeEventListener("touchend", onTouchEnd, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("beforeinput", prevent, true);
    doc.removeEventListener("drop", prevent, true);
    doc.removeEventListener("cut", prevent, true);
    doc.removeEventListener("click", onClick, true);
  };
}
