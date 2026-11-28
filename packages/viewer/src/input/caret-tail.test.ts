// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepCaretThroughMultilineInserts } from "./caret-tail";

afterEach(() => vi.unstubAllGlobals());

/**
 * An editor of paragraphs, one text node each, with a caret, in a document that hands its
 * listeners the events fired at it. `text(i)` is paragraph i's text node.
 */
function editorPage(lines: string[]) {
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const texts = lines.map((data) => ({ nodeType: 3, data, parentElement: null as unknown }));
  const caret = { node: texts.at(-1) as unknown, offset: texts.at(-1)!.data.length };
  const selection = {
    get rangeCount() {
      return 1;
    },
    get focusNode() {
      return caret.node;
    },
    get focusOffset() {
      return caret.offset;
    },
    getRangeAt: () => ({ endContainer: caret.node, endOffset: caret.offset }),
    setBaseAndExtent: (node: unknown, offset: number) => {
      caret.node = node;
      caret.offset = offset;
    },
  };
  const doc = {
    getSelection: () => selection,
    createRange: () => {
      let start: { node: unknown; offset: number } = { node: null, offset: 0 };
      return {
        setStart: (node: unknown, offset: number) => (start = { node, offset }),
        setEnd: vi.fn(),
        // The text after the start: the rest of its node and all the nodes after it.
        toString: () => {
          const index = texts.indexOf(start.node as (typeof texts)[number]);
          return (
            texts[index]!.data.slice(start.offset) +
            texts
              .slice(index + 1)
              .map((text) => text.data)
              .join("")
          );
        },
      };
    },
    createTreeWalker: () => {
      let index = 0;
      return { nextNode: () => texts[index++] ?? null };
    },
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      ),
  };
  const host = {
    nodeType: 1,
    isContentEditable: true,
    parentElement: null,
    ownerDocument: doc,
    contains: (node: unknown) => texts.includes(node as (typeof texts)[number]),
    childNodes: texts,
  };
  for (const text of texts) text.parentElement = host;
  const fire = (type: string, fields: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(type) ?? [])
      listener({ type, target: host, isTrusted: true, data: null, ...fields } as unknown as Event);
  };
  return { doc, host, texts, caret, fire, listeners };
}

describe("a caret kept through text with line breaks inserted at once", () => {
  it("ends where the inserted text ends, not some lines up where Chrome leaves it", () => {
    const page = editorPage(["before", "tail"]);
    const stop = keepCaretThroughMultilineInserts(page.doc as unknown as Document);
    // The caret before "tail": four characters follow it.
    page.caret.node = page.texts[1];
    page.caret.offset = 0;
    page.fire("beforeinput", { inputType: "insertText", data: "one\ntwo\nthree" });
    // The browser has split the text into paragraphs and left the caret inside "two".
    page.texts.splice(1, 0, { nodeType: 3, data: "one", parentElement: page.host });
    page.texts.splice(2, 0, { nodeType: 3, data: "two", parentElement: page.host });
    page.texts[3]!.data = "threetail";
    page.caret.node = page.texts[2];
    page.caret.offset = 1;
    page.fire("input", { inputType: "insertText" });
    expect(page.caret).toEqual({ node: page.texts[3], offset: 5 });
    // Each input of the same insert (Chrome fires one per paragraph) leaves it there.
    page.fire("beforeinput", { inputType: "insertParagraph" });
    page.fire("input", { inputType: "insertParagraph" });
    expect(page.caret).toEqual({ node: page.texts[3], offset: 5 });

    stop();
    expect([...page.listeners.values()].every((list) => list.length === 0)).toBe(true);
  });

  it("leaves the caret of a one-line insert, typing and a moved caret alone", () => {
    const page = editorPage(["hello"]);
    keepCaretThroughMultilineInserts(page.doc as unknown as Document);
    page.fire("beforeinput", { inputType: "insertText", data: "x" });
    page.caret.offset = 2;
    page.fire("input", { inputType: "insertText" });
    expect(page.caret.offset).toBe(2);

    // A key after a multi-line insert ends it: the caret is the person's again.
    page.fire("beforeinput", { inputType: "insertText", data: "a\nb" });
    page.fire("keydown");
    page.caret.offset = 1;
    page.fire("input", { inputType: "insertText" });
    expect(page.caret.offset).toBe(1);
  });

  it("takes a paste's text from its data transfer", () => {
    const page = editorPage(["start", "end"]);
    keepCaretThroughMultilineInserts(page.doc as unknown as Document);
    page.fire("beforeinput", {
      inputType: "insertFromPaste",
      dataTransfer: { getData: () => "x\ny" },
    });
    page.caret.node = page.texts[0];
    page.caret.offset = 0;
    page.fire("input", { inputType: "insertFromPaste" });
    expect(page.caret).toEqual({ node: page.texts[1], offset: 3 });
  });
});
