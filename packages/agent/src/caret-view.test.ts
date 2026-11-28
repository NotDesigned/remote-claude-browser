// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { editableOffset, editableText, type AgentMsg } from "@mirror/protocol";
import { createCommandHandler, type NodeMirror } from "./commands";
import { caretFromEnd, placeCaretFromEnd, revealCaret } from "./caret-view";

afterEach(() => vi.unstubAllGlobals());

/** A text node and the paragraph and editor around it, as plain objects. */
interface FakeText {
  nodeType: 3;
  nodeName: "#text";
  data: string;
  readonly textContent: string;
  childNodes: never[];
  parentElement: FakeElement | null;
}
interface FakeElement {
  nodeType: 1;
  nodeName: string;
  childNodes: Array<FakeElement | FakeText>;
  readonly textContent: string;
  parentElement: FakeElement | null;
  getAttribute(name: string): string | null;
}

function text(data: string): FakeText {
  return {
    nodeType: 3,
    nodeName: "#text",
    data,
    get textContent() {
      return this.data;
    },
    childNodes: [],
    parentElement: null,
  };
}

function element(nodeName: string, children: Array<FakeElement | FakeText>): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    nodeName,
    childNodes: children,
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join("");
    },
    parentElement: null,
    getAttribute: () => null,
  };
  for (const child of children) child.parentElement = node;
  return node;
}

/**
 * An editor of paragraphs whose execCommand("insertText") does what the browser does to the
 * text, and records each call: what was replaced (as offsets into the editor's text) and by what.
 */
function paragraphs(lines: string[]) {
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal("queueMicrotask", (callback: () => void) => callback());
  const host = element(
    "DIV",
    lines.map((line) => element("P", [text(line)])),
  ) as FakeElement & Record<string, unknown>;
  const range = {
    start: [host as FakeElement | FakeText, 0] as [FakeElement | FakeText, number],
    end: [host as FakeElement | FakeText, 0] as [FakeElement | FakeText, number],
    selectNodeContents(node: FakeElement) {
      range.start = [node, 0];
      range.end = [node, node.childNodes.length];
    },
    setStart(node: FakeElement | FakeText, offset: number) {
      range.start = [node, offset];
    },
    setEnd(node: FakeElement | FakeText, offset: number) {
      range.end = [node, offset];
    },
  };
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  const document = {
    activeElement: null as unknown,
    createRange: () => range,
    getSelection: () => ({ removeAllRanges: vi.fn(), addRange: vi.fn() }),
    execCommand: vi.fn((_command: string, _ui: boolean, insert: string) => {
      const from = editableOffset(host, range.start[0], range.start[1]);
      const to = editableOffset(host, range.end[0], range.end[1]);
      edits.push({ from, to, insert });
      const all = editableText(host);
      const next = all.slice(0, from) + insert + all.slice(to);
      host.childNodes = next.split("\n").map((line) => element("P", [text(line)]));
      for (const child of host.childNodes) child.parentElement = host;
      return true;
    }),
  };
  Object.assign(host, {
    isConnected: true,
    isContentEditable: true,
    ownerDocument: document,
    focus: vi.fn(),
    contains: () => false,
  });
  const nodes: NodeMirror = { getIds: () => [5], getNode: () => host as unknown as Node };
  const messages: AgentMsg[] = [];
  const handler = createCommandHandler(
    { emit: (message) => messages.push(message) },
    {
      getNodeMirror: () => nodes,
      schedule: (callback) => queueMicrotask(callback),
      editableSettleDelaysMs: [0, 16],
    },
  );
  const settle = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  };
  return { host, edits, handler, messages, settle };
}

describe("contenteditable value command in an editor of many paragraphs", () => {
  const pasted = Array.from({ length: 60 }, (_, index) => `pasted line ${index + 1}`);

  it("types a key after a long paste as that key alone, at the end", async () => {
    const { host, edits, handler, messages, settle } = paragraphs(pasted);
    const before = pasted.join("\n");
    handler({ cmd: "value", reqId: 1, nodeId: 5, value: `${before} a`, base: before });
    await settle();
    // Not the whole text again: replacing all of it empties the editor's box for a moment, which
    // takes the box back to its top.
    expect(edits).toEqual([{ from: before.length, to: before.length, insert: " a" }]);
    expect(editableText(host)).toBe(`${before} a`);
    expect(messages).toEqual([{ kind: "cmdres", reqId: 1, ok: true }]);
  });

  it("joins two paragraphs by replacing the line break between them only", async () => {
    const { host, edits, handler, settle } = paragraphs(["one", "two", "three"]);
    handler({ cmd: "value", reqId: 1, nodeId: 5, value: "one\ntwothree", base: "one\ntwo\nthree" });
    await settle();
    expect(edits).toEqual([{ from: 7, to: 8, insert: "" }]);
    expect(editableText(host)).toBe("one\ntwothree");
  });

  it("adds lines in the middle as the lines alone", async () => {
    const { host, edits, handler, settle } = paragraphs(["first", "last"]);
    handler({ cmd: "value", reqId: 1, nodeId: 5, value: "first\nnew\nlast", base: "first\nlast" });
    await settle();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.to - edits[0]!.from).toBe(0);
    expect(editableText(host)).toBe("first\nnew\nlast");
  });
});

