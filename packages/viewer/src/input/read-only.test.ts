// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { attachReadOnly, textFieldOf } from "./read-only";
import { FakeDocument, FakeElement, fakeEvent } from "./proxy-test-dom";

function setup(active = true) {
  const doc = new FakeDocument();
  const composer = new FakeElement("div", doc);
  composer.isContentEditable = true;
  composer.setAttribute("contenteditable", "true");
  const paragraph = new FakeElement("p", doc);
  paragraph.isContentEditable = true;
  composer.appendChild(paragraph);
  const textarea = new FakeElement("textarea", doc);
  const button = new FakeElement("button", doc);
  const checkbox = new FakeElement("input", doc);
  checkbox.type = "checkbox";
  const calls: string[] = [];
  const focus = vi.fn((point?: { clientX: number; clientY: number }) =>
    calls.push(`focus ${point ? `${point.clientX},${point.clientY}` : "-"}`),
  );
  const state = { active };
  const detach = attachReadOnly({
    doc: doc as never,
    active: () => state.active,
    flush: () => calls.push("flush"),
    focus,
    pressed: (field) => calls.push(`pressed ${field.tagName}`),
    toViewer: (point) => ({ clientX: point.clientX * 2 + 1, clientY: point.clientY * 2 + 1 }),
  });
  const fire = (type: string, target: FakeElement, init: Record<string, unknown> = {}) =>
    doc.emit(fakeEvent(type, { target, button: 0, clientX: 5, clientY: 6, ...init }));
  return { doc, composer, paragraph, textarea, button, checkbox, calls, state, detach, fire };
}

describe("read-only replay fields", () => {
  it("keeps a press on a text field from focusing it and focuses the proxy at the point", () => {
    const { paragraph, calls, fire } = setup();
    const event = fire("mousedown", paragraph);
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual(["flush", "pressed DIV", "focus 11,13"]);
  });

  it("leaves presses elsewhere, and on value controls, alone", () => {
    const { button, checkbox, calls, fire } = setup();
    expect(fire("mousedown", button).defaultPrevented).toBe(false);
    expect(fire("mousedown", checkbox).defaultPrevented).toBe(false);
    expect(fire("mousedown", button, { button: 2 }).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it("focuses the proxy inside a tap's touchend, so a phone opens its keyboard", () => {
    const { textarea, calls, fire } = setup();
    const touch = { clientX: 1, clientY: 2 };
    const event = fire("touchend", textarea, { changedTouches: [touch] });
    expect(event.defaultPrevented).toBe(false);
    expect(calls).toEqual(["flush", "pressed TEXTAREA", "focus 3,5"]);
  });

  it("gives focus that reached a replay field anyway to the proxy", () => {
    const { textarea, calls, fire, doc } = setup();
    textarea.focus();
    fire("focusin", textarea);
    expect(doc.activeElement).toBe(null);
    expect(calls).toEqual(["focus -"]);
  });

  it("prevents what a field would do with text", () => {
    const { textarea, paragraph, fire } = setup();
    for (const type of ["beforeinput", "drop", "cut"]) {
      expect(fire(type, textarea).defaultPrevented).toBe(true);
      expect(fire(type, paragraph).defaultPrevented).toBe(true);
    }
  });

  it("does nothing while single-writer input is off, and after detaching", () => {
    const { textarea, calls, fire, state, detach } = setup(false);
    expect(fire("mousedown", textarea).defaultPrevented).toBe(false);
    expect(fire("beforeinput", textarea).defaultPrevented).toBe(false);
    state.active = true;
    detach();
    expect(fire("mousedown", textarea).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it("finds the field around a target", () => {
    const { paragraph, composer, button } = setup();
    expect(textFieldOf(paragraph as never)).toBe(composer);
    expect(textFieldOf(button as never)).toBe(null);
    expect(textFieldOf(null)).toBe(null);
  });
});
