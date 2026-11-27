// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMsg } from "@mirror/protocol";
import { createCommandHandler, rebaseEditable, settleEditable, type NodeMirror } from "./commands";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rebaseEditable", () => {
  it("takes the viewer's text while the page holds what the viewer edited", () => {
    expect(rebaseEditable("hello", "hello", "hello!")).toBe("hello!");
    expect(rebaseEditable("hello\n", "hello", "hello!")).toBe("hello!");
    expect(rebaseEditable("a b", "a b", "a bc")).toBe("a bc");
  });

  it("types on into a composer the page cleared after sending, without the message sent", () => {
    expect(rebaseEditable("", "first message", "first messagen")).toBe("n");
    expect(rebaseEditable("n", "first messagen", "first messagene")).toBe("ne");
    // A page that sends asynchronously may have taken the earlier keys already.
    expect(rebaseEditable("nex", "first messagenex", "first messagenext")).toBe("next");
  });

  it("keeps what the page's editor made of the text", () => {
    // ProseMirror's input rule turned "--" into an em dash; typing goes on after it.
    expect(rebaseEditable("a—", "a--", "a-- b")).toBe("a— b");
    // ... before the closing break the page keeps.
    expect(rebaseEditable("a—\n", "a--", "a--b")).toBe("a—b\n");
    // Markdown shortcut: the asterisks are gone, the word stays.
    expect(rebaseEditable("say bold", "say **bold**", "say **bold** now")).toBe("say bold now");
    // A deletion at the end deletes there.
    expect(rebaseEditable("a—x", "a--x", "a--")).toBe("a—");
  });

  it("finds an edit elsewhere by the text around it", () => {
    expect(rebaseEditable("hello world!", "hello world", "helloX world")).toBe("helloX world!");
    expect(rebaseEditable("Ahello world", "hello world", "helloX world")).toBe("AhelloX world");
  });

  it("makes no edit of a flush that edits nothing", () => {
    expect(rebaseEditable("", "sent text", "sent text")).toBe("");
    expect(rebaseEditable("a—", "a--", "a--")).toBe("a—");
  });

  it("keeps the page's text when the edit cannot be placed on it", () => {
    expect(rebaseEditable("xyz", "hello world", "hello, world")).toBe("xyz");
  });

  it("does not put a sent message back for an edit of it made after the page cleared it", () => {
    // Backspace while the viewer still showed the message.
    expect(rebaseEditable("", "oops typo", "oops typ")).toBe("");
    // A phone keyboard's autocorrect replacing the last word just after Return or the send button.
    expect(rebaseEditable("", "meet teh", "meet the")).toBe("");
    expect(rebaseEditable("", "meet teh", "meet the ")).toBe("");
    // An edit inside it, and one over the whole of it.
    expect(rebaseEditable("", "hello world", "hello, world")).toBe("");
    expect(rebaseEditable("", "hello", "bye")).toBe("");
    // The next message already begun on the page keeps going, untouched by the edit.
    expect(rebaseEditable("n", "meet tehn", "meet then")).toBe("n");
  });

  it("keeps a typed line break at the end", () => {
    expect(rebaseEditable("ab", "a\n", "a\nb")).toBe("abb");
    expect(rebaseEditable("x\n", "y\n", "y\nz")).toBe("x\nz");
  });
});

describe("settleEditable with the text before the edit", () => {
  const immediate = (callback: () => void) => queueMicrotask(callback);

  it("accepts an editor that rewrote the edit and settled", async () => {
    const reads = ["a--", "a—", "a—", "a—"];
    await expect(
      settleEditable(() => reads.shift() ?? "a—", "a--", immediate, [0, 16, 34], "a-"),
    ).resolves.toBe(true);
  });

  it("still fails an edit that never reached the editor", async () => {
    await expect(settleEditable(() => "a-", "a--", immediate, [0, 16], "a-")).resolves.toBe(false);
  });

  it("does not accept an editor that is still changing at the last look", async () => {
    let count = 0;
    await expect(
      settleEditable(() => `changing ${count++}`, "typed", immediate, [0, 16], "before"),
    ).resolves.toBe(false);
  });
});

