// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_PRESSES,
  applyOps,
  commonEnds,
  graphemeCount,
  planEdit,
  type PlanOp,
  type ProxyState,
} from "./proxy-plan";

/** A state written with | for the caret, or [ ] around a selection. */
const s = (text: string): ProxyState => {
  const caret = text.indexOf("|");
  if (caret >= 0) {
    const value = text.slice(0, caret) + text.slice(caret + 1);
    return { value, selStart: caret, selEnd: caret };
  }
  const start = text.indexOf("[");
  const end = text.indexOf("]");
  if (start >= 0 && end > start) {
    const value = text.slice(0, start) + text.slice(start + 1, end) + text.slice(end + 1);
    return { value, selStart: start, selEnd: end - 1 };
  }
  return { value: text, selStart: text.length, selEnd: text.length };
};
const press = (key: "Backspace" | "Delete" | "ArrowLeft" | "ArrowRight", count = 1): PlanOp[] =>
  Array.from({ length: count }, () => ({ t: "press", key }) as const);
const insert = (text: string): PlanOp => ({ t: "insert", text });
const char = (text: string): PlanOp => ({ t: "char", text });

/** The page, starting where the proxy started, must end where the proxy ended. */
const replays = (prev: ProxyState, next: ProxyState, lastKey?: string) => {
  const ops = planEdit(prev, next, lastKey);
  expect(ops).not.toBe("fallback");
  const page = applyOps(
    { text: prev.value, caret: prev.selEnd, anchor: prev.selStart },
    ops as PlanOp[],
  );
  expect(page.text).toBe(next.value);
  expect(page.caret).toBe(Math.min(next.selEnd, next.value.length));
  return ops as PlanOp[];
};

describe("planEdit: typing", () => {
  it("does nothing when the text did not change", () => {
    expect(planEdit(s("abc|"), s("ab|c"))).toEqual([]);
  });
  it("types a key's character as that key", () => {
    expect(replays(s("ab|"), s("abc|"), "c")).toEqual([char("c")]);
  });
  it("types a space as a key", () => {
    expect(replays(s("ab|"), s("ab |"), " ")).toEqual([char(" ")]);
  });
  it("sends text that no key just typed as text", () => {
    expect(replays(s("ab|"), s("abc|"))).toEqual([insert("c")]);
  });
  it("sends a character other than the key pressed as text", () => {
    expect(replays(s("ab|"), s("abé|"), "e")).toEqual([insert("é")]);
  });
  it("sends several characters at once (a soft keyboard's word) as text", () => {
    expect(replays(s("say |"), s("say hello |"), "o")).toEqual([insert("hello ")]);
  });
  it("types at a caret in the middle", () => {
    expect(replays(s("a|c"), s("ab|c"), "b")).toEqual([char("b")]);
  });
  it("types into an empty field", () => {
    expect(replays(s("|"), s("x|"), "x")).toEqual([char("x")]);
  });
  it("commits a CJK composition as text", () => {
    expect(replays(s("pinyin |"), s("pinyin 你好|"))).toEqual([insert("你好")]);
  });
  it("commits mixed scripts", () => {
    expect(replays(s("a|"), s("a中文 and ascii|"))).toEqual([insert("中文 and ascii")]);
  });
  it("inserts an emoji as text", () => {
    expect(replays(s("smile |"), s("smile 😀|"))).toEqual([insert("😀")]);
  });
  it("inserts a ZWJ family as text", () => {
    expect(replays(s("|"), s("👩‍👩‍👧|"))).toEqual([insert("👩‍👩‍👧")]);
  });
  it("pastes several lines as text", () => {
    expect(replays(s("x|"), s("xline one\nline two|"))).toEqual([insert("line one\nline two")]);
  });
});

describe("planEdit: deleting", () => {
  it("deletes back with Backspace", () => {
    expect(replays(s("abc|"), s("ab|"))).toEqual(press("Backspace"));
  });
  it("deletes forward with Delete", () => {
    expect(replays(s("a|bc"), s("a|c"))).toEqual(press("Delete"));
  });
  it("deletes a whole word back as one Backspace per character", () => {
    expect(replays(s("one two|"), s("one |"))).toEqual(press("Backspace", 3));
  });
  it("deletes an emoji with one Backspace", () => {
    expect(replays(s("a😀|"), s("a|"))).toEqual(press("Backspace"));
  });
  it("deletes a ZWJ family with one Backspace", () => {
    expect(replays(s("a👩‍👩‍👧|"), s("a|"))).toEqual(press("Backspace"));
  });
  it("deletes a flag with one Delete", () => {
    expect(replays(s("|🇨🇳b"), s("|b"))).toEqual(press("Delete"));
  });
  it("deletes back in the middle of a word", () => {
    expect(replays(s("abc|def"), s("ab|def"))).toEqual(press("Backspace"));
  });
  it("deletes CJK characters back", () => {
    expect(replays(s("你好世界|"), s("你好|"))).toEqual(press("Backspace", 2));
  });
  it("deletes everything", () => {
    expect(replays(s("hello|"), s("|"))).toEqual(press("Backspace", 5));
  });
  it("deletes on both sides of the caret", () => {
    expect(replays(s("ab|cd"), s("a|d"))).toEqual([...press("Backspace"), ...press("Delete")]);
  });
});

