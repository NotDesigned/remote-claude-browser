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
    clickedElsewhere: () => calls.push("released"),
    pointer: (field, press) =>
      calls.push(
        `pointer ${press.phase} ${field.tagName} ${press.clientX},${press.clientY} ${press.detail}${
          press.shift ? " shift" : ""
        }`,
      ),
    toViewer: (point) => ({ clientX: point.clientX * 2 + 1, clientY: point.clientY * 2 + 1 }),
  });
  const fire = (type: string, target: FakeElement, init: Record<string, unknown> = {}) =>
    doc.emit(fakeEvent(type, { target, button: 0, clientX: 5, clientY: 6, ...init }));
  return { doc, composer, paragraph, textarea, button, checkbox, calls, state, detach, fire };
}

describe("read-only replay fields", () => {
  it("keeps a press on a text field from focusing it and focuses the proxy at the point", () => {
    const { paragraph, calls, fire } = setup();
    const event = fire("mousedown", paragraph, { detail: 1 });
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual(["flush", "pressed DIV", "focus 11,13", "pointer down DIV 5,6 1"]);
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

  it("lets the proxy go of its text on a click elsewhere, never on a text field", () => {
    const { button, textarea, calls, fire } = setup();
    fire("click", textarea);
    expect(calls).toEqual([]);
    fire("click", button);
    expect(calls).toEqual(["released"]);
  });

  it("hands a press, its drag and its release in a field to the proxy, Shift and clicks too", () => {
    const { paragraph, button, calls, fire, doc } = setup();
    fire("mousedown", paragraph, { detail: 2, shiftKey: true });
    calls.length = 0;
    // The drag may leave the field: it still extends the selection there.
    fire("mousemove", button, { buttons: 1, clientX: 40, detail: 0 });
    fire("mouseup", button, { clientX: 41, detail: 0 });
    fire("mousemove", paragraph, { buttons: 0 });
    expect(calls).toEqual(["pointer move DIV 40,6 0", "pointer up DIV 41,6 0"]);
    expect(doc).toBeDefined();
  });

  it("places the caret on a tap, not on a long press or a swipe", () => {
    const { textarea, calls, fire } = setup();
    const tap = (from: { x: number; y: number }, to: { x: number; y: number }, ms: number) => {
      fire("touchstart", textarea, {
        touches: [{ clientX: from.x, clientY: from.y }],
        timeStamp: 0,
      });
      fire("touchend", textarea, {
        changedTouches: [{ clientX: to.x, clientY: to.y }],
        timeStamp: ms,
      });
    };
    tap({ x: 1, y: 2 }, { x: 2, y: 2 }, 100);
    expect(calls.filter((call) => call.startsWith("pointer"))).toEqual([
      "pointer down TEXTAREA 2,2 1",
      "pointer up TEXTAREA 2,2 1",
    ]);
    calls.length = 0;
    tap({ x: 1, y: 2 }, { x: 1, y: 2 }, 900);
    tap({ x: 1, y: 2 }, { x: 60, y: 2 }, 100);
    expect(calls.filter((call) => call.startsWith("pointer"))).toEqual([]);
  });

  it("leaves a tap's compatibility mouse press to touchend", () => {
    const { textarea, calls, fire } = setup();
    fire("mousedown", textarea, { sourceCapabilities: { firesTouchEvents: true } });
    expect(calls.filter((call) => call.startsWith("pointer"))).toEqual([]);
  });

  it("finds the field around a target", () => {
    const { paragraph, composer, button } = setup();
    expect(textFieldOf(paragraph as never)).toBe(composer);
    expect(textFieldOf(button as never)).toBe(null);
    expect(textFieldOf(null)).toBe(null);
  });
});