describe("contenteditable value command with a base", () => {
  /** A one-text-node editor whose execCommand does what the browser would, plus `rewrite`. */
  function setup(initial: string, rewrite: (text: string) => string = (text) => text) {
    vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
    const state = { text: initial, start: 0, end: initial.length };
    const textNode = {
      nodeType: 3,
      nodeName: "#text",
      get textContent() {
        return state.text;
      },
      childNodes: [],
    };
    const document = {
      activeElement: null as unknown,
      createRange: () => ({
        selectNodeContents: () => {
          state.start = 0;
          state.end = state.text.length;
        },
        setStart: (_node: unknown, offset: number) => (state.start = offset),
        setEnd: (_node: unknown, offset: number) => (state.end = offset),
      }),
      getSelection: () => ({ removeAllRanges: vi.fn(), addRange: vi.fn() }),
      createTreeWalker: () => {
        let done = false;
        return {
          nextNode: () => {
            if (done) return null;
            done = true;
            return textNode;
          },
        };
      },
      execCommand: vi.fn((_command: string, _ui: boolean, insert: string) => {
        state.text = state.text.slice(0, state.start) + insert + state.text.slice(state.end);
        state.text = rewrite(state.text);
        return true;
      }),
    };
    const host = {
      nodeType: 1,
      nodeName: "DIV",
      isConnected: true,
      isContentEditable: true,
      ownerDocument: document,
      get textContent() {
        return state.text;
      },
      get childNodes() {
        return state.text === "" ? [] : [textNode];
      },
      focus: vi.fn(),
      getAttribute: () => null,
    };
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
    return { state, handler, messages, settle, document };
  }

  it("does not put a sent message back into the cleared composer", async () => {
    const { state, handler, messages, settle } = setup("");
    handler({ cmd: "value", reqId: 1, nodeId: 5, value: "hello thereX", base: "hello there" });
    await settle();
    expect(state.text).toBe("X");
    expect(messages).toEqual([{ kind: "cmdres", reqId: 1, ok: true }]);
  });

  it("keeps the cleared composer empty when an edit of the sent message comes", async () => {
    const { state, handler, messages, settle, document } = setup("");
    handler({ cmd: "value", reqId: 1, nodeId: 5, value: "meet the", base: "meet teh" });
    await settle();
    expect(state.text).toBe("");
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 1, ok: true }]);
  });

  it("without a base still sets the whole text, as an older viewer expects", async () => {
    const { state, handler, settle } = setup("");
    handler({ cmd: "value", reqId: 1, nodeId: 5, value: "hello" });
    await settle();
    expect(state.text).toBe("hello");
  });

  it("reports an editor's input rule rewrite as accepted", async () => {
    const { state, handler, messages, settle } = setup("a-", (text) => text.replace("--", "—"));
    handler({ cmd: "value", reqId: 2, nodeId: 5, value: "a--", base: "a-" });
    await settle();
    expect(state.text).toBe("a—");
    expect(messages).toEqual([{ kind: "cmdres", reqId: 2, ok: true }]);
    // The next key goes on after the page's dash, not over it.
    handler({ cmd: "value", reqId: 3, nodeId: 5, value: "a--b", base: "a--" });
    await settle();
    expect(state.text).toBe("a—b");
    expect(messages.at(-1)).toEqual({ kind: "cmdres", reqId: 3, ok: true });
  });

  it("still reports an edit the editor never took", async () => {
    const { state, handler, messages, settle, document } = setup("abc");
    document.execCommand.mockImplementation(() => true);
    handler({ cmd: "value", reqId: 4, nodeId: 5, value: "abcd", base: "abc" });
    await settle();
    expect(state.text).toBe("abc");
    expect(messages).toEqual([
      { kind: "cmdres", reqId: 4, ok: false, err: "editable text does not match" },
    ]);
  });
});
