/**
 * Keeps the viewer's keyboard focus on the field the remote page is typing into.
 *
 * Page mode forwards a key pressed outside any mirror field as a raw key, which the remote browser
 * delivers to whatever it has focused. The two sides drift whenever the remote page moves focus by
 * itself (autofocus, focus returning to a composer after sending), and then the local IME never
 * engages: with nothing editable focused here, pinyin keys go out as Latin letters.
 *
 * The agent reports the remote focus (REMOTE_FOCUS_EVENT). On a desktop, while the mirror has
 * focus and the person is not busy with something local, the matching mirror field is focused;
 * when the mirror has no such node (a field it does not show), a hidden textarea takes the keys
 * and the IME, and sends committed text. Touch devices are only followed when a key arrives:
 * focusing a field there would pop up the soft keyboard unasked.
 *
 * Either way, someone typing whose field the page took away (a chat composer mounted anew after
 * sending) is followed to the field the page focuses instead, at once: their keyboard was open
 * already, and what they type next must not go nowhere. When the page put a field just like it in
 * its place in the same change, focus goes there before anything else can happen: a phone's soft
 * keyboard, which closes once nothing is focused, stays open, and no key lands on the page body
 * while the remote focus report is on its way.
 */
import { editableText, type RemoteFocus } from "@mirror/protocol";
import { deepActiveElement, isTextEditable } from "./keys";
import { isElement } from "./pointer";

export interface HiddenKeyboard {
  focus(point?: { clientX: number; clientY: number }): void;
  hasFocus(): boolean;
  blur(): void;
}

export interface FocusFollowOptions {
  rootDoc: Document;
  getNode(id: number): Node | null;
  /** Created on first use, in the document around the replay. */
  hiddenKeyboard(): HiddenKeyboard | null;
  /** Desktop only: focus follows the remote page by itself. */
  followsByItself: boolean;
  /** Puts focus back into the mirror once the remote page has no field focused. */
  focusMirror(): void;
  now?(): number;
}

/** Typing this recently, in a field the page then removed, is typing that goes on. */
export const STRANDED_TYPING_MS = 5_000;

export interface FocusFollower {
  remoteFocus(focus: RemoteFocus): void;
  /** Install the local-activity watchers in one replay document; returns their cleanup. */
  watch(doc: Document): () => void;
  /**
   * For a key pressed outside any mirror field: when the remote page has a field focused, move
   * focus there (or to the hidden textarea) so that this key and the IME land in it. True when
   * the key must not also go out as a raw key.
   */
  routeTyping(event: KeyboardEvent): boolean;
  current(): RemoteFocus | null;
}

/** Desktop: a fine pointer and no touch-first browser. Mirrors the phone checks in app.tsx. */
export function followsFocusByItself(view: Window | null): boolean {
  if (view === null) return false;
  if (/\bMobi|Android|iPhone|iPad/.test(view.navigator?.userAgent ?? "")) return false;
  try {
    if (view.matchMedia?.("(pointer: coarse)").matches) return false;
  } catch {
    // An old browser without media queries is a desktop one.
  }
  return true;
}

/** A printable key a field would insert, or the IME's placeholder; never a shortcut. */
export function typesText(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === "Process" || event.keyCode === 229) return true;
  return [...event.key].length === 1;
}

