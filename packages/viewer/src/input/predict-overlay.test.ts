// @vitest-environment node
import { describe, expect, it } from "vitest";
import { editHash } from "@mirror/protocol";
import type { SettledAck } from "./input-seq";
import {
  createPredictOverlay,
  createProxyLab,
  type PendingEdit,
  type PredictOverlay,
} from "./predict-overlay";
import type { CaretBox } from "./caret";
import { FakeDocument, FakeElement } from "./proxy-test-dom";

const box: CaretBox = {
  left: 10,
  top: 20,
  height: 18,
  box: { left: 0, top: 20, right: 300, bottom: 60 },
  scale: 1,
};

function setup(
  options: { caret?: CaretBox | null; password?: boolean; time?: { now: number } } = {},
) {
  const doc = new FakeDocument();
  const field = new FakeElement("textarea", doc);
  field.value = "ab";
  const lab = createProxyLab();
  const time = options.time ?? { now: 0 };
  const overlay = createPredictOverlay({
    doc: doc as never,
    node: (id) => (id === 7 ? (field as never) : null),
    rtt: () => 100,
    now: () => time.now,
    lab,
    measure: {
      caret: () => (options.caret === undefined ? box : options.caret),
      rects: () => [],
    },
  });
  overlay.setTarget({ nodeId: 7, password: options.password === true });
  return { doc, field, overlay, lab, time };
}

const typed = (text: string, iseq: number): PendingEdit => ({
  first: iseq,
  last: iseq + 1,
  ops: [{ t: "char", text }],
  iseqs: [iseq],
  text,
});

const pageAck = (iseq: number, text: string, extra: Partial<SettledAck> = {}): SettledAck => ({
  tab: "t",
  iseq,
  mode: "page",
  fenced: true,
  edit: { node: 7, len: text.length, hash: editHash(text), sel: [text.length, text.length] },
  failed: [],
  failedValue: false,
  final: true,
  ...extra,
});

const shown = (overlay: PredictOverlay) => overlay.state().text;

