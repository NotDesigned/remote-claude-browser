// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Up } from "@mirror/protocol";
import { createFocusFollower, followsFocusByItself, typesText } from "./focus-follow";
import { attachKeyCapture } from "./keys";

type Listener = (event: never) => void;

class FakeElement {
  readonly nodeType = 1;
  isConnected = true;
  isContentEditable = false;
  parentElement: FakeElement | null = null;
  disabled = false;
  readOnly = false;
  type = "text";
  value = "";
  childNodes: FakeElement[] = [];
  focus = vi.fn(() => {
    this.doc.activeElement = this;
  });
  constructor(
    readonly tagName: string,
    readonly doc: FakeDocument,
  ) {}
  get ownerDocument() {
    return this.doc;
  }
  readonly attributes = new Map<string, string>();
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  closest() {
    return null;
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Set<Listener>>();
  activeElement: FakeElement | null = null;
  focused = true;
  selection = {
    isCollapsed: true,
    rangeCount: 0,
    anchorNode: null as unknown,
    selectAllChildren: vi.fn(),
    collapseToEnd: vi.fn(),
  };
  fields: FakeElement[] = [];
  querySelectorAll() {
    return this.fields;
  }
  hasFocus() {
    return this.focused;
  }
  getSelection() {
    return this.selection;
  }
  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

beforeEach(() => vi.stubGlobal("Element", FakeElement));
afterEach(() => vi.unstubAllGlobals());

function setup(followsByItself = true) {
  const doc = new FakeDocument();
  const body = new FakeElement("BODY", doc);
  const field = new FakeElement("INPUT", doc);
  const nodes = new Map<number, FakeElement>([
    [1, body],
    [5, field],
  ]);
  let hiddenFocused = false;
  const hidden = {
    focus: vi.fn(() => (hiddenFocused = true)),
    hasFocus: () => hiddenFocused,
    blur: vi.fn(() => (hiddenFocused = false)),
  };
  const focusMirror = vi.fn();
  const follower = createFocusFollower({
    rootDoc: doc as unknown as Document,
    getNode: (id) => (nodes.get(id) ?? null) as unknown as Node | null,
    hiddenKeyboard: () => hidden,
    followsByItself,
    focusMirror,
  });
  follower.watch(doc as unknown as Document);
  return { doc, body, field, follower, hidden, focusMirror };
}

const key = (target: FakeElement, k: string, extra: Record<string, unknown> = {}) =>
  ({
    target,
    key: k,
    code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
    keyCode: 0,
    isTrusted: true,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...extra,
  }) as unknown as KeyboardEvent;

describe("focus following", () => {
  it("focuses the mirror field the remote page focused, on a desktop with the mirror focused", () => {
    const { field, follower } = setup();
    follower.remoteFocus({ id: 5, editable: true });
    expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("leaves focus alone while the person is busy here, or the mirror is not focused", () => {
    const { doc, field, follower } = setup();
    doc.fire("compositionstart", {});
    follower.remoteFocus({ id: 5, editable: true });
    doc.fire("compositionend", {});
    doc.fire("pointerdown", {});
    follower.remoteFocus({ id: 5, editable: true });
    doc.fire("pointerup", {});
    doc.selection = { ...doc.selection, isCollapsed: false, rangeCount: 1, anchorNode: null };
    follower.remoteFocus({ id: 5, editable: true });
    doc.selection = { ...doc.selection, isCollapsed: true, rangeCount: 0, anchorNode: null };
    doc.focused = false;
    follower.remoteFocus({ id: 5, editable: true });
    expect(field.focus).not.toHaveBeenCalled();
  });

  it("never moves focus by itself on a touch device", () => {
    const { field, hidden, follower } = setup(false);
    follower.remoteFocus({ id: 5, editable: true });
    follower.remoteFocus({ id: 99, editable: true });
    expect(field.focus).not.toHaveBeenCalled();
    expect(hidden.focus).not.toHaveBeenCalled();
  });

  it("uses the hidden textarea for a remote field the mirror does not have", () => {
    const { hidden, follower } = setup();
    follower.remoteFocus({ id: 99, editable: true });
    expect(hidden.focus).toHaveBeenCalledOnce();
  });

  it("gives the keys back to the mirror when the remote page has no field focused", () => {
    const { hidden, follower, focusMirror } = setup();
    follower.remoteFocus({ id: 99, editable: true });
    follower.remoteFocus({ id: 1, editable: false });
    expect(hidden.blur).toHaveBeenCalledOnce();
    expect(focusMirror).toHaveBeenCalledOnce();
  });

  describe("when the page takes away the field someone is typing in", () => {
    /** Typed in the field, which the page then replaced with a new one, focused remotely. */
    function stranded(followsByItself: boolean) {
      const ctx = setup(followsByItself);
      ctx.field.focus();
      ctx.doc.fire("keydown", { target: ctx.field });
      ctx.field.isConnected = false;
      ctx.doc.activeElement = ctx.body;
      return ctx;
    }

    it("follows to the page's new field, also on a touch device", () => {
      const { doc, field, follower } = stranded(false);
      field.isConnected = true; // The new field: id 5 now names it.
      field.focus.mockClear();
      doc.activeElement = null;
      follower.remoteFocus({ id: 5, editable: true });
      expect(field.focus).toHaveBeenCalledOnce();
    });

    it("follows on a desktop even when the mirror lost its focus with the field", () => {
      const { doc, field, follower } = stranded(true);
      field.isConnected = true;
      field.focus.mockClear();
      doc.focused = false;
      follower.remoteFocus({ id: 5, editable: true });
      expect(field.focus).toHaveBeenCalledOnce();
    });

    it("gives a phone no hidden field for one the mirror does not show", () => {
      const { hidden, follower } = stranded(false);
      follower.remoteFocus({ id: 99, editable: true });
      expect(hidden.focus).not.toHaveBeenCalled();
    });

    it("does not follow once the person pressed somewhere else", () => {
      const { doc, field, follower } = stranded(false);
      field.isConnected = true;
      field.focus.mockClear();
      doc.fire("pointerdown", {});
      doc.fire("pointerup", {});
      follower.remoteFocus({ id: 5, editable: true });
      expect(field.focus).not.toHaveBeenCalled();
    });
  });

  describe("when the page replaces the field someone is typing in, in one change", () => {
    /** A composer being typed in, removed with a new one just like it put in its place. */
    function replaced(followsByItself: boolean, label = "Write your prompt") {
      const ctx = setup(followsByItself);
      const make = (aria: string) => {
        const editor = new FakeElement("DIV", ctx.doc);
        editor.isContentEditable = true;
        editor.attributes.set("id", "composer");
        editor.attributes.set("aria-label", aria);
        return editor;
      };
      const old = make("Write your prompt");
      const next = make(label);
      ctx.doc.fields = [old, next];
      old.focus();
      ctx.doc.fire("keydown", { target: old });
      old.isConnected = false;
      ctx.doc.activeElement = ctx.body;
      ctx.doc.fire("focusout", { target: old, relatedTarget: null });
      return { ...ctx, next };
    }

    it("focuses the new one at once, with the caret at its end, also on a phone", async () => {
      for (const followsByItself of [true, false]) {
        const { doc, next } = replaced(followsByItself);
        await Promise.resolve();
        expect(next.focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(doc.activeElement).toBe(next);
        expect(doc.selection.collapseToEnd).toHaveBeenCalled();
      }
    });

    it("leaves a field that does not look the same alone", async () => {
      const { next } = replaced(true, "Search");
      await Promise.resolve();
      expect(next.focus).not.toHaveBeenCalled();
    });
  });

  it("detects desktops", () => {
    const view = (ua: string, coarse: boolean) =>
      ({
        navigator: { userAgent: ua },
        matchMedia: () => ({ matches: coarse }),
      }) as unknown as Window;
    expect(followsFocusByItself(view("Mozilla/5.0 (X11; Linux x86_64)", false))).toBe(true);
    expect(followsFocusByItself(view("Mozilla/5.0 (iPhone) Mobile", false))).toBe(false);
    expect(followsFocusByItself(view("Mozilla/5.0 (X11; Linux x86_64)", true))).toBe(false);
  });
});

describe("typing outside any mirror field", () => {
  function capture(remoteEditable: boolean | null) {
    const ctx = setup();
    const sent: Up[] = [];
    if (remoteEditable !== null) {
      ctx.doc.focused = false; // Only the key routes; nothing moved by itself.
      ctx.follower.remoteFocus({ id: remoteEditable ? 99 : 1, editable: remoteEditable });
    }
    attachKeyCapture({
      doc: ctx.doc as unknown as Document,
      tab: "T1",
      getNodeId: () => 1,
      send: (message) => sent.push(message),
      routeTyping: ctx.follower.routeTyping,
    });
    return { ...ctx, sent };
  }

  it("keeps single-key shortcuts raw when the remote page has no field focused", () => {
    const { body, sent, hidden } = capture(false);
    const event = key(body, "j");
    (body.doc as FakeDocument).fire("keydown", event);
    expect(sent).toMatchObject([{ t: "key", kind: "down", key: "j" }]);
    expect(hidden.focus).not.toHaveBeenCalled();
  });

  it("routes letters and IME keys to where the remote page types", () => {
    const { body, doc, sent, hidden } = capture(true);
    doc.fire("keydown", key(body, "Process", { keyCode: 229 }));
    expect(hidden.focus).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    doc.fire("keyup", key(body, "Process", { code: "Process", keyCode: 229 }));
    expect(sent).toEqual([]);
  });

  it("leaves shortcuts with modifiers and non-text keys alone", () => {
    const { body, doc, sent, hidden } = capture(true);
    doc.fire("keydown", key(body, "c", { ctrlKey: true }));
    doc.fire("keydown", key(body, "ArrowDown"));
    expect(hidden.focus).not.toHaveBeenCalled();
    expect(sent).toMatchObject([{ key: "ArrowDown" }]);
  });

  it("classifies typing keys", () => {
    expect(typesText(key(new FakeElement("DIV", new FakeDocument()), "中"))).toBe(true);
    expect(typesText(key(new FakeElement("DIV", new FakeDocument()), "Enter"))).toBe(false);
    expect(typesText(key(new FakeElement("DIV", new FakeDocument()), "a", { altKey: true }))).toBe(
      false,
    );
  });
});
