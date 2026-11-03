import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { CHAT_EXPRESSION, EDITOR_FOCUS_EXPRESSION, buttonExpression } from "./extract";

describe("native chat reads", () => {
  it("samples and operates the composer without forcing a layout measurement", () => {
    const noLayout = () => {
      throw new Error("layout must not be forced");
    };
    let clicked = false;
    const document = {
      title: "Claude",
      activeElement: null as unknown,
      querySelectorAll: (selector: string): unknown[] =>
        selector.includes("ProseMirror") ? [editor] : selector === "button" ? [button] : [],
      createRange: () => ({ selectNodeContents: () => {} }),
    };
    const editor = {
      nodeType: 1,
      nodeName: "DIV",
      isConnected: true,
      closest: () => null,
      childNodes: [{ nodeType: 3, nodeName: "#text", textContent: "中文草稿", childNodes: [] }],
      getClientRects: noLayout,
      focus: () => {
        document.activeElement = editor;
      },
    };
    const button = {
      disabled: false,
      isConnected: true,
      closest: () => null,
      getAttribute: () => "Send message",
      getClientRects: noLayout,
      click: () => {
        clicked = true;
      },
    };
    const context = {
      document,
      location: { href: "https://claude.ai/new" },
      URL,
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    };
    expect(new Script(CHAT_EXPRESSION).runInNewContext(context)).toMatchObject({
      ready: true,
      draft: "中文草稿",
      generating: false,
    });
    expect(new Script(EDITOR_FOCUS_EXPRESSION).runInNewContext(context)).toBe(true);
    expect(new Script(buttonExpression("send", true)).runInNewContext(context)).toBe(true);
    expect(clicked).toBe(true);
  });
});
