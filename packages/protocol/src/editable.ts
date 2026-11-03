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