/** A box of `height` px at `top` scrolling `content` px, and the caret's rect inside it. */
function box(options: { top: number; height: number; content: number; overflowY?: string }) {
  const scroller = {
    nodeType: 1,
    scrollTop: 0,
    clientTop: 0,
    clientHeight: options.height,
    scrollHeight: options.content,
    parentElement: null as unknown,
    getBoundingClientRect: () => ({ top: options.top, bottom: options.top + options.height }),
  };
  // Assignments past the end are clamped, as a browser does.
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) =>
      (scrollTop = Math.max(0, Math.min(value, options.content - options.height))),
  });
  return scroller;
}

function caretIn(scroller: ReturnType<typeof box>, caretY: () => number, overflowY = "auto") {
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  const textNode = { nodeType: 3, parentElement: null };
  const page = { nodeType: 1, parentElement: null };
  scroller.parentElement = page;
  const document = {
    scrollingElement: page,
    body: page,
    defaultView: { getComputedStyle: () => ({ overflowY }) },
    getSelection: () => ({ rangeCount: 1, focusNode: textNode, focusOffset: 0 }),
    createRange: () => ({
      setStart: vi.fn(),
      collapse: vi.fn(),
      getClientRects: () => [{ top: caretY(), bottom: caretY() + 20, height: 20 }],
    }),
  };
  const host = {
    nodeType: 1,
    ownerDocument: document,
    parentElement: scroller,
    contains: (node: unknown) => node === textNode,
    scrollHeight: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  };
  return host as unknown as HTMLElement;
}

describe("revealCaret", () => {
  it("scrolls the composer's box down to a caret below it, as typing there would", () => {
    const scroller = box({ top: 500, height: 120, content: 1100 });
    // The caret's line is 1060 px into the content: below the box while it is at its top.
    const host = caretIn(scroller, () => 500 + 1060 - scroller.scrollTop);
    expect(revealCaret(host)).toBe(true);
    expect(scroller.scrollTop).toBe(964);
    // In view now: nothing more to do.
    expect(revealCaret(host)).toBe(false);
    expect(scroller.scrollTop).toBe(964);
  });

  it("scrolls up to a caret above the box", () => {
    const scroller = box({ top: 500, height: 120, content: 1100 });
    scroller.scrollTop = 900;
    const host = caretIn(scroller, () => 500 + 100 - scroller.scrollTop);
    expect(revealCaret(host)).toBe(true);
    expect(scroller.scrollTop).toBe(96);
  });

  it("leaves a box alone where the caret is seen, and a box that does not scroll", () => {
    const seen = box({ top: 500, height: 120, content: 1100 });
    seen.scrollTop = 400;
    expect(revealCaret(caretIn(seen, () => 500 + 450 - seen.scrollTop))).toBe(false);
    expect(seen.scrollTop).toBe(400);
    const hidden = box({ top: 500, height: 120, content: 1100 });
    expect(revealCaret(caretIn(hidden, () => 1560, "hidden"))).toBe(false);
    expect(hidden.scrollTop).toBe(0);
  });

  it("never throws on a page's odd DOM", () => {
    expect(revealCaret({} as HTMLElement)).toBe(false);
  });
});

describe("caret at a distance from the end", () => {
  it("is put back where it was counted from the end of the text", () => {
    vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
    const texts = [text("pasted line 1"), text("pasted line 2"), text("tail")];
    let selected: [unknown, number] | null = null;
    const document = {
      getSelection: () => ({
        rangeCount: 1,
        focusNode: texts[1],
        focusOffset: 3,
        setBaseAndExtent: (node: unknown, offset: number) => (selected = [node, offset]),
      }),
      createRange: () => {
        let start = 0;
        return {
          setStart: (_node: unknown, offset: number) => (start = offset),
          setEnd: vi.fn(),
          // The text after (texts[1], 3): the rest of that node and the next one.
          toString: () => texts[1]!.data.slice(start) + texts[2]!.data,
        };
      },
      createTreeWalker: () => {
        let index = 0;
        return { nextNode: () => texts[index++] ?? null };
      },
    };
    const host = { ownerDocument: document, contains: () => true, childNodes: texts };
    const fromEnd = caretFromEnd(host as unknown as HTMLElement);
    expect(fromEnd).toBe(14);
    expect(placeCaretFromEnd(host as unknown as HTMLElement, 0)).toBe(true);
    expect(selected).toEqual([texts[2], 4]);
    expect(placeCaretFromEnd(host as unknown as HTMLElement, fromEnd!)).toBe(true);
    expect(selected).toEqual([texts[1], 3]);
    expect(placeCaretFromEnd(host as unknown as HTMLElement, 100)).toBe(false);
  });
});
