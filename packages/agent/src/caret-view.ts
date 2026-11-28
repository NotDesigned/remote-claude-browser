/**
 * Where an editor's caret is after an edit the agent made, as a person typing there would see it.
 *
 * Typing into a field, the browser keeps the caret in view: an editor in a box of limited height
 * (claude.ai's composer scrolls past a few hundred pixels) scrolls along to the line typed on. An
 * edit made with `execCommand` (the `value` command) does not: Chrome replaces the text and leaves
 * the box where layout put it, and an edit that replaces the whole text first empties the box,
 * which puts it back at its top. An editor that does not scroll its own selection into view then
 * shows its first lines, and the caret out of sight below them, after every such edit.
 * `revealCaret` scrolls the boxes around the caret as typing would; never the page itself.
 *
 * Text with line breaks inserted as one piece (`Input.insertText`: an IME's commit, a phone
 * keyboard's clipboard, a paste in single-writer input) makes Chrome split it into paragraphs and
 * leave the caret short of the end of what it inserted, about a character for each line break, so
 * that what is typed next lands some lines up. The text after the caret is the same before and
 * after an insertion, so the caret goes back to the same distance from the end of the editor's
 * text (`caretFromEnd` before, `placeCaretFromEnd` after).
 */

/** How far a revealed caret stays from the edge of its box, as the browser leaves it. */
const REVEAL_MARGIN_PX = 4;

/** The caret's rect on screen, or null when the selection is not in `host`. */
function caretRect(host: HTMLElement): DOMRect | null {
  const document = host.ownerDocument;
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.focusNode === null) return null;
  if (!host.contains(selection.focusNode)) return null;
  const range = document.createRange();
  try {
    range.setStart(selection.focusNode, selection.focusOffset);
  } catch {
    return null;
  }
  range.collapse(true);
  const rect = range.getClientRects()[0];
  if (rect !== undefined && rect.height > 0) return rect;
  // A caret in an empty line (a paragraph holding only a <br>) has no rect of its own.
  const node =
    selection.focusNode.nodeType === Node.ELEMENT_NODE
      ? ((selection.focusNode as Element).childNodes[selection.focusOffset] ?? selection.focusNode)
      : selection.focusNode.parentElement;
  if (node === null || node.nodeType !== Node.ELEMENT_NODE) return null;
  const box = (node as Element).getBoundingClientRect();
  return box.height > 0 ? box : null;
}

function scrollsVertically(element: Element, document: Document): boolean {
  if (element.scrollHeight <= element.clientHeight) return false;
  const overflow = document.defaultView?.getComputedStyle(element).overflowY ?? "";
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * Scrolls each box from the caret up to (not including) the page's own scroller as far as it takes
 * for the caret to be seen in it, as typing there would. Returns true when anything moved.
 */
export function revealCaret(host: HTMLElement): boolean {
  try {
    return reveal(host);
  } catch {
    // A page's odd DOM only leaves the box where it was.
    return false;
  }
}

function reveal(host: HTMLElement): boolean {
  const rect = caretRect(host);
  if (rect === null) return false;
  const document = host.ownerDocument;
  let top = rect.top;
  let bottom = rect.bottom;
  let moved = false;
  for (
    let element: Element | null = host;
    element !== null && element !== document.scrollingElement && element !== document.body;
    element = element.parentElement
  ) {
    if (!scrollsVertically(element, document)) continue;
    const box = element.getBoundingClientRect();
    const visibleTop = box.top + element.clientTop;
    const visibleBottom = visibleTop + element.clientHeight;
    let delta = 0;
    if (bottom > visibleBottom) delta = bottom - visibleBottom + REVEAL_MARGIN_PX;
    else if (top < visibleTop) delta = top - visibleTop - REVEAL_MARGIN_PX;
    if (delta === 0) continue;
    const before = element.scrollTop;
    element.scrollTop = before + delta;
    const shift = element.scrollTop - before;
    if (shift !== 0) moved = true;
    // The caret moved with the box's content; the next box out sees it there.
    top -= shift;
    bottom -= shift;
  }
  return moved;
}

/** How many characters of `host`'s text follow the caret; null when the caret is not in it. */
export function caretFromEnd(host: HTMLElement): number | null {
  const document = host.ownerDocument;
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.focusNode === null) return null;
  if (!host.contains(selection.focusNode)) return null;
  try {
    const rest = document.createRange();
    rest.setStart(selection.focusNode, selection.focusOffset);
    rest.setEnd(host, host.childNodes.length);
    return rest.toString().length;
  } catch {
    return null;
  }
}

/**
 * Puts a collapsed caret `fromEnd` characters before the end of `host`'s text (as `caretFromEnd`
 * counts them). Returns false when the text is shorter than that, leaving the caret alone.
 */
export function placeCaretFromEnd(host: HTMLElement, fromEnd: number): boolean {
  const document = host.ownerDocument;
  const selection = document.getSelection();
  if (selection === null) return false;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    texts.push(node as Text);
  let remaining = fromEnd;
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = texts[index]!;
    if (remaining <= text.data.length) {
      const at = text.data.length - remaining;
      selection.setBaseAndExtent(text, at, text, at);
      return true;
    }
    remaining -= text.data.length;
  }
  return false;
}
