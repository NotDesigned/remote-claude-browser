// @vitest-environment node
import { describe, expect, it } from "vitest";
import { editHash, type AgentMsg } from "@mirror/protocol";
import { createCommandHandler, type NodeMirror } from "./commands";

/** Just enough of a DOM for the fence: elements, text, a focused element and a selection. */
interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  textContent: string | null;
  childNodes: FakeNode[];
  parentElement: FakeNode | null;
  isContentEditable?: boolean;
  ownerDocument?: FakeDocument;
  getAttribute(name: string): string | null;
  [key: string]: unknown;
}

interface FakeDocument {
  activeElement: FakeNode | null;
  selection: { node: FakeNode; offset: number; endNode?: FakeNode; endOffset?: number } | null;
  getSelection(): unknown;
}

function fakeDocument(): FakeDocument {
  const document: FakeDocument = {
    activeElement: null,
    selection: null,
    getSelection() {
      const selection = document.selection;
      if (selection === null) return { rangeCount: 0 };
      return {
        rangeCount: 1,
        getRangeAt: () => ({
          startContainer: selection.node,
          startOffset: selection.offset,
          endContainer: selection.endNode ?? selection.node,
          endOffset: selection.endOffset ?? selection.offset,
        }),
      };
    },
  };
  return document;
}

function element(
  document: FakeDocument,
  name: string,
  children: FakeNode[] = [],
  extra: Record<string, unknown> = {},
): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    tagName: name.toUpperCase(),
    textContent: null,
    childNodes: children,
    parentElement: null,
    ownerDocument: document,
    getAttribute: (attribute) =>
      attribute === "class" ? ((extra.className as string | undefined) ?? null) : null,
    ...extra,
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function text(value: string): FakeNode {
  return {
    nodeType: 3,
    nodeName: "#text",
    textContent: value,
    childNodes: [],
    parentElement: null,
    getAttribute: () => null,
  };
}

function editable(document: FakeDocument, name: string, children: FakeNode[] = []): FakeNode {
  const node = element(document, name, children, { isContentEditable: true });
  for (const child of children) if (child.nodeType === 1) child.isContentEditable = true;
  return node;
}

function harness(document: FakeDocument, ids = new Map<unknown, number>()) {
  const messages: AgentMsg[] = [];
  const mirror: NodeMirror = {
    getIds: () => [...ids.values()],
    getNode: () => null,
    getId: (node) => ids.get(node) ?? -1,
  };
  const emitter = { docId: 77, emit: (message: AgentMsg) => messages.push(message) };
  const handler = createCommandHandler(emitter, {
    getNodeMirror: () => mirror,
    fenceDocument: document as unknown as Document,
  });
  const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { handler, messages, settled };
}

