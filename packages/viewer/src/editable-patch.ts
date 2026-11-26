/**
 * Brings one editing host of the live replay back in step with the page, in place.
 *
 * A contenteditable that the person types into is edited natively in the replay, and the page's own
 * changes to it are held back while they type (pipeline/echo.ts). When the two have gone apart (a
 * rich editor such as ProseMirror rewrote what was typed, or cleared itself after sending) the
 * replay used to be rebuilt whole from a snapshot: a new iframe, so the focused editor, its caret,
 * the keys typed meanwhile and a phone's soft keyboard all went with it.
 *
 * Instead the snapshot (with the deltas it carries) is cast into a hidden Replayer, and only the
 * editor's children are carried over into the live replay, with their rrweb ids, so that what the
 * page changes in them next applies. The editor element itself stays, and with it focus and the
 * keyboard; the caret is put back at the same distance from the end of the text, where typing goes
 * on. Anything this cannot do (no such editor in the snapshot, a different element by that id)
 * returns false, and the caller rebuilds the replay as before.
 */
import { Replayer } from "@rrweb/replay";
import { EventType, MIRROR_RECORD_CLASSES, type eventWithTime } from "@mirror/protocol";

type ReplayMirror = ReturnType<Replayer["getMirror"]>;

export interface EditablePatchOptions {
  /** The live replay that keeps the editor. */
  replayer: Pick<Replayer, "getMirror">;
  /** The editing host's rrweb id. */
  nodeId: number;
  /** A snapshot's events: Meta, FullSnapshot and the deltas after it. */
  events: readonly eventWithTime[];
  /** Where the hidden replay is built for the moment it takes. */
  host: HTMLElement;
}

/** Text offset of the caret, counted from the end of the editor's text; null when not inside. */
function caretFromEnd(editor: HTMLElement): number | null {
  const selection = editor.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.focusNode === null) return null;
  if (!editor.contains(selection.focusNode)) return null;
  try {
    const rest = editor.ownerDocument.createRange();
    rest.setStart(selection.focusNode, selection.focusOffset);
    rest.setEnd(editor, editor.childNodes.length);
    return rest.toString().length;
  } catch {
    return null;
  }
}

/** Puts a collapsed caret `fromEnd` characters before the end of the editor's text. */
function placeCaret(editor: HTMLElement, fromEnd: number): void {
  const document = editor.ownerDocument;
  const selection = document.getSelection();
  if (selection === null) return;
  const texts: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    texts.push(node as Text);
  let remaining = fromEnd;
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = texts[index]!;
    if (remaining <= text.data.length) {
      selection.setBaseAndExtent(
        text,
        text.data.length - remaining,
        text,
        text.data.length - remaining,
      );
      return;
    }
    remaining -= text.data.length;
  }
  // The caret was before all of the text the editor now has: its start.
  if (texts.length > 0) {
    selection.setBaseAndExtent(texts[0]!, 0, texts[0]!, 0);
    return;
  }
  // No text (an emptied editor): the start of its first block, where the browser would type.
  let first: Node = editor;
  while (
    first.firstChild !== null &&
    first.firstChild.nodeType === Node.ELEMENT_NODE &&
    first.firstChild.nodeName !== "BR"
  )
    first = first.firstChild;
  selection.setBaseAndExtent(first, 0, first, 0);
}

/** Gives each copied node the rrweb id of the node it was copied from. */
function adoptIds(copy: Node, original: Node, from: ReplayMirror, to: ReplayMirror): void {
  const meta = from.getMeta(original);
  if (meta !== null) to.add(copy, meta);
  let copied = copy.firstChild;
  let source = original.firstChild;
  while (copied !== null && source !== null) {
    adoptIds(copied, source, from, to);
    copied = copied.nextSibling;
    source = source.nextSibling;
  }
}

function sameAttributes(a: Element, b: Element): boolean {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const attribute of a.attributes)
    if (b.getAttribute(attribute.name) !== attribute.value) return false;
  return true;
}

/** True when the editor now holds what the page's editor holds. */
export function patchEditable(options: EditablePatchOptions): boolean {
  const live = options.replayer.getMirror();
  const editor = live.getNode(options.nodeId);
  if (editor === null || editor.nodeType !== Node.ELEMENT_NODE || !editor.isConnected) return false;
  const events = options.events.filter(
    (event) => event.type !== EventType.Custom && event.type !== EventType.Plugin,
  );
  if (!events.some((event) => event.type === EventType.FullSnapshot)) return false;

  const stage = options.host.ownerDocument.createElement("div");
  // Laid out like the replay (some pages build their editor from what they measure), never seen.
  stage.style.cssText =
    "position:fixed;left:-200vw;top:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none;contain:strict";
  stage.setAttribute("aria-hidden", "true");
  stage.inert = true;
  options.host.appendChild(stage);
  let hidden: Replayer | null = null;
  try {
    hidden = new Replayer(events as eventWithTime[], {
      root: stage,
      blockClass: MIRROR_RECORD_CLASSES.blockClass,
      UNSAFE_replayCanvas: false,
      mouseTail: false,
      useVirtualDom: false,
      pauseAnimation: false,
      showWarning: false,
      triggerFocus: false,
    });
    const firstTs = events[0]!.timestamp;
    const lastTs = events[events.length - 1]!.timestamp;
    hidden.play(Math.max(0, lastTs - firstTs + 1));
    hidden.pause();

    const source = hidden.getMirror().getNode(options.nodeId);
    if (source === null || source.nodeType !== Node.ELEMENT_NODE) return false;
    const target = editor as HTMLElement;
    if ((source as Element).tagName !== target.tagName) return false;

    const fromEnd = caretFromEnd(target);
    const document = target.ownerDocument;
    const copies = [...source.childNodes].map((child) => {
      const copy = document.importNode(child, true);
      adoptIds(copy, child, hidden!.getMirror(), live);
      return copy;
    });
    for (const child of [...target.childNodes]) live.removeNodeFromMap(child);
    target.replaceChildren(...copies);
    // The page's classes and attributes on the editor itself (an empty editor's placeholder).
    if (!sameAttributes(target, source as Element)) {
      for (const attribute of [...target.attributes])
        if (!(source as Element).hasAttribute(attribute.name))
          target.removeAttribute(attribute.name);
      for (const attribute of (source as Element).attributes)
        if (target.getAttribute(attribute.name) !== attribute.value)
          target.setAttribute(attribute.name, attribute.value);
    }
    if (fromEnd !== null) placeCaret(target, fromEnd);
    return true;
  } catch {
    return false;
  } finally {
    try {
      hidden?.destroy();
    } catch {
      // The stage goes below either way.
    }
    stage.remove();
  }
}
