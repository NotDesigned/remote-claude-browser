// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { editHash, type Up } from "@mirror/protocol";
import { createPredictOverlay, createProxyLab } from "./predict-overlay";
import { BLUR_GRACE_MS, createProxyInput, proxyWindow, WINDOW_BEFORE } from "./proxy-input";
import { FakeDocument, FakeElement, fakeEvent, typeInto } from "./proxy-test-dom";
import type { SettledAck } from "./input-seq";

function setup() {
  const doc = new FakeDocument();
  const replayField = new FakeElement("div", doc);
  replayField.isContentEditable = true;
  replayField.setAttribute("contenteditable", "true");
  replayField.textContent = "";
  const replayText = { value: "" };
  // A contenteditable replay field: its text is one text node.
  Object.defineProperty(replayField, "childNodes", {
    get: () => [{ nodeType: 3, nodeName: "#text", textContent: replayText.value, childNodes: [] }],
  });
  const password = new FakeElement("input", doc);
  password.type = "password";
  const sent: Up[] = [];
  let stamped = 0;
  let settled = 0;
  const lab = createProxyLab();
  const timers: Array<() => void> = [];
  const overlay = createPredictOverlay({
    doc: doc as never,
    node: (id) => (id === 7 ? replayField : id === 8 ? password : null) as never,
    rtt: () => 100,
    lab,
    measure: { caret: () => null, rects: () => [] },
  });
  const proxy = createProxyInput({
    doc: doc as never,
    tab: () => "t",
    send: (message) => {
      if ("iseq" in message) throw new Error("the socket stamps");
      sent.push(message);
      stamped += 1;
      return true;
    },
    lastStamped: () => stamped,
    outstanding: () => stamped - settled,
    overlay,
    node: (id) => (id === 7 ? replayField : id === 8 ? password : null) as never,
    idOf: (node) => (node === (replayField as never) ? 7 : node === (password as never) ? 8 : -1),
    lab,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: (timer) => {
      timers[(timer as number) - 1] = () => undefined;
    },
  });
  proxy.remoteFocus({ id: 7, editable: true });
  proxy.focus();
  const settle = (text: string, sel = text.length, extra: Partial<SettledAck> = {}) => {
    settled = stamped;
    proxy.settled({
      tab: "t",
      iseq: stamped,
      mode: "page",
      edit: { node: 7, len: text.length, hash: editHash(text), sel: [sel, sel] },
      failed: [],
      failedValue: false,
      final: true,
      ...extra,
    });
  };
  return {
    doc,
    proxy,
    overlay,
    sent,
    lab,
    replayText,
    replayField,
    password,
    settle,
    timers,
    field: () => proxy.element as unknown as FakeElement,
  };
}

const key = (k: string, code = `Key${k.toUpperCase()}`, init: Record<string, unknown> = {}) =>
  fakeEvent("keydown", { key: k, code, keyCode: 65, ...init });