describe("fence", () => {
  it("is emitted after the effects of earlier input reached the recorder", async () => {
    const document = fakeDocument();
    const { handler, messages, settled } = harness(document);
    const mutation = (n: number) =>
      ({
        kind: "rrweb",
        docId: 77,
        e: { type: 3, data: { n }, timestamp: n },
      }) as unknown as AgentMsg;
    // The input's own mutation callback is still queued when the fence command runs, and the
    // editor queues another while answering it: both reach the stream first.
    queueMicrotask(() => messages.push(mutation(1)));
    handler({ cmd: "fence", reqId: 1, n: 4 });
    queueMicrotask(() => queueMicrotask(() => messages.push(mutation(2))));
    expect(messages).toEqual([]);
    await settled();
    expect(messages.map((message) => message.kind)).toEqual(["rrweb", "rrweb", "fence", "cmdres"]);
    expect(messages[2]).toEqual({ kind: "fence", docId: 77, n: 4, edit: null });
    expect(messages[3]).toEqual({ kind: "cmdres", reqId: 1, ok: true });
  });

  it("answers fences in the order they came", async () => {
    const document = fakeDocument();
    const { handler, messages, settled } = harness(document);
    for (let n = 1; n <= 5; n++) handler({ cmd: "fence", reqId: n, n });
    await settled();
    expect(
      messages.filter((message) => message.kind === "fence").map((message) => message.n),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports a textarea's length, hash and selection, and its text only when asked", async () => {
    const document = fakeDocument();
    const textarea = element(document, "textarea", [], {
      value: "hello\u00a0world\n",
      selectionStart: 5,
      selectionEnd: 11,
      disabled: false,
      readOnly: false,
    });
    document.activeElement = textarea;
    const { handler, messages, settled } = harness(document, new Map([[textarea, 12]]));
    handler({ cmd: "fence", reqId: 1, n: 1 });
    handler({ cmd: "fence", reqId: 2, n: 2, text: true });
    await settled();
    const edit = { node: 12, len: 11, hash: editHash("hello world"), sel: [5, 11] };
    expect(messages[0]).toEqual({ kind: "fence", docId: 77, n: 1, edit });
    expect(messages[2]).toEqual({ kind: "fence", docId: 77, n: 2, edit, text: "hello world" });
  });

  it("reports an editing host's text as editableText does, with the caret mapped into it", async () => {
    const document = fakeDocument();
    const second = text("world");
    const host = editable(document, "div", [
      element(document, "p", [text("hello")]),
      element(document, "p", [second]),
    ]);
    const paragraph = host.childNodes[1]!;
    document.activeElement = paragraph;
    paragraph.isContentEditable = true;
    document.selection = { node: second, offset: 3 };
    const { handler, messages, settled } = harness(document, new Map([[host, 30]]));
    handler({ cmd: "fence", reqId: 1, n: 1, text: true });
    await settled();
    expect(messages[0]).toEqual({
      kind: "fence",
      docId: 77,
      n: 1,
      edit: { node: 30, len: 11, hash: editHash("hello\nworld"), sel: [9, 9] },
      text: "hello\nworld",
    });
  });

  it("reads a ProseMirror composer, trailing break and all", async () => {
    const document = fakeDocument();
    const trailing = element(document, "br", [], { className: "ProseMirror-trailingBreak" });
    const empty = element(document, "p", [trailing]);
    const host = editable(document, "div", [
      element(document, "p", [text("first"), element(document, "br"), text("line")]),
      empty,
    ]);
    document.activeElement = host;
    document.selection = { node: empty, offset: 0 };
    const { handler, messages, settled } = harness(document, new Map([[host, 5]]));
    handler({ cmd: "fence", reqId: 1, n: 1 });
    await settled();
    // "first\nline\n": the empty last paragraph is a newline no reader sees.
    expect(messages[0]).toEqual({
      kind: "fence",
      docId: 77,
      n: 1,
      edit: { node: 5, len: 10, hash: editHash("first\nline"), sel: [10, 10] },
    });
  });

  it("never reports a password's text or hash", async () => {
    const document = fakeDocument();
    const password = element(document, "input", [], {
      type: "password",
      value: "secret",
      selectionStart: 6,
      selectionEnd: 6,
      disabled: false,
      readOnly: false,
    });
    document.activeElement = password;
    const { handler, messages, settled } = harness(document, new Map([[password, 3]]));
    handler({ cmd: "fence", reqId: 1, n: 1, text: true });
    await settled();
    expect(messages[0]).toEqual({
      kind: "fence",
      docId: 77,
      n: 1,
      edit: { node: 3, len: 6, hash: "", sel: [6, 6] },
    });
    expect(JSON.stringify(messages)).not.toContain("secret");
  });

  it("reports no field when nothing editable has focus", async () => {
    const document = fakeDocument();
    document.activeElement = element(document, "body");
    const button = fakeDocument();
    button.activeElement = element(button, "input", [], { type: "checkbox", value: "on" });
    for (const current of [fakeDocument(), document, button]) {
      const { handler, messages, settled } = harness(current);
      handler({ cmd: "fence", reqId: 1, n: 1, text: true });
      await settled();
      expect(messages[0]).toEqual({ kind: "fence", docId: 77, n: 1, edit: null });
    }
  });

  it("marks focus inside a cross-origin frame as a field it cannot read", async () => {
    const document = fakeDocument();
    const frame = element(document, "iframe");
    Object.defineProperty(frame, "contentDocument", {
      get() {
        throw new Error("cross-origin");
      },
    });
    document.activeElement = frame;
    const { handler, messages, settled } = harness(document);
    handler({ cmd: "fence", reqId: 1, n: 1 });
    await settled();
    expect(messages[0]).toEqual({
      kind: "fence",
      docId: 77,
      n: 1,
      edit: { node: -1, len: 0, hash: "", sel: [0, 0] },
    });
  });
});
