// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Up } from "@mirror/protocol";
import { attachChangeCapture } from "./change";

type Listener = (event: never) => void;

/** Capture and bubble listeners run in the order they were added, as in a document. */
class FakeDocument {
  readonly listeners = new Map<string, Listener[]>();
  activeElement: unknown = null;
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }
  fire(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

/** An editing host whose text is one text node. */
function editor(nodeId: number, initial: string) {
  const text = { nodeType: 3, nodeName: "#text", textContent: initial, childNodes: [] };
  const host = {
    nodeId,
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    isContentEditable: true,
    parentElement: null,
    childNodes: [text],
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    get textContent() {
      return text.textContent;
    },
    set textContent(value: string) {
      text.textContent = value;
    },
  };
  return host;
}

function capture() {
  const doc = new FakeDocument();
  const sent: Up[] = [];
  attachChangeCapture({
    doc: doc as unknown as Document,
    tab: "T1",
    getNodeId: (node) => (node as unknown as { nodeId: number }).nodeId,
    send: (message) => sent.push(message),
    committedContenteditable: true,
  });
  return { doc, sent };
}

describe("editor edits carry the text they were made on", () => {
  it("sends the text this replay showed before the edit", () => {
    const { doc, sent } = capture();
    const host = editor(60, "first message");
    const type = (text: string) => {
      doc.fire("beforeinput", { target: host, isTrusted: true, inputType: "insertText" });
      host.textContent = text;
      doc.fire("input", { target: host, isTrusted: true, inputType: "insertText" });
    };
    type("first message!");
    // The page sent the message and cleared its composer; this replay still shows the text, and
    // the page makes the edit from this base on its own text, not the whole text again.
    type("first message!n");
    expect(sent).toEqual([
      {
        t: "value",
        tab: "T1",
        nodeId: 60,
        value: "first message!",
        commit: false,
        base: "first message",
      },
      {
        t: "value",
        tab: "T1",
        nodeId: 60,
        value: "first message!n",
        commit: false,
        base: "first message!",
      },
    ]);
  });

  it("takes the base when a composition begins and keeps it to the commit", () => {
    const { doc, sent } = capture();
    const host = editor(61, "ni");
    for (const text of ["nih", "nihao"]) {
      doc.fire("beforeinput", {
        target: host,
        isTrusted: true,
        inputType: "insertCompositionText",
      });
      host.textContent = text;
      doc.fire("input", { target: host, isTrusted: true, isComposing: true });
    }
    host.textContent = "ni你好";
    doc.fire("compositionend", { target: host, isTrusted: true, data: "你好" });
    expect(sent).toEqual([
      { t: "value", tab: "T1", nodeId: 61, value: "ni你好", commit: false, base: "ni" },
    ]);
  });

  it("forgets the base of an edit that was cancelled, such as Enter sent as a key", () => {
    const { doc, sent } = capture();
    const host = editor(62, "hello");
    doc.fire("beforeinput", {
      target: host,
      isTrusted: true,
      inputType: "insertParagraph",
      defaultPrevented: true,
    });
    // The page's clear reaches this replay before the next key.
    host.textContent = "";
    doc.fire("beforeinput", { target: host, isTrusted: true, inputType: "insertText" });
    host.textContent = "x";
    doc.fire("input", { target: host, isTrusted: true, inputType: "insertText" });
    expect(sent).toEqual([
      { t: "value", tab: "T1", nodeId: 62, value: "x", commit: false, base: "" },
    ]);
  });
});
