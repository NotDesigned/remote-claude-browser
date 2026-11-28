// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  lineAt,
  moveSelection,
  platformOf,
  wordAt,
  wordStep,
  type CaretKey,
  type Sel,
} from "./caret-moves";

const key = (name: string, mods: Partial<CaretKey> = {}): CaretKey => ({
  key: name,
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  ...mods,
});
const at = (offset: number): Sel => ({ anchor: offset, head: offset });
const text = "hello big world\nsecond line";

describe("caret moves", () => {
  it("moves one grapheme with an arrow, an emoji at a time", () => {
    expect(moveSelection(text, at(11), key("ArrowLeft"), "other")).toEqual(at(10));
    expect(moveSelection(text, at(11), key("ArrowRight"), "other")).toEqual(at(12));
    expect(moveSelection("a😀b", at(3), key("ArrowLeft"), "other")).toEqual(at(1));
    expect(moveSelection(text, at(0), key("ArrowLeft"), "other")).toEqual(at(0));
  });

  it("collapses a selection to its start or end with a plain arrow", () => {
    const sel = { anchor: 10, head: 15 };
    expect(moveSelection(text, sel, key("ArrowLeft"), "other")).toEqual(at(10));
    expect(moveSelection(text, sel, key("ArrowRight"), "other")).toEqual(at(15));
  });

  it("extends from the anchor with Shift, either way", () => {
    expect(moveSelection(text, at(15), key("ArrowLeft", { shift: true }), "other")).toEqual({
      anchor: 15,
      head: 14,
    });
    expect(
      moveSelection(text, { anchor: 15, head: 10 }, key("ArrowLeft", { shift: true }), "other"),
    ).toEqual({ anchor: 15, head: 9 });
    expect(moveSelection(text, at(6), key("End", { shift: true }), "other")).toEqual({
      anchor: 6,
      head: 15,
    });
  });

  it("moves by words with Ctrl, or Alt on a Mac", () => {
    expect(moveSelection(text, at(15), key("ArrowLeft", { ctrl: true }), "other")).toEqual(at(10));
    expect(moveSelection(text, at(0), key("ArrowRight", { ctrl: true }), "other")).toEqual(at(5));
    expect(moveSelection(text, at(0), key("ArrowRight", { ctrl: true }), "windows")).toEqual(at(6));
    expect(moveSelection(text, at(15), key("ArrowLeft", { alt: true }), "mac")).toEqual(at(10));
    expect(wordStep(text, 5, true, "other")).toBe(9);
    // Alt+arrow is the browser's history elsewhere: not predicted.
    expect(moveSelection(text, at(15), key("ArrowLeft", { alt: true }), "other")).toBeNull();
  });

  it("goes to the line's ends with Home and End (Cmd+arrows on a Mac), the text's with Ctrl", () => {
    expect(moveSelection(text, at(20), key("Home"), "other")).toEqual(at(16));
    expect(moveSelection(text, at(3), key("End"), "other")).toEqual(at(15));
    expect(moveSelection(text, at(20), key("Home", { ctrl: true }), "other")).toEqual(at(0));
    expect(moveSelection(text, at(3), key("End", { ctrl: true }), "other")).toEqual(
      at(text.length),
    );
    expect(moveSelection(text, at(20), key("ArrowLeft", { meta: true }), "mac")).toEqual(at(16));
    expect(moveSelection(text, at(3), key("ArrowDown", { meta: true }), "mac")).toEqual(
      at(text.length),
    );
    // Home and End scroll on a Mac.
    expect(moveSelection(text, at(3), key("End"), "mac")).toBeNull();
  });

  it("moves a line up or down where the screen says, else by line breaks", () => {
    expect(moveSelection(text, at(3), key("ArrowDown"), "other", () => 7)).toEqual(at(7));
    expect(moveSelection(text, at(3), key("ArrowDown"), "other")).toEqual(at(19));
    expect(moveSelection(text, at(20), key("ArrowUp"), "other")).toEqual(at(4));
    expect(moveSelection(text, at(3), key("ArrowUp"), "other")).toEqual(at(0));
    expect(moveSelection(text, at(20), key("ArrowDown"), "other")).toEqual(at(text.length));
    expect(moveSelection(text, at(3), key("PageDown"), "other")).toBeNull();
  });

  it("selects a word on a double press and a line on a triple one", () => {
    expect(wordAt("hello very big", 7)).toEqual({ anchor: 6, head: 10 });
    expect(wordAt("hello very big", 10)).toEqual({ anchor: 6, head: 10 });
    expect(wordAt("hello very big", 0)).toEqual({ anchor: 0, head: 5 });
    expect(lineAt(text, 18)).toEqual({ anchor: 16, head: text.length });
    expect(lineAt(text, 4)).toEqual({ anchor: 0, head: 15 });
  });

  it("knows a Mac and Windows from the navigator", () => {
    expect(platformOf({ platform: "MacIntel" })).toBe("mac");
    expect(platformOf({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" })).toBe("mac");
    expect(platformOf({ platform: "Win32" })).toBe("windows");
    expect(platformOf({ platform: "Linux x86_64" })).toBe("other");
    expect(platformOf(undefined)).toBe("other");
  });
});
