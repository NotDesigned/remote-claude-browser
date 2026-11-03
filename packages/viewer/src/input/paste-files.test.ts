// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Up } from "@mirror/protocol";
import { attachKeyCapture, pastedFiles } from "./keys";

type Listener = (event: never) => void;

function fakeDocument() {
  const listeners = new Map<string, Set<Listener>>();
  const doc = {
    activeElement: null as unknown,
    execCommand: vi.fn(() => true),
    defaultView: { getComputedStyle: () => ({}) },
    addEventListener(type: string, listener: Listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, event: object) {
      for (const listener of listeners.get(type) ?? []) listener(event as never);
    },
  };
  return doc;
}

function element(doc: ReturnType<typeof fakeDocument>, kind: "editor" | "textarea") {
  return {
    nodeType: 1,
    tagName: kind === "editor" ? "DIV" : "TEXTAREA",
    type: "textarea",
    value: "",
    isContentEditable: kind === "editor",
    parentElement: null,
    childNodes: [],
    ownerDocument: doc,
    closest: () => null,
    getRootNode: () => doc,
  };
}

function clipboard(parts: { text?: string; html?: string; files?: File[] }) {
  const files = parts.files ?? [];
  return {
    getData: (type: string) =>
      type === "text/plain" ? (parts.text ?? "") : type === "text/html" ? (parts.html ?? "") : "",
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    files,
  } as unknown as DataTransfer;
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });

function setup(kind: "editor" | "textarea") {
  const doc = fakeDocument();
  const target = element(doc, kind);
  doc.activeElement = target;
  const sent: Up[] = [];
  const pasted: File[][] = [];
  attachKeyCapture({
    doc: doc as unknown as Document,
    tab: "T1",
    getNodeId: () => 7,
    send: (message) => sent.push(message),
    committedContenteditable: true,
    onPasteFiles: (files) => pasted.push(files),
  });
  const paste = (data: DataTransfer) => {
    const event = {
      target,
      isTrusted: true,
      clipboardData: data,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    doc.fire("paste", event);
    return event;
  };
  return { doc, sent, pasted, paste };
}

describe("pasting files into the DOM mirror", () => {
  it("uploads a pasted image instead of inserting it into the local mirror", () => {
    const { sent, pasted, paste, doc } = setup("editor");
    const image = png();
    const event = paste(clipboard({ files: [image] }));
    expect(pasted).toEqual([[image]]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(doc.execCommand).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("uploads the image and still pastes the accompanying text as plain text", () => {
    const { pasted, paste, doc } = setup("editor");
    const image = png();
    const event = paste(
      clipboard({ text: "看这张图", html: '<p>看这张图</p><img src="x.png">', files: [image] }),
    );
    expect(pasted).toEqual([[image]]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(doc.execCommand).toHaveBeenCalledWith("insertText", false, "看这张图");
  });

  it("keeps native text paste in value fields while uploading the image", () => {
    const { pasted, paste } = setup("textarea");
    const event = paste(clipboard({ text: "caption", files: [png()] }));
    expect(pasted).toHaveLength(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("treats an Office picture rendition of copied text as text only", () => {
    const { pasted, paste, doc } = setup("editor");
    const event = paste(
      clipboard({
        text: "表格内容",
        html: "<table><tr><td>表格内容</td></tr></table>",
        files: [png()],
      }),
    );
    expect(pasted).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it("reads files from items and falls back to the files list", () => {
    const image = png();
    expect(pastedFiles(null)).toEqual([]);
    expect(pastedFiles(clipboard({ files: [image] }))).toEqual([image]);
    const filesOnly = { getData: () => "", items: [], files: [image] } as unknown as DataTransfer;
    expect(pastedFiles(filesOnly)).toEqual([image]);
  });
});