describe("prediction overlay", () => {
  it("draws typed text at the caret until its ack settles, and drops it in the same callback", () => {
    const { field, overlay } = setup();
    overlay.push(typed("c", 3));
    expect(shown(overlay)).toBe("c");
    expect(overlay.state().shown).toEqual([3]);
    // The page's change and the ack's marker arrive together: no frame shows both.
    field.value = "abc";
    overlay.settled(pageAck(4, "abc"));
    expect(overlay.pending()).toBe(0);
    expect(overlay.state().shown).toEqual([]);
    expect(shown(overlay)).toBe("");
  });

  it("does not draw an edit the replay already shows, before its ack", () => {
    const { field, overlay } = setup();
    overlay.push(typed("c", 3));
    overlay.push(typed("d", 5));
    field.value = "abc";
    overlay.render();
    expect(shown(overlay)).toBe("d");
    expect(overlay.state().shown).toEqual([5]);
    expect(overlay.pending()).toBe(2);
  });

  it("keeps the ops of an edit its ack did not cover yet", () => {
    const { field, overlay } = setup();
    overlay.push({
      first: 3,
      last: 6,
      ops: [
        { t: "press", key: "Backspace" },
        { t: "insert", text: "X" },
      ],
      iseqs: [3, 5],
      text: "X",
    });
    field.value = "a";
    overlay.settled(pageAck(4, "a", { final: false }));
    expect(overlay.pending()).toBe(1);
    expect(shown(overlay)).toBe("X");
    field.value = "aX";
    overlay.settled(pageAck(6, "aX"));
    expect(overlay.pending()).toBe(0);
  });

  it("never shows an op whose iseq is at or below the newest page ack", () => {
    const { field, overlay } = setup();
    for (let index = 0; index < 5; index++) overlay.push(typed("xyzuv"[index]!, 3 + 2 * index));
    field.value = "abxyz";
    overlay.settled(pageAck(8, "abxyz", { final: false }));
    const state = overlay.state();
    expect(state.shown.every((iseq) => iseq > state.settledPage)).toBe(true);
    expect(shown(overlay)).toBe("uv");
  });

  it("offers a failed edit in the chip and stops predicting it", () => {
    const { doc, overlay, lab } = setup();
    overlay.push(typed("c", 3));
    overlay.settled(pageAck(4, "ab", { failed: [3] }));
    expect(overlay.pending()).toBe(0);
    expect(lab.failed).toBe(1);
    const chip = doc.body.children[0]!.children.find(
      (child) => child.className === "proxy-undelivered",
    );
    expect(chip?.style.display).toBe("block");
    expect(chip?.children[0]?.textContent).toBe("未送达：c");
  });

  it("drops dispatch-only edits once the replay changes, or shows them late and then drops them", () => {
    const time = { now: 0 };
    const { doc, field, overlay, lab } = setup({ time });
    overlay.push(typed("c", 3));
    overlay.settled({ ...pageAck(4, "abc"), mode: "dispatch", edit: undefined });
    expect(overlay.pending()).toBe(1);
    field.value = "abc";
    doc.frame();
    expect(overlay.pending()).toBe(0);

    overlay.push(typed("d", 5));
    overlay.settled({ ...pageAck(6, "abcd"), mode: "dispatch", edit: undefined });
    // max(150, 2 RTT + 500) = 700 ms with no change in the replay: late for one frame.
    time.now = 701;
    doc.frame();
    expect(lab.late).toBe(1);
    expect(overlay.pending()).toBe(1);
    doc.frame();
    expect(overlay.pending()).toBe(0);
  });

  it("falls back to the chip where the caret cannot be measured", () => {
    const { overlay } = setup({ caret: null });
    overlay.push(typed("c", 3));
    expect(overlay.state().chip).toBe("c");
  });

  it("draws a password as dots only", () => {
    const { overlay } = setup({ password: true });
    overlay.push(typed("s", 3));
    overlay.preedit("x");
    expect(shown(overlay)).toBe("••");
  });

  it("gives Enter the field as the page will hold it once every edit arrived", () => {
    const { field, overlay } = setup();
    overlay.push(typed("c", 3));
    expect(overlay.expectFor()).toMatchObject({ node: 7, len: 3, hash: editHash("abc") });
    field.value = "abc";
    overlay.push(typed("d", 5));
    expect(overlay.expectFor()).toMatchObject({ len: 4, hash: editHash("abcd") });
  });

  it("gives a password's Enter no hash", () => {
    const { overlay } = setup({ password: true });
    overlay.push(typed("s", 3));
    expect(overlay.expectFor()).toEqual({ node: 7, len: 3, hash: "", head: "" });
  });

  it("moves what was not acknowledged to the chip when the connection goes", () => {
    const { doc, overlay } = setup();
    overlay.push(typed("c", 3));
    overlay.connectionLost();
    expect(overlay.pending()).toBe(0);
    const chip = doc.body.children[0]!.children.find(
      (child) => child.className === "proxy-undelivered",
    );
    expect(chip?.children[0]?.textContent).toBe("可能未送达：c");
  });

  it("counts a page that made something else of the prediction", () => {
    const { field, overlay, lab } = setup();
    overlay.push(typed("-", 3));
    overlay.push(typed("-", 5));
    field.value = "ab—";
    overlay.settled(pageAck(6, "ab—"));
    expect(lab.hashMismatch).toBe(1);
    expect(overlay.pending()).toBe(0);
    expect(overlay.predicted()).toEqual({ text: "ab—", caret: 3, anchor: 3 });
  });
});

