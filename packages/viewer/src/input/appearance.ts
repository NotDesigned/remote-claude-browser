const PREEDIT = "mirror-ime-preedit";

export const REPLAY_EDITING_APPEARANCE = `
  @media (forced-colors: none) {
    :is(textarea, [contenteditable]:not([contenteditable="false"]),
        input:not([type]), input:is([type="text"], [type="search"], [type="email"],
        [type="tel"], [type="url"], [type="password"], [type="number"])):focus {
      outline: none !important;
    }

    ::highlight(${PREEDIT}) {
      color: color-mix(in srgb, currentColor 45%, transparent);
    }
  }
`;

export function attachCompositionHighlight(doc: Document): () => void {
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  if (view?.Highlight === undefined) return () => {};
  const highlights = view.CSS.highlights;
  const Highlight = view.Highlight;

  let target: HTMLElement | null = null;
  let start: StaticRange | undefined;
  const clear = () => {
    highlights.delete(PREEDIT);
    target = null;
    start = undefined;
  };

  const onStart = (event: CompositionEvent) => {
    const editor = event.target as HTMLElement;
    if (event.isTrusted && editor.isContentEditable) target = editor;
  };
  const onBeforeInput = (event: InputEvent) => {
    if (event.target === target && event.isTrusted && event.isComposing) {
      start = event.getTargetRanges()[0];
    }
  };
  const onInput = (event: Event) => {
    const input = event as InputEvent;
    if (input.target !== target || !input.isTrusted) return;
    if (!input.isComposing) return clear();

    highlights.delete(PREEDIT);
    const node = doc.getSelection()?.focusNode;
    if (node?.nodeType !== Node.TEXT_NODE || !input.data) return;
    const offset = start?.startContainer === node ? start.startOffset : 0;
    if (node.textContent?.slice(offset, offset + input.data.length) !== input.data) return;

    const range = doc.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + input.data.length);
    highlights.set(PREEDIT, new Highlight(range));
  };
  const onEnd = (event: Event) => {
    if (event.target === target) clear();
  };

  doc.addEventListener("compositionstart", onStart, true);
  doc.addEventListener("beforeinput", onBeforeInput, true);
  doc.addEventListener("input", onInput, true);
  doc.addEventListener("compositionend", onEnd, true);
  doc.addEventListener("blur", onEnd, true);
  return () => {
    doc.removeEventListener("compositionstart", onStart, true);
    doc.removeEventListener("beforeinput", onBeforeInput, true);
    doc.removeEventListener("input", onInput, true);
    doc.removeEventListener("compositionend", onEnd, true);
    doc.removeEventListener("blur", onEnd, true);
    clear();
  };
}
