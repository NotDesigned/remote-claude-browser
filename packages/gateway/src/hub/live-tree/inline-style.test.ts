import { describe, expect, it } from "vitest";
import { applyStyleDiff, declarationMap, parseDeclarations } from "./inline-style";

describe("inline style diff", () => {
  it("keeps semicolons inside quotes and url(data:...)", () => {
    const text =
      "background: url(data:image/png;base64,AAA;BBB) no-repeat; content: 'a;b'; color: red";
    expect(parseDeclarations(text).map((d) => [d.name, d.value])).toEqual([
      ["background", "url(data:image/png;base64,AAA;BBB) no-repeat"],
      ["content", "'a;b'"],
      ["color", "red"],
    ]);
    const { value, uncertain } = applyStyleDiff(text, { color: "blue" });
    expect(uncertain).toBe(false);
    expect(declarationMap(value).get("background")).toBe(
      "url(data:image/png;base64,AAA;BBB) no-repeat",
    );
    expect(declarationMap(value).get("content")).toBe("'a;b'");
    expect(declarationMap(value).get("color")).toBe("blue");
  });

  it("handles escapes and !important", () => {
    const text = 'font-family: "A\\"; B"; width: 10px !important';
    const parsed = parseDeclarations(text);
    expect(parsed).toEqual([
      { name: "font-family", value: '"A\\"; B"', important: false },
      { name: "width", value: "10px", important: true },
    ]);
    const result = applyStyleDiff(text, { width: ["20px", "important"], height: "3px" });
    expect(declarationMap(result.value)).toEqual(
      new Map([
        ["font-family", '"A\\"; B"'],
        ["width", "20px!important"],
        ["height", "3px"],
      ]),
    );
  });

  it("keeps custom properties case-sensitive and with nested parentheses", () => {
    const text = "--Accent: calc(var(--x, 1px) + 2px); color: var(--Accent)";
    const result = applyStyleDiff(text, { "--Accent": "4px", COLOR: false });
    expect(declarationMap(result.value)).toEqual(new Map([["--Accent", "4px"]]));
    expect(result.uncertain).toBe(false);
  });

  it("removing an absent property changes nothing", () => {
    const result = applyStyleDiff("color: red;", { opacity: false });
    expect(result).toEqual({ value: "color: red;", uncertain: false });
  });

  it("a set longhand wins over an earlier shorthand", () => {
    const result = applyStyleDiff("margin-top: 1px; margin: 0", { "margin-top": "5px" });
    const declarations = parseDeclarations(result.value);
    expect(declarations.at(-1)).toEqual({ name: "margin-top", value: "5px", important: false });
    expect(result.uncertain).toBe(false);
  });

  it("writes out a box shorthand to remove one of its longhands", () => {
    const result = applyStyleDiff("margin: 1px 2px; color: red", { "margin-top": false });
    expect(result.uncertain).toBe(false);
    expect(declarationMap(result.value)).toEqual(
      new Map([
        ["margin-right", "2px"],
        ["margin-bottom", "1px"],
        ["margin-left", "2px"],
        ["color", "red"],
      ]),
    );
    const inset = applyStyleDiff("inset: 0 calc(1px + 2px) 3px !important", { top: false });
    expect(declarationMap(inset.value)).toEqual(
      new Map([
        ["right", "calc(1px + 2px)!important"],
        ["bottom", "3px!important"],
        ["left", "calc(1px + 2px)!important"],
      ]),
    );
  });

  it("removing a longhand only another shorthand sets is uncertain and drops the shorthand", () => {
    const result = applyStyleDiff("font: 12px serif; color: red", { "font-size": false });
    expect(result.uncertain).toBe(true);
    expect(declarationMap(result.value)).toEqual(new Map([["color", "red"]]));
    const variable = applyStyleDiff("margin: var(--m)", { "margin-top": false });
    expect(variable.uncertain).toBe(true);
    expect(variable.value).toBe("");
  });
});
