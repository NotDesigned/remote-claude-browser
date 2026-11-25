// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMsg } from "@mirror/protocol";
import {
  createCommandHandler,
  normalizeEditableText,
  sameEditableText,
  settleEditable,
  type NodeMirror,
} from "./commands";

afterEach(() => vi.unstubAllGlobals());

describe("editable comparison", () => {
  it("treats a no-break space and an editor's trailing newline as the same text", () => {
    expect(sameEditableText("hello world", "hello world")).toBe(true);
    expect(sameEditableText("hello world\n", "hello world")).toBe(true);
    expect(sameEditableText("a\r\nb", "a\nb")).toBe(true);
    expect(normalizeEditableText("x \n\n")).toBe("x ");
  });

  it("still tells different text apart", () => {
    expect(sameEditableText("hello", "hello world")).toBe(false);
    expect(sameEditableText("a\nb", "ab")).toBe(false);
  });
});

describe("settleEditable", () => {
  const immediate = (callback: () => void) => queueMicrotask(callback);

  it("accepts text that an editor rewrites a moment after the edit", async () => {
    const reads = ["", "partial", "done now"];
    const read = vi.fn(() => reads.shift() ?? "done now");
    await expect(settleEditable(read, "done now", immediate, [0, 16, 34])).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up after its last look", async () => {
    const read = vi.fn(() => "other");
    await expect(settleEditable(read, "text", immediate, [0, 16])).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("treats a vanished editor as not yet matching", async () => {
    const reads: (string | null)[] = [null, "text"];
    await expect(settleEditable(() => reads.shift() ?? null, "text", immediate, [0])).resolves.toBe(
      true,
    );
  });
});

describe("contenteditable value command", () => {
  function editor(text: { value: string }) {
    const textNode = {
      nodeType: 3,
      nodeName: "#text",
      get textContent() {
        return text.value;
      },
      childNodes: [],
    };
    const document = {
      activeElement: null as unknown,
      createRange: () => ({
        selectNodeContents: vi.fn(),
        setStart: vi.fn(),
        setEnd: vi.fn(),
      }),
      getSelection: () => ({ removeAllRanges: vi.fn(), addRange: vi.fn() }),
      createTreeWalker: () => ({ nextNode: () => null }),
      execCommand: vi.fn(() => true),
    };
    const host = {
      nodeType: 1,
      nodeName: "DIV",
      isConnected: true,
      isContentEditable: true,
      ownerDocument: document,
      get textContent() {
        return text.value;
      },
      get childNodes() {
        return [textNode];
      },
      focus: vi.fn(),
      getAttribute: () => null,
    };
    return { host, document };
  }

  it("reports success once a rich editor settles on the sent text", async () => {
    vi.stubGlobal("Node", { ELEMENT_NODE: 1 });
    const text = { value: "" };
    const { host, document } = editor(text);
    // The editor shows its own rendering of the text only after a re-render.
    document.execCommand.mockImplementation(() => {
      setTimeout(() => (text.value = "hi there"), 20);
      return true;
    });
    const nodes: NodeMirror = { getIds: () => [5], getNode: () => host as unknown as Node };
    const messages: AgentMsg[] = [];
    const timers: Array<() => void> = [];
    const handler = createCommandHandler(
      { emit: (message) => messages.push(message) },
      {
        getNodeMirror: () => nodes,
        schedule: (callback) => timers.push(callback),
        editableSettleDelaysMs: [0, 16, 34],
      },
    );
    vi.useFakeTimers();
    handler({ cmd: "value", reqId: 9, nodeId: 5, value: "hi there" });
    await Promise.resolve();
    // First look: the editor has not re-rendered yet.
    expect(messages).toEqual([]);
    vi.advanceTimersByTime(20);
    while (timers.length > 0 && messages.length === 0) {
      timers.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    vi.useRealTimers();
    expect(messages).toEqual([{ kind: "cmdres", reqId: 9, ok: true }]);
  });
});
