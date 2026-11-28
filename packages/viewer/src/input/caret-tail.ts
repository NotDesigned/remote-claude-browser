/**
 * A caret kept by the text after it: how many characters of an editor's text follow the caret, and
 * a caret put back that many characters before the end. The text after the caret is what an edit
 * at the caret leaves alone, so this finds the same place after the editor's DOM changed under it
 * (a rebuilt editor, editable-patch.ts) or after the browser put the caret somewhere else.
 *
 * Chrome does the latter for text with line breaks inserted as one piece (an IME's commit, a phone
 * keyboard's clipboard: `insertText` with "\n" in it). It splits the text into paragraphs and
 * leaves the caret short of the end of what it inserted, about a character for each line, so what
 * is typed next lands some lines up. `keepCaretThroughMultilineInserts` puts it back.
 */

/**
 * How many characters of the editor's text (as Range.toString counts them) follow the caret, or
 * the end of the selection with `end`; null when it is not inside the editor.
 */
export function caretFromEnd(editor: HTMLElement, end = false): number | null {
  const selection = editor.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.focusNode === null) return null;
  let node: Node = selection.focusNode;
  let offset = selection.focusOffset;
  if (end) {
    const range = selection.getRangeAt(0);
    node = range.endContainer;
    offset = range.endOffset;
  }
  if (!editor.contains(node)) return null;
  try {
    const rest = editor.ownerDocument.createRange();
    rest.setStart(node, offset);
    rest.setEnd(editor, editor.childNodes.length);
    return rest.toString().length;
  } catch {
    return null;
  }
}

/** Puts a collapsed caret `fromEnd` characters before the end of the editor's text. */
export function placeCaretFromEnd(editor: HTMLElement, fromEnd: number): void {
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

/** The outermost editing host around an event's target, or null outside one. */
function hostOf(target: EventTarget | null): HTMLElement | null {
  const element = target as HTMLElement | null;
  if (element === null || element.nodeType !== Node.ELEMENT_NODE || !element.isContentEditable)
    return null;
  let host = element;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

const MULTILINE_INSERTS = new Set(["insertText", "insertReplacementText", "insertFromPaste"]);

function insertedText(event: InputEvent): string {
  if (event.data !== null) return event.data;
  try {
    return event.dataTransfer?.getData("text/plain") ?? "";
  } catch {
    return "";
  }
}

/**
 * After the browser inserted text with line breaks into a contenteditable of `doc`, the caret goes
 * where that text ends: as many characters before the end of the editor's text as there were after
 * the selection before. Returns the listeners' removal.
 */
export function keepCaretThroughMultilineInserts(doc: Document): () => void {
  let pending: { host: HTMLElement; fromEnd: number } | null = null;
  const onBeforeInput = (event: Event) => {
    const input = event as InputEvent;
    // The paragraphs the browser makes of the text come as their own edits of the same insert.
    if (input.inputType === "insertParagraph" || input.inputType === "insertLineBreak") return;
    pending = null;
    if (!event.isTrusted || !MULTILINE_INSERTS.has(input.inputType)) return;
    if (!/[\r\n]/.test(insertedText(input))) return;
    const host = hostOf(event.target);
    if (host === null) return;
    const fromEnd = caretFromEnd(host, true);
    if (fromEnd !== null) pending = { host, fromEnd };
  };
  const onInput = (event: Event) => {
    if (pending === null || !event.isTrusted) return;
    if (hostOf(event.target) !== pending.host) return;
    placeCaretFromEnd(pending.host, pending.fromEnd);
  };
  const onOther = () => {
    pending = null;
  };
  doc.addEventListener("beforeinput", onBeforeInput, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("keydown", onOther, true);
  doc.addEventListener("pointerdown", onOther, true);
  doc.addEventListener("compositionstart", onOther, true);
  return () => {
    doc.removeEventListener("beforeinput", onBeforeInput, true);
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("keydown", onOther, true);
    doc.removeEventListener("pointerdown", onOther, true);
    doc.removeEventListener("compositionstart", onOther, true);
  };
}
