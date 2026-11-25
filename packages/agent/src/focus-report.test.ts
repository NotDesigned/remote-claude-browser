// @vitest-environment node
import { describe, expect, it } from "vitest";
import { REMOTE_FOCUS_EVENT, type RemoteFocus } from "@mirror/protocol";
import { describeFocus, startFocusReport } from "./focus-report";

type Listener = () => void;
class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}
const element = (tagName: string, extra: Record<string, unknown> = {}) =>
  ({ tagName, ...extra }) as unknown as Element;

function setup(isTop = true) {
  const doc = Object.assign(new FakeTarget(), {
    activeElement: null as Element | null,
    body: element("BODY"),
    focused: true,
    hasFocus() {
      return this.focused;
    },
  });
  const win = Object.assign(new FakeTarget(), { document: doc });
  const ids = new Map<Element, number>([[doc.body, 1]]);
  const sent: RemoteFocus[] = [];
  const timers: Array<() => void> = [];
  const report = startFocusReport({
    window: win as unknown as Window,
    isTop,
    getId: (node) => ids.get(node as Element) ?? -1,
    emit: (tag, focus) => {
      expect(tag).toBe(REMOTE_FOCUS_EVENT);
      sent.push(focus);
    },
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => timers.splice(0),
  });
  const flush = () => {
    while (timers.length) timers.shift()!();
  };
  return { doc, ids, sent, flush, report };
}

describe("focus report", () => {
  it("reports a focused field once per change, debounced", () => {
    const { doc, ids, sent, flush } = setup();
    const field = element("TEXTAREA", { disabled: false, readOnly: false });
    ids.set(field, 7);
    doc.activeElement = field;
    doc.fire("focusin");
    doc.fire("focusout");
    doc.fire("focusin");
    flush();
    doc.fire("focusin");
    flush();
    expect(sent).toEqual([{ id: 7, editable: true }]);
    doc.activeElement = null;
    doc.fire("focusout");
    flush();
    expect(sent.at(-1)).toEqual({ id: 1, editable: false });
  });

  it("marks passwords and repeats the focus after a new snapshot", () => {
    const { doc, ids, sent, flush, report } = setup();
    const password = element("INPUT", { type: "password", disabled: false, readOnly: false });
    ids.set(password, 9);
    doc.activeElement = password;
    doc.fire("focusin");
    flush();
    report.snapshotTaken();
    flush();
    expect(sent).toEqual([
      { id: 9, editable: true, password: true },
      { id: 9, editable: true, password: true },
    ]);
  });

  it("leaves a cross-origin frame's focus to that frame, which speaks only while focused", () => {
    const top = setup();
    const frame = element("IFRAME", { contentDocument: null });
    top.ids.set(frame, 4);
    top.doc.activeElement = frame;
    top.doc.fire("focusin");
    top.flush();
    expect(top.sent).toEqual([]);

    const child = setup(false);
    const field = element("INPUT", { type: "email", disabled: false, readOnly: false });
    child.ids.set(field, 3);
    child.doc.activeElement = field;
    child.doc.focused = false;
    child.doc.fire("focusin");
    child.flush();
    expect(child.sent).toEqual([]);
    child.doc.focused = true;
    child.doc.fire("focusin");
    child.flush();
    expect(child.sent).toEqual([{ id: 3, editable: true }]);
  });

  it("describes what typing would do", () => {
    expect(describeFocus(element("INPUT", { type: "checkbox" })).editable).toBe(false);
    expect(describeFocus(element("INPUT", { type: "text", readOnly: true })).editable).toBe(false);
    expect(describeFocus(element("DIV", { isContentEditable: true })).editable).toBe(true);
    expect(describeFocus(null).editable).toBe(false);
  });
});