export function createFocusFollower(options: FocusFollowOptions): FocusFollower {
  let remote: RemoteFocus | null = null;
  let composing = false;
  let pointerHeld = false;
  let typedAt = Number.NEGATIVE_INFINITY;
  const now = options.now ?? Date.now;
  const docs = new Set<Document>();

  const mirrorField = (focus: RemoteFocus): Element | null => {
    if (focus.id < 0) return null;
    const node = options.getNode(focus.id);
    return isElement(node) && node.isConnected && isTextEditable(node) ? node : null;
  };
  const hiddenHasFocus = () => options.hiddenKeyboard()?.hasFocus() === true;
  /** Someone selecting text here to copy it would lose the selection to a focus change. */
  const selectingLocally = () => {
    for (const doc of docs) {
      const selection = doc.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) continue;
      const anchor = selection.anchorNode;
      const owner = anchor?.nodeType === 1 ? (anchor as Element) : anchor?.parentElement;
      if (!owner || !isTextEditable(owner.closest?.("input,textarea,[contenteditable]") ?? null))
        return true;
    }
    return false;
  };
  const busy = () => composing || pointerHeld || selectingLocally();
  /** Typing a moment ago, and no field here has focus any more: the page took it away. */
  const stranded = () => {
    if (now() - typedAt > STRANDED_TYPING_MS || pointerHeld) return false;
    if (hiddenHasFocus()) return false;
    const active = deepActiveElement(options.rootDoc);
    return active === null || !isTextEditable(active);
  };

  /** The one field in `doc` that stands where `gone` stood: same kind, id and labels. */
  const replacementOf = (gone: Element, doc: Document): HTMLElement | null => {
    const same = (name: string, field: Element) =>
      field.getAttribute(name) === gone.getAttribute(name);
    let found: HTMLElement | null = null;
    for (const field of doc.querySelectorAll?.("input, textarea, [contenteditable]") ?? []) {
      if (field === gone || !field.isConnected || !isTextEditable(field)) continue;
      // The editing host, not an element inside it.
      if ((field.parentElement as HTMLElement | null)?.isContentEditable === true) continue;
      if (
        field.tagName !== gone.tagName ||
        !["id", "role", "aria-label", "placeholder", "data-placeholder"].every((name) =>
          same(name, field),
        )
      )
        continue;
      if (found !== null) return null;
      found = field as HTMLElement;
    }
    return found;
  };
  /** Each field's text when Enter was last pressed in it: what a page that sends on Enter sent. */
  const textAtEnter = new WeakMap<Element, string>();
  const textOf = (field: Element) =>
    (field as HTMLElement).isContentEditable
      ? editableText(field as HTMLElement)
      : ((field as HTMLInputElement).value ?? "");
  /** The focused field was just removed while someone typed in it: take the one put in its place. */
  const replaceRemoved = (gone: Element, doc: Document) => {
    if (gone.isConnected || now() - typedAt > STRANDED_TYPING_MS || pointerHeld) return;
    if (hiddenHasFocus()) return;
    const active = deepActiveElement(options.rootDoc);
    if (active !== null && isTextEditable(active)) return;
    const field = replacementOf(gone, doc);
    if (field === null) return;
    field.focus({ preventScroll: true });
    if (field.isContentEditable) {
      const selection = doc.getSelection?.();
      selection?.selectAllChildren(field);
      selection?.collapseToEnd();
    }
    // Keys typed after sending, before the page's new field reached this replay, went into the
    // old one, and the gateway typed them into the page's new field. They go on in this one too,
    // or its next edit would send its text without them and take them off the page again.
    const sent = textAtEnter.get(gone);
    if (sent === undefined || textOf(field).trim() !== "") return;
    const typedSince = textOf(gone);
    if (!typedSince.startsWith(sent)) return;
    const carried = typedSince.slice(sent.length);
    if (carried !== "") doc.execCommand?.("insertText", false, carried);
  };

  const moveTo = (focus: RemoteFocus): boolean => {
    const field = mirrorField(focus);
    if (field !== null) {
      if (deepActiveElement(options.rootDoc) !== field) {
        (field as HTMLElement).focus({ preventScroll: true });
        // An editing host takes focus with its caret at the start; typing continues at the end.
        if ((field as HTMLElement).isContentEditable) {
          const selection = field.ownerDocument.getSelection?.();
          selection?.selectAllChildren(field);
          selection?.collapseToEnd();
        }
      }
      return true;
    }
    const hidden = options.hiddenKeyboard();
    if (hidden === null) return false;
    if (!hidden.hasFocus()) hidden.focus();
    return true;
  };

  return {
    current: () => remote,
    remoteFocus(focus) {
      remote = focus;
      const ours = options.rootDoc.hasFocus() || hiddenHasFocus();
      if (!focus.editable) {
        // Letters typed into the hidden textarea now would become text the page has nowhere to
        // put, and its single-key shortcuts would stop working.
        if (hiddenHasFocus()) {
          options.hiddenKeyboard()?.blur();
          options.focusMirror();
        }
        return;
      }
      if (stranded()) {
        // Only to a field the mirror shows: a phone must not get a hidden one instead.
        if (mirrorField(focus) !== null || options.followsByItself) moveTo(focus);
        return;
      }
      if (!options.followsByItself || !ours || busy()) return;
      moveTo(focus);
    },
    routeTyping(event) {
      if (remote === null || !remote.editable || !typesText(event) || composing) return false;
      if (isElement(event.target) && isTextEditable(event.target)) return false;
      return moveTo(remote);
    },
    watch(doc) {
      docs.add(doc);
      const start = () => (composing = true);
      const end = () => (composing = false);
      // A press elsewhere is where the person went: no longer typing.
      const down = () => {
        pointerHeld = true;
        typedAt = Number.NEGATIVE_INFINITY;
      };
      const up = () => (pointerHeld = false);
      // A release outside this document never reaches it; a move without a button tells.
      const move = (event: PointerEvent) => {
        if (event.buttons === 0) pointerHeld = false;
      };
      const typed = (event: Event) => {
        const target = event.target;
        if (!isElement(target) || !isTextEditable(target)) return;
        typedAt = now();
        const key = event as KeyboardEvent;
        if (key.type !== "keydown" || key.key !== "Enter" || key.shiftKey || key.isComposing)
          return;
        let host: Element = target;
        while ((host.parentElement as HTMLElement | null)?.isContentEditable === true)
          host = host.parentElement!;
        textAtEnter.set(host, textOf(host));
      };
      // A removed field blurs while the replay applies the page's change; what the change adds
      // in its place is there once that change is applied, which is before the next task.
      const lost = (event: FocusEvent) => {
        const target = event.target;
        if (!isElement(target) || !isTextEditable(target) || event.relatedTarget !== null) return;
        queueMicrotask(() => replaceRemoved(target, doc));
      };
      doc.addEventListener("compositionstart", start, true);
      doc.addEventListener("compositionend", end, true);
      doc.addEventListener("pointerdown", down, true);
      doc.addEventListener("pointerup", up, true);
      doc.addEventListener("pointercancel", up, true);
      doc.addEventListener("pointermove", move, true);
      doc.addEventListener("keydown", typed, true);
      doc.addEventListener("beforeinput", typed, true);
      doc.addEventListener("focusout", lost, true);
      return () => {
        docs.delete(doc);
        doc.removeEventListener("compositionstart", start, true);
        doc.removeEventListener("compositionend", end, true);
        doc.removeEventListener("pointerdown", down, true);
        doc.removeEventListener("pointerup", up, true);
        doc.removeEventListener("pointercancel", up, true);
        doc.removeEventListener("pointermove", move, true);
        doc.removeEventListener("keydown", typed, true);
        doc.removeEventListener("beforeinput", typed, true);
        doc.removeEventListener("focusout", lost, true);
      };
    },
  };
}
