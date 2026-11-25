/**
 * Reports which element has focus in this document (see REMOTE_FOCUS_EVENT).
 *
 * Without it the viewer could only guess: a page's autofocus, or focus returning to a composer
 * after sending, left the viewer's focus somewhere else, so keys went out raw and the viewer's IME
 * never engaged. Same-origin frames are covered by the recorder of the document above them, which
 * looks through them; a cross-origin frame has its own recorder and reports for itself.
 */
import { REMOTE_FOCUS_EVENT, type RemoteFocus } from "@mirror/protocol";

export interface FocusReportOptions {
  window: Window;
  /** The recorder's node id, or a negative number for an unrecorded node. */
  getId(node: Node): number;
  emit(tag: string, focus: RemoteFocus): void;
  /** The top document. A cross-origin frame reports only while it holds focus. */
  isTop: boolean;
  debounceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function describeFocus(element: Element | null): Omit<RemoteFocus, "id"> {
  if (element === null) return { editable: false };
  const tag = element.tagName.toLowerCase();
  if (tag === "input") {
    const input = element as HTMLInputElement;
    const type = (input.type || "text").toLowerCase();
    const editable = !input.disabled && !input.readOnly && !NON_TEXT_INPUT_TYPES.has(type);
    return type === "password" ? { editable, password: true } : { editable };
  }
  if (tag === "textarea") {
    const textarea = element as HTMLTextAreaElement;
    return { editable: !textarea.disabled && !textarea.readOnly };
  }
  return { editable: (element as HTMLElement).isContentEditable === true };
}

/** The focused element, looking into same-origin frames; a cross-origin frame stays the iframe. */
export function deepFocusedElement(document: Document): Element | null {
  let current = document;
  let active: Element | null = null;
  for (let depth = 0; depth < 16; depth++) {
    active = current.activeElement;
    if (active === null || active.tagName.toLowerCase() !== "iframe") return active;
    let child: Document | null = null;
    try {
      child = (active as HTMLIFrameElement).contentDocument;
    } catch {
      child = null;
    }
    if (child === null) return active;
    current = child;
  }
  return active;
}

export function startFocusReport(options: FocusReportOptions) {
  const debounceMs = options.debounceMs ?? 50;
  const schedule = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.clearTimer ?? ((timer) => clearTimeout(timer as number));
  const document = options.window.document;
  let timer: unknown = null;
  let last: string | null = null;
  const watched = new WeakSet<Document>();

  const report = () => {
    timer = null;
    // A cross-origin frame speaks only while focus is inside it; above it, the parent speaks.
    if (!options.isTop && !document.hasFocus()) return;
    const active = deepFocusedElement(document);
    // Focus inside a cross-origin frame: that frame's recorder reports it with its own ids.
    if (active !== null && active.tagName.toLowerCase() === "iframe") return;
    const element = active ?? document.body;
    const id = element === null ? -1 : options.getId(element);
    // A frame's ids are translated on the way up; an unrecorded node has nothing to translate.
    if (id < 0 && !options.isTop) return;
    const focus: RemoteFocus = { id: id < 0 ? -1 : id, ...describeFocus(active) };
    const key = `${focus.id}:${focus.editable}:${focus.password === true}`;
    if (key === last) return;
    last = key;
    options.emit(REMOTE_FOCUS_EVENT, focus);
  };

  const changed = () => {
    watchFrames();
    if (timer !== null) cancel(timer);
    timer = schedule(report, debounceMs);
  };

  /** Focus moving inside a same-origin frame raises events only in that frame's document. */
  const watch = (doc: Document) => {
    if (watched.has(doc)) return;
    watched.add(doc);
    doc.addEventListener("focusin", changed, true);
    doc.addEventListener("focusout", changed, true);
  };
  const watchFrames = () => {
    let current: Document = document;
    for (let depth = 0; depth < 16; depth++) {
      const active = current.activeElement;
      if (active === null || active.tagName.toLowerCase() !== "iframe") return;
      let child: Document | null = null;
      try {
        child = (active as HTMLIFrameElement).contentDocument;
      } catch {
        return;
      }
      if (child === null) return;
      watch(child);
      current = child;
    }
  };

  watch(document);
  options.window.addEventListener("focus", changed, true);
  options.window.addEventListener("blur", changed, true);

  return {
    /** A new full snapshot rebuilds the replay, which then needs to hear the focus again. */
    snapshotTaken() {
      last = null;
      changed();
    },
    dispose() {
      if (timer !== null) cancel(timer);
      document.removeEventListener("focusin", changed, true);
      document.removeEventListener("focusout", changed, true);
      options.window.removeEventListener("focus", changed, true);
      options.window.removeEventListener("blur", changed, true);
    },
  };
}
