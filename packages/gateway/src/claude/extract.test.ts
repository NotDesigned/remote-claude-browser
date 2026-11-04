import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_EXPRESSION,
  EDITOR_FOCUS_EXPRESSION,
  attachmentRemoveExpression,
  buttonExpression,
  rowScrollExpression,
  stepExpandExpression,
} from "./extract";

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

  describe("virtualized transcripts", () => {
    const message = (row: number, testid: string, text: string) => {
      const element: Record<string, unknown> = {
        nodeType: 1,
        tagName: "DIV",
        textContent: text,
        childNodes: [{ nodeType: 3, textContent: text }],
        children: [],
        contains: () => false,
        getAttribute: () => null,
        hasAttribute: () => false,
        matches: (selector: string) => selector === `[data-testid="${testid}"]`,
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: (selector: string) =>
          selector.includes("transcript-row")
            ? {
                getAttribute: () => String(row),
                querySelector: () => ({ getAttribute: () => "6" }),
                querySelectorAll: () => [element],
              }
            : null,
      };
      return element;
    };
    const page = (elements: unknown[], extra: Record<string, unknown> = {}) => ({
      document: {
        querySelector: (selector: string) =>
          selector.includes("transcript-row") ? { row: true } : null,
        querySelectorAll: (selector: string) =>
          selector.includes('[data-testid="user-message"]') ? elements : [],
      },
      location: { href: "https://claude.ai/chat/a", pathname: "/chat/a" },
      URL,
      ...extra,
    });

    it("gives every row its absolute position and marks unmounted rows as pending", () => {
      const state = new Script(CHAT_EXPRESSION).runInNewContext(
        page([message(4, "user-message", "问题"), message(5, "assistant-message", "回答")]),
      );
      expect(state.messages).toHaveLength(6);
      expect(state.messages[0]).toMatchObject({ id: "r0", pending: true });
      expect(state.messages[4]).toMatchObject({ id: "r4", role: "user", text: "问题" });
      expect(state.messages[5]).toMatchObject({ id: "r5", role: "assistant", text: "回答" });
      expect(state.messages[5].pending).toBeUndefined();
    });

    it("does not read the previous conversation's rows under a new URL", () => {
      const old = message(5, "assistant-message", "旧对话");
      const cache = { entries: new WeakMap(), dirty: new WeakSet() };
      const context = page([old], { __mirrorChatCache: cache });
      new Script(CHAT_EXPRESSION).runInNewContext(context);
      context.location.pathname = "/chat/b";
      expect(new Script(CHAT_EXPRESSION).runInNewContext(context).messages).toEqual([]);
      cache.dirty.add(old);
      expect(new Script(CHAT_EXPRESSION).runInNewContext(context).messages[5].text).toBe("旧对话");
    });

    it("scrolls towards an unmounted row and reports a mounted one", () => {
      const row = (index: number, top: number) => ({
        getAttribute: () => String(index),
        getBoundingClientRect: () => ({ top, bottom: top + 100 }),
      });
      const scroller = {
        scrollTop: 5000,
        scrollHeight: 6000,
        clientHeight: 1000,
        getBoundingClientRect: () => ({ top: 0 }),
      };
      const context = {
        document: {
          querySelector: () => scroller,
          querySelectorAll: () => [row(8, 100), row(9, 300)],
        },
      };
      expect(new Script(rowScrollExpression(9)).runInNewContext(context)).toBe("mounted");
      expect(new Script(rowScrollExpression(2)).runInNewContext(context)).toBe("moved");
      expect(scroller.scrollTop).toBe(4200);
    });

    it("finds a message by row for its controls", () => {
      const toggle = { getAttribute: () => "false", click: vi.fn() };
      const status = {
        parentElement: { closest: () => null },
        querySelector: () => toggle,
      };
      const target = { contains: () => false, querySelectorAll: () => [status] };
      const rowNode = { querySelectorAll: () => [target] };
      const seen: string[] = [];
      const context = {
        document: {
          querySelector: (selector: string) => {
            seen.push(selector);
            return rowNode;
          },
        },
      };
      expect(new Script(stepExpandExpression(7, 0)).runInNewContext(context)).toBe(true);
      expect(seen).toContain('[data-testid="transcript-row"][data-index="7"]');
      expect(toggle.click).toHaveBeenCalledOnce();
    });
  });

  describe("composer attachments", () => {
    const composer = (name: string, click = vi.fn()) => ({
      click,
      context: {
        document: {
          querySelectorAll: () => [
            {
              textContent: name,
              querySelector: () => ({ getAttribute: () => `Remove ${name}`, click }),
            },
          ],
        },
      },
    });

    it("removes the attachment only when the name still matches", () => {
      const { click, context } = composer("a.txt");
      expect(new Script(attachmentRemoveExpression(0, "b.txt")).runInNewContext(context)).toBe(
        false,
      );
      expect(click).not.toHaveBeenCalled();
      expect(new Script(attachmentRemoveExpression(0, "a.txt")).runInNewContext(context)).toBe(
        true,
      );
      expect(click).toHaveBeenCalledOnce();
    });

    it("lists attachments in the chat state", () => {
      const { context } = composer("a.txt");
      const document = {
        querySelectorAll: (selector: string) =>
          selector.includes("composer-attachments") ? context.document.querySelectorAll() : [],
      };
      const state = new Script(CHAT_EXPRESSION).runInNewContext({
        document,
        location: { href: "https://claude.ai/new", pathname: "/new" },
        URL,
      });
      expect(state.attachments).toEqual([{ name: "a.txt", removable: true }]);
    });
  });
});