describe("proxy input", () => {
  it("is a focused field in the viewer document, outside the replay", () => {
    const { doc, field } = setup();
    expect(doc.activeElement).toBe(field());
    expect(field().tagName).toBe("TEXTAREA");
    expect(field().getAttribute("data-proxy-input")).toBe("true");
    expect(field().style.opacity).toBe("0");
    expect(field().style.fontSize).toBe("16px");
  });

  it("sends a typed key as that key with its text, and predicts it", () => {
    const { field, sent, overlay } = setup();
    const down = field().emit(key("a"));
    expect(down.defaultPrevented).toBe(false);
    typeInto(field(), "a");
    expect(sent).toEqual([
      { t: "key", tab: "t", kind: "down", key: "a", code: "KeyA", mods: 0, text: "a" },
      { t: "key", tab: "t", kind: "up", key: "a", code: "KeyA", mods: 0 },
    ]);
    expect(overlay.pending()).toBe(1);
    expect(overlay.state().chip).toBe("a");
  });

  it("sends a soft keyboard's text, with no key, as text", () => {
    const { field, sent } = setup();
    typeInto(field(), "hello ");
    expect(sent).toEqual([{ t: "text", tab: "t", insert: "hello " }]);
  });

  it("sends nothing while an IME composes and the commit once", () => {
    const { field, sent, overlay } = setup();
    field().emit(fakeEvent("compositionstart", { data: "" }));
    field().value = "ni";
    field().emit(fakeEvent("compositionupdate", { data: "ni" }));
    field().emit(fakeEvent("input", { isComposing: true, data: "ni" }));
    expect(sent).toEqual([]);
    expect(overlay.state().chip).toBe("ni");
    typeInto(field(), "你好", 2, { isComposing: true, data: "你好" });
    field().emit(fakeEvent("compositionend", { data: "你好" }));
    expect(sent).toEqual([{ t: "text", tab: "t", insert: "你好" }]);
    // Chromium's input after compositionend repeats it: nothing more goes.
    typeInto(field(), "你好", 2, { inputType: "insertText", data: "你好" });
    expect(sent).toHaveLength(1);
  });

  it("ignores an untrusted compositionend that is not the trusted preedit", () => {
    const { field, sent } = setup();
    field().emit(fakeEvent("compositionstart", { data: "" }));
    field().emit(fakeEvent("compositionupdate", { data: "ni" }));
    field().value = "evil";
    field().emit(fakeEvent("compositionend", { data: "evil", isTrusted: false }));
    expect(sent).toEqual([]);
  });

  it("sends Enter as a key with what the page will hold, and keeps the newline out", () => {
    const { field, sent } = setup();
    typeInto(field(), "hi");
    sent.length = 0;
    const enter = field().emit(fakeEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13 }));
    expect(enter.defaultPrevented).toBe(true);
    expect(sent[0]).toMatchObject({
      t: "key",
      kind: "down",
      key: "Enter",
      expect: { node: 7, len: 2, hash: editHash("hi") },
    });
    field().emit(fakeEvent("keyup", { key: "Enter", code: "Enter" }));
    expect(sent[1]).toMatchObject({ t: "key", kind: "up", key: "Enter" });
    expect(field().value).toBe("hi");
  });

  it("sends Shift+Enter with its modifier", () => {
    const { field, sent } = setup();
    field().emit(fakeEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true }));
    expect(sent[0]).toMatchObject({ key: "Enter", mods: 8 });
  });

  it("sends a soft keyboard's Return (a line break with no key) as Enter", () => {
    const { field, sent } = setup();
    const event = field().emit(fakeEvent("beforeinput", { inputType: "insertLineBreak" }));
    expect(event.defaultPrevented).toBe(true);
    expect(sent.map((message) => message.t === "key" && `${message.kind} ${message.key}`)).toEqual([
      "down Enter",
      "up Enter",
    ]);
  });

  it("plans a Backspace the proxy did, and forwards one it cannot do", () => {
    const { field, sent } = setup();
    typeInto(field(), "ab");
    sent.length = 0;
    expect(field().emit(key("Backspace", "Backspace")).defaultPrevented).toBe(false);
    typeInto(field(), "a", 1, { inputType: "deleteContentBackward" });
    expect(sent.map((message) => message.t === "key" && `${message.kind} ${message.key}`)).toEqual([
      "down Backspace",
      "up Backspace",
    ]);
    sent.length = 0;
    field().value = "";
    field().setSelectionRange(0, 0);
    expect(field().emit(key("Backspace", "Backspace")).defaultPrevented).toBe(true);
    expect(sent).toMatchObject([{ t: "key", kind: "down", key: "Backspace" }]);
  });

  it("forwards arrows and shortcuts as keys and moves its own caret with an arrow", () => {
    const { field, sent } = setup();
    typeInto(field(), "abc");
    sent.length = 0;
    expect(field().emit(key("ArrowLeft", "ArrowLeft")).defaultPrevented).toBe(true);
    expect(field().selectionStart).toBe(2);
    expect(field().emit(key("a", "KeyA", { ctrlKey: true })).defaultPrevented).toBe(true);
    expect(sent.map((message) => message.t === "key" && message.key)).toEqual(["ArrowLeft", "a"]);
  });

  it("deletes in the middle of a word after an arrow, as the page's caret is there", () => {
    const { field, sent } = setup();
    typeInto(field(), "abcdef");
    sent.length = 0;
    for (let index = 0; index < 3; index++) field().emit(key("ArrowLeft", "ArrowLeft"));
    typeInto(field(), "abdef", 2, { inputType: "deleteContentBackward" });
    expect(sent.filter((message) => message.t === "key" && message.kind === "down")).toMatchObject([
      { key: "ArrowLeft" },
      { key: "ArrowLeft" },
      { key: "ArrowLeft" },
      { key: "Backspace" },
    ]);
  });

  it("becomes a password field for a password, with corrections off", () => {
    const { proxy, field, doc } = setup();
    proxy.remoteFocus({ id: 8, editable: true, password: true });
    expect(field().tagName).toBe("INPUT");
    expect(field().type).toBe("password");
    expect(doc.activeElement).toBe(field());
    expect(field().getAttribute("autocorrect")).toBe("off");
    expect(field().getAttribute("autocapitalize")).toBe("off");
    expect(field().getAttribute("spellcheck")).toBe("false");
  });

  it("follows a pressed password field before the page reports its focus", () => {
    const { proxy, overlay, field, password } = setup();
    proxy.pressed(password as never);
    expect(field().type).toBe("password");
    expect(overlay.target()).toEqual({ nodeId: 8, password: true });
  });

  it("mirrors the replay field's keyboard settings", () => {
    const { proxy, field, replayField } = setup();
    replayField.setAttribute("autocorrect", "off");
    replayField.setAttribute("inputmode", "email");
    replayField.setAttribute("enterkeyhint", "send");
    proxy.focus();
    expect(field().getAttribute("autocorrect")).toBe("off");
    expect(field().getAttribute("autocapitalize")).toBe("sentences");
    expect(field().getAttribute("inputmode")).toBe("email");
    expect(field().getAttribute("enterkeyhint")).toBe("send");
  });

  it("reseeds from the replay only when nothing is on its way", () => {
    const { proxy, field, replayText, settle } = setup();
    typeInto(field(), "hello");
    // The page cleared its composer after sending; the ack says so and the replay shows it.
    replayText.value = "";
    settle("");
    expect(field().value).toBe("");
    typeInto(field(), "x");
    replayText.value = "zzz";
    // "x" is not acknowledged yet: the replay's text does not replace it.
    proxy.replayApplied();
    expect(field().value).toBe("x");
  });

  it("writes the window around the caret, cut at a line", () => {
    const text = `${"a".repeat(100)}\nline two ${"b".repeat(80)}`;
    const window = proxyWindow(text, 121, 121);
    expect(window.value.startsWith("line two")).toBe(true);
    expect(window.start).toBe(101);
    expect(window.selStart).toBe(20);
    const long = "c".repeat(300);
    const cut = proxyWindow(long, 200, 200);
    expect(cut.value.length).toBe(WINDOW_BEFORE + 32);
  });

  it("blurs only after a grace when the page has no field focused", () => {
    const { proxy, doc, field, timers } = setup();
    proxy.remoteFocus({ id: 3, editable: false });
    expect(doc.activeElement).toBe(field());
    proxy.remoteFocus({ id: 7, editable: true });
    timers.forEach((run) => run());
    expect(doc.activeElement).toBe(field());
    proxy.remoteFocus({ id: 3, editable: false });
    timers.forEach((run) => run());
    expect(doc.activeElement).toBe(null);
    expect(BLUR_GRACE_MS).toBe(300);
  });

  it("counts a blur nobody asked for", () => {
    const { field, lab } = setup();
    field().blur();
    expect(lab.blurs).toBe(1);
  });

  it("commits an open composition on flush, once", () => {
    const { proxy, field, sent } = setup();
    field().emit(fakeEvent("compositionstart", { data: "" }));
    field().value = "wor";
    field().setSelectionRange(3, 3);
    field().emit(fakeEvent("compositionupdate", { data: "wor" }));
    proxy.flush();
    expect(sent).toEqual([{ t: "text", tab: "t", insert: "wor" }]);
    field().emit(fakeEvent("compositionend", { data: "wor" }));
    expect(sent).toHaveLength(1);
  });

  it("puts undelivered text back for the next edit to send", () => {
    const { proxy, field, sent } = setup();
    proxy.putBack("lost");
    expect(field().value).toBe("lost");
    expect(sent).toEqual([]);
    typeInto(field(), "lost!");
    expect(sent).toEqual([{ t: "text", tab: "t", insert: "lost!" }]);
  });

  it("releases forwarded keys on dispose", () => {
    const { proxy, field, sent } = setup();
    field().emit(key("ArrowUp", "ArrowUp"));
    proxy.dispose();
    expect(sent.at(-1)).toMatchObject({ t: "key", kind: "up", key: "ArrowUp" });
    vi.restoreAllMocks();
  });
});
