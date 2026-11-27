/** Plain-text editing contract shared by the mirror and the authoritative browser. */
export interface EditableTextNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<EditableTextNode>;
  getAttribute?(name: string): string | null;
}

/** Normalize native DIVs and editor paragraphs to the same single-newline representation. */
export function editableText(node: EditableTextNode): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeName === "BR")
    return /(?:^|\s)ProseMirror-trailingBreak(?:\s|$)/.test(node.getAttribute?.("class") ?? "")
      ? ""
      : "\n";
  const children = Array.from(node.childNodes);
  if (children.length === 1 && children[0]!.nodeName === "BR") return "";
  let text = "";
  let previousBlock = false;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    const block = /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6])$/.test(child.nodeName);
    if (index > 0 && (block || previousBlock)) text += "\n";
    text += editableText(child);
    previousBlock = block;
  }
  return text;
}

/**
 * Rich editors (ProseMirror, Lexical, claude.ai's composer) answer an `insertText` by rebuilding
 * their DOM a moment later, and store a typed space as U+00A0 or end with an empty paragraph. These
 * are the differences no reader of the text could see.
 */
export function normalizeEditableText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "");
}

export function sameEditableText(actual: string, expected: string): boolean {
  return actual === expected || normalizeEditableText(actual) === normalizeEditableText(expected);
}

/**
 * A field's text as a short fingerprint, so that the page and a viewer can tell they hold the
 * same text without either sending it: FNV-1a (32 bit) over the UTF-16 code units of the
 * normalized text, as 8 hex digits.
 */
export function editHash(text: string): string {
  const normalized = normalizeEditableText(text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Where a DOM point (`container`, `offset`, as a Selection or Range gives it) falls in
 * `editableText(root)`, by the same rules: a point between two blocks is the start of the second.
 * -1 when the point is not inside `root`.
 */
export function editableOffset(
  root: EditableTextNode,
  container: EditableTextNode,
  offset: number,
): number {
  let found = -1;
  const visit = (node: EditableTextNode, before: number): string => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      if (node === container) found = before + Math.max(0, Math.min(offset, text.length));
      return text;
    }
    if (node.nodeName === "BR") {
      if (node === container) found = before;
      return /(?:^|\s)ProseMirror-trailingBreak(?:\s|$)/.test(node.getAttribute?.("class") ?? "")
        ? ""
        : "\n";
    }
    const children = Array.from(node.childNodes);
    if (children.length === 1 && children[0]!.nodeName === "BR") {
      if (node === container || children[0] === container) found = before;
      return "";
    }
    let text = "";
    let previousBlock = false;
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      const block = /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6])$/.test(child.nodeName);
      if (index > 0 && (block || previousBlock)) text += "\n";
      if (node === container && offset === index) found = before + text.length;
      text += visit(child, before + text.length);
      previousBlock = block;
    }
    if (node === container && offset >= children.length) found = before + text.length;
    return text;
  };
  visit(root, 0);
  return found;
}

/** A DOM point, as a Range or Selection takes it. */
export interface EditablePoint<T extends EditableTextNode = EditableTextNode> {
  container: T;
  offset: number;
}

const TRAILING_BREAK = /(?:^|\s)ProseMirror-trailingBreak(?:\s|$)/;
const BLOCK = /^(P|DIV|LI|PRE|BLOCKQUOTE|H[1-6])$/;

/**
 * The inverse of editableOffset: the DOM point inside `root` at `offset` of `editableText(root)`,
 * by the same rules, so that `editableOffset(root, p.container, p.offset) === offset`. A point in
 * a text node is preferred (a Range there has a rect); an empty paragraph, a line break or an
 * element with no text is used otherwise. Null when `offset` is outside the text.
 */
export function editablePoint<T extends EditableTextNode>(
  root: T,
  offset: number,
): EditablePoint<T> | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  const find = (textOnly: boolean): EditablePoint<T> | null => {
    let found: EditablePoint<T> | null = null;
    const visit = (node: EditableTextNode, before: number): string => {
      if (node.nodeType === 3) {
        const text = node.textContent ?? "";
        if (found === null && offset >= before && offset <= before + text.length)
          found = { container: node as T, offset: offset - before };
        return text;
      }
      if (node.nodeName === "BR")
        return TRAILING_BREAK.test(node.getAttribute?.("class") ?? "") ? "" : "\n";
      const children = Array.from(node.childNodes);
      if (children.length === 1 && children[0]!.nodeName === "BR") {
        if (!textOnly && found === null && offset === before)
          found = { container: node as T, offset: 0 };
        return "";
      }
      let text = "";
      let previousBlock = false;
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        const block = BLOCK.test(child.nodeName);
        if (index > 0 && (block || previousBlock)) text += "\n";
        if (
          !textOnly &&
          found === null &&
          child.nodeName === "BR" &&
          offset === before + text.length
        )
          found = { container: node as T, offset: index };
        text += visit(child, before + text.length);
        previousBlock = block;
      }
      if (!textOnly && found === null && offset === before + text.length)
        found = { container: node as T, offset: children.length };
      return text;
    };
    visit(root, 0);
    return found;
  };
  return find(true) ?? find(false);
}
