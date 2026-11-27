import { describe, expect, it } from "vitest";
import {
  editableOffset,
  editablePoint,
  editableText,
  type EditableTextNode,
} from "../src/editable";

const node = (
  nodeType: number,
  nodeName: string,
  textContent: string | null,
  childNodes: EditableTextNode[] = [],
  className?: string,
): EditableTextNode => ({
  nodeType,
  nodeName,
  textContent,
  childNodes,
  getAttribute: (name) => (name === "class" ? (className ?? null) : null),
});
const text = (value: string) => node(3, "#text", value);
const el = (name: string, ...children: EditableTextNode[]) => node(1, name, null, children);
const trailing = () => node(1, "BR", null, [], "ProseMirror-trailingBreak");

/** Every offset of the text maps to a point and back to itself. */
const roundTrips = (root: EditableTextNode) => {
  const flat = editableText(root);
  for (let at = 0; at <= flat.length; at++) {
    const point = editablePoint(root, at);
    expect(point, `offset ${at} of ${JSON.stringify(flat)}`).not.toBeNull();
    expect(editableOffset(root, point!.container, point!.offset)).toBe(at);
  }
  expect(editablePoint(root, flat.length + 1)).toBeNull();
  expect(editablePoint(root, -1)).toBeNull();
};

describe("editablePoint, the inverse of editableOffset", () => {
  it("round-trips plain text", () => roundTrips(el("DIV", text("hello world"))));

  it("round-trips several paragraphs, preferring text nodes", () => {
    const first = text("hello");
    const second = text("world");
    const root = el("DIV", el("P", first), el("P", second, trailing()));
    roundTrips(root);
    expect(editablePoint(root, 5)).toEqual({ container: first, offset: 5 });
    expect(editablePoint(root, 6)).toEqual({ container: second, offset: 0 });
  });

  it("round-trips a ProseMirror trailing break and an empty paragraph", () => {
    const empty = el("P", trailing());
    const root = el("DIV", el("P", text("ab")), empty);
    roundTrips(root);
    expect(editablePoint(root, 3)).toEqual({ container: empty, offset: 0 });
  });

  it("round-trips an empty editor", () => {
    const empty = el("P", trailing());
    const root = el("DIV", empty);
    roundTrips(root);
    expect(editablePoint(root, 0)?.container).toBe(empty);
  });

  it("round-trips NBSP, emoji surrogates and ZWJ sequences", () => {
    roundTrips(el("DIV", el("P", text("a b 😀 👩‍👩‍👧 end"))));
  });

  it("round-trips a BR line break and nested blocks", () => {
    roundTrips(
      el(
        "DIV",
        el("P", text("one"), el("STRONG", text("two"))),
        el("P", el("BR")),
        el("DIV", text("three"), el("BR"), text("four")),
        el("UL", el("LI", text("five"))),
        el("BLOCKQUOTE", el("P", text("deep"))),
      ),
    );
  });

  it("round-trips a line break with no text after it", () => {
    roundTrips(el("DIV", text("x"), el("BR")));
  });
});