describe("planEdit: replacing", () => {
  it("replaces an autocorrected word before the caret", () => {
    const ops = replays(s("fix teh |"), s("fix the |"));
    expect(ops).toEqual([...press("Backspace", 3), insert("he ")]);
  });
  it("replaces a word and leaves the caret where the keyboard left it", () => {
    replays(s("fix teh |"), s("fix the| "));
  });
  it("recomposes the previous word (Gboard)", () => {
    expect(replays(s("hello wrold|"), s("hello world|"))).toEqual([
      ...press("Backspace", 4),
      insert("orld"),
    ]);
  });
  it("replaces a word away from the caret and comes back", () => {
    replays(s("teh cat sat|"), s("the cat sat|"));
  });
  it("replaces after the caret", () => {
    replays(s("|ab xyz"), s("|ab xz"));
  });
  it("types over a selection the page has too", () => {
    expect(replays(s("a[bc]d"), s("ax|d"), "x")).toEqual([char("x")]);
  });
  it("deletes a selection with one Backspace", () => {
    expect(replays(s("a[bc]d"), s("a|d"))).toEqual(press("Backspace"));
  });
  it("selects all and types", () => {
    expect(replays(s("[hello]"), s("y|"), "y")).toEqual([char("y")]);
  });
  it("falls back when an edit starts outside the selection", () => {
    expect(planEdit(s("ab[cd]"), s("x|"))).toBe("fallback");
  });
  it("replaces a CJK word with another (IME reconversion)", () => {
    replays(s("我想去北京|"), s("我想去背景|"));
  });
  it("turns two dashes into one", () => {
    replays(s("a --|"), s("a —|"));
  });
  it("replaces mixed text with an emoji suggestion", () => {
    replays(s("love |"), s("❤️ |"));
  });
});

describe("planEdit: limits", () => {
  it("falls back for an edit more than the presses allowed from the caret", () => {
    const far = "x".repeat(MAX_PLAN_PRESSES + 5);
    expect(planEdit(s(`a${far}|`), s(`b${far}|`))).toBe("fallback");
  });
  it("allows an edit just within the presses allowed", () => {
    const near = "x".repeat(MAX_PLAN_PRESSES - 2);
    replays(s(`a${near}|`), s(`b${near}|`));
  });
  it("counts a long deletion as presses", () => {
    expect(planEdit(s(`${"y".repeat(MAX_PLAN_PRESSES + 1)}|`), s("|"))).toBe("fallback");
  });
  it("moves the caret when the proxy's caret moved with the edit", () => {
    expect(replays(s("ab|"), s("|abc"))).toEqual([insert("c"), ...press("ArrowLeft", 3)]);
  });
});

describe("helpers", () => {
  it("counts graphemes", () => {
    expect(graphemeCount("")).toBe(0);
    expect(graphemeCount("abc")).toBe(3);
    expect(graphemeCount("👩‍👩‍👧")).toBe(1);
    expect(graphemeCount("é")).toBe(1);
  });
  it("never splits a surrogate pair in the common ends", () => {
    expect(commonEnds("a😀", "a😃")).toEqual({ prefix: 1, suffix: 0 });
    expect(commonEnds("😀b", "😃b")).toEqual({ prefix: 0, suffix: 1 });
    expect(commonEnds("abc", "abc")).toEqual({ prefix: 3, suffix: 0 });
  });
  it("replaces, deletes or collapses a selection with the first op", () => {
    const state = { text: "abcd", caret: 3, anchor: 1 };
    expect(applyOps(state, [insert("x")])).toEqual({ text: "axd", caret: 2 });
    expect(applyOps(state, press("Backspace"))).toEqual({ text: "ad", caret: 1 });
    expect(applyOps(state, press("ArrowLeft"))).toEqual({ text: "abcd", caret: 1 });
  });
  it("applies presses per grapheme", () => {
    expect(applyOps({ text: "a😀b", caret: 3 }, press("Backspace"))).toEqual({
      text: "ab",
      caret: 1,
    });
    expect(applyOps({ text: "ab", caret: 0 }, press("ArrowRight", 5))).toEqual({
      text: "ab",
      caret: 2,
    });
  });
});
