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
 */
import { isElement } from "./pointer";
import { isTextEditable } from "./keys";

export interface ReadOnlyOptions {
  doc: Document;
  /** Proxy mode is on now (caps, driver, override). */
  active(): boolean;
  /** Before focusing the proxy for a press: commit what it composes. */
  flush(): void;
  focus(point?: { clientX: number; clientY: number }): void;
  /** The field pressed, before the proxy is focused for it. */
  pressed?(field: Element): void;
  /** Maps a point in `doc` to the viewer document (the replay may be scaled or nested). */
  toViewer?(point: { clientX: number; clientY: number }): { clientX: number; clientY: number };
}

/** The text field or editing host an event is about, if any. */
export function textFieldOf(target: EventTarget | null): Element | null {
  if (!isElement(target)) return null;
  const field = target.closest?.("input, textarea, [contenteditable]") ?? null;
  if (field !== null && isTextEditable(field)) return field;
  return isTextEditable(target) ? target : null;
}

export function attachReadOnly(options: ReadOnlyOptions): () => void {
  const { doc } = options;
  const point = (event: MouseEvent | Touch) => {
    const local = { clientX: event.clientX, clientY: event.clientY };
    return options.toViewer?.(local) ?? local;
  };
  const onMouseDown = (event: MouseEvent) => {
    if (!event.isTrusted || !options.active() || event.button !== 0) return;
    const field = textFieldOf(event.target);
    if (field === null) return;
    event.preventDefault();
    options.flush();
    options.pressed?.(field);
    options.focus(point(event));
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (!event.isTrusted || !options.active()) return;
    const field = textFieldOf(event.target);
    if (field === null) return;
    const touch = event.changedTouches[0];
    options.flush();
    options.pressed?.(field);
    options.focus(touch === undefined ? undefined : point(touch));
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
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("beforeinput", prevent, true);
  doc.addEventListener("drop", prevent, true);
  doc.addEventListener("cut", prevent, true);
  return () => {
    doc.removeEventListener("mousedown", onMouseDown, true);
    doc.removeEventListener("touchend", onTouchEnd, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("beforeinput", prevent, true);
    doc.removeEventListener("drop", prevent, true);
    doc.removeEventListener("cut", prevent, true);
  };
}