describe("prediction overlay: caret and selection", () => {
  /** A field whose offset n is at x = 10 + 8n; a prediction line whose offset n is at 500 + n. */
  function caretSetup(text: string) {
    const doc = new FakeDocument();
    const field = new FakeElement("textarea", doc);
    field.value = text;
    const overlay = createPredictOverlay({
      doc: doc as never,
      node: (id) => (id === 7 ? (field as never) : null),
      rtt: () => 100,
      measure: {
        caret: (_element, offset) => ({ ...box, left: 10 + 8 * offset }),
        rects: () => [],
        selection: (_element, from, to) =>
          [{ left: 10 + 8 * from, top: 20, width: 8 * (to - from), height: 18 }] as never,
        span: (_span, offset) => ({ left: 500 + offset, top: 20, height: 18 }),
      },
    });
    overlay.setTarget({ nodeId: 7, password: false });
    const layer = doc.body.children[0]!;
    const caret = layer.children.find((child) => child.className === "proxy-caret")!;
    const highlight = layer.children.find((child) => child.className === "proxy-selection")!;
    return { doc, field, overlay, caret, highlight };
  }
  const withSel = (iseq: number, text: string, sel: [number, number]) =>
    pageAck(iseq, text, {
      edit: { node: 7, len: text.length, hash: editHash(text), sel },
    });

  it("draws the caret only while the proxy has focus, in an empty field too", () => {
    const { overlay, caret } = caretSetup("");
    expect(caret.style.display).toBe("none");
    overlay.setFocused(true);
    expect(caret.style.display).toBe("block");
    // Centred on the caret, 2 px wide.
    expect(caret.style.left).toBe("9px");
    expect(caret.style.height).toBe("18px");
    overlay.setFocused(false);
    expect(caret.style.display).toBe("none");
    overlay.dispose();
  });

  it("follows the page's caret from its acks", () => {
    const { overlay, caret } = caretSetup("hello");
    overlay.setFocused(true);
    expect(caret.style.left).toBe(`${10 + 8 * 5 - 1}px`);
    overlay.settled(withSel(1, "hello", [2, 2]));
    expect(caret.style.left).toBe(`${10 + 8 * 2 - 1}px`);
    overlay.dispose();
  });

  it("puts the caret after predicted text while its ack is on its way", () => {
    const { overlay, caret } = caretSetup("ab");
    overlay.setFocused(true);
    overlay.push(typed("c", 3));
    expect(overlay.predicted()).toEqual({ text: "abc", caret: 3, anchor: 3 });
    expect(caret.style.left).toBe(`${501 - 1}px`);
    overlay.dispose();
  });

  it("highlights a selection with its text, without a caret, backward ones too", () => {
    const { overlay, caret, highlight } = caretSetup("hello");
    overlay.setFocused(true);
    overlay.settled(withSel(1, "hello", [4, 1]));
    expect(overlay.predicted()).toEqual({ text: "hello", caret: 1, anchor: 4 });
    expect(caret.style.display).toBe("none");
    expect(highlight.getAttribute("data-selected")).toBe("ell");
    expect(highlight.children).toHaveLength(1);
    expect(highlight.children[0]!.style.left).toBe(`${10 + 8}px`);
    expect(highlight.children[0]!.style.width).toBe(`${8 * 3}px`);
    overlay.dispose();
  });

  it("shows a predicted selection until the ack of its input, then the page's", () => {
    const { overlay, highlight, caret } = caretSetup("hello");
    overlay.setFocused(true);
    overlay.select(0, 5, 3);
    expect(highlight.getAttribute("data-selected")).toBe("hello");
    // A drag's next move for the same input replaces it.
    overlay.select(0, 2, 3);
    expect(overlay.pending()).toBe(1);
    expect(highlight.getAttribute("data-selected")).toBe("he");
    overlay.settled(withSel(3, "hello", [1, 1]));
    expect(overlay.pending()).toBe(0);
    expect(highlight.getAttribute("data-selected")).toBe("");
    expect(caret.style.left).toBe(`${10 + 8 - 1}px`);
    overlay.dispose();
  });

  it("predicts typing over a selection as replacing it", () => {
    const { overlay } = caretSetup("hello world");
    overlay.setFocused(true);
    overlay.select(6, 11, 3);
    overlay.push(typed("x", 4));
    expect(overlay.predicted()).toEqual({ text: "hello x", caret: 7, anchor: 7 });
    expect(overlay.state().visible).toBe("hello x");
    overlay.dispose();
  });

  it("hides the caret and the selection without a target", () => {
    const { overlay, caret, highlight } = caretSetup("hello");
    overlay.setFocused(true);
    overlay.select(0, 2, 3);
    overlay.setTarget(null);
    expect(caret.style.display).toBe("none");
    expect(highlight.children).toHaveLength(0);
    overlay.dispose();
  });
});
