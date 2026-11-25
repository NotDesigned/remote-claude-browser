// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Up } from "@mirror/protocol";
import { attachKeyCapture } from "./keys";

type Listener = (event: never) => void;
class FakeElement {
  readonly nodeType = 1;
  isContentEditable = false;
  parentElement = null;
  disabled = false;
  readOnly = false;
  type = "text";
  value = "";
  childNodes = [];
  constructor(readonly tagName: string) {}
  getAttribute() {
    return null;
  }
}
class FakeDocument {
  listeners = new Map<string, Set<Listener>>();
  activeElement: FakeElement | null = null;
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

const event = (target: FakeElement, key: string, extra: Record<string, unknown> = {}) => ({
  target,
  key,
  code: "",
  keyCode: 0,
  isTrusted: true,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  preventDefault: vi.fn(),
  ...extra,
});

function setup(tag = "INPUT") {
  const doc = new FakeDocument();
  const field = new FakeElement(tag);
  doc.activeElement = field;
  const sent: Up[] = [];
  const flush = vi.fn();
  attachKeyCapture({
    doc: doc as unknown as Document,
    tab: "T1",
    getNodeId: () => 4,
    send: (message) => sent.push(message),
    flushComposing: flush,
  });
  return { doc, field, sent, flush };
}
const enters = (sent: Up[]) =>
  sent.filter((m) => m.t === "key" && m.key === "Enter" && m.kind === "down");

describe("Enter from keyboards that send a 229 keydown", () => {
  it("sends Enter once from the keyup on a single-line field, after the field's text", () => {
    const { doc, field, sent, flush } = setup();
    doc.fire("keydown", event(field, "Unidentified", { keyCode: 229 }));
    doc.fire("keyup", event(field, "Enter", { keyCode: 13 }));
    expect(flush).toHaveBeenCalledWith(field, true);
    expect(sent.filter((m) => m.t === "key" && m.key === "Enter")).toMatchObject([
      { kind: "down", code: "Enter" },
      { kind: "up", code: "Enter" },
    ]);
  });

  it("does not send Enter that only confirmed an IME composition", () => {
    const { doc, field, sent } = setup();
    doc.fire("keydown", event(field, "Process", { keyCode: 229, isComposing: true }));
    doc.fire("compositionend", { target: field, data: "你好", isTrusted: true });
    doc.fire("keyup", event(field, "Enter", { keyCode: 13 }));
    expect(enters(sent)).toEqual([]);
  });

  it("does not double a proper Enter keydown", () => {
    const { doc, field, sent } = setup();
    doc.fire("keydown", event(field, "Unidentified", { keyCode: 229 }));
    doc.fire("keyup", event(field, "Unidentified", { keyCode: 229 }));
    doc.fire("keydown", event(field, "Enter", { code: "Enter", keyCode: 13 }));
    doc.fire("keyup", event(field, "Enter", { code: "Enter", keyCode: 13 }));
    expect(enters(sent)).toHaveLength(1);
  });

  it("leaves a textarea's line breaks to beforeinput", () => {
    const { doc, field, sent } = setup("TEXTAREA");
    doc.fire("keydown", event(field, "Unidentified", { keyCode: 229 }));
    doc.fire("keyup", event(field, "Enter", { keyCode: 13 }));
    expect(enters(sent)).toEqual([]);
  });
});
