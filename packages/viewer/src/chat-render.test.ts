// @vitest-environment node
import { describe, expect, it } from "vitest";
import { tokenizeChatText } from "./chat-render";

describe("native chat formulas", () => {
  it("recognizes inline and display delimiters in Chinese text", () => {
    expect(
      tokenizeChatText(String.raw`分析 $E=mc^2$ 和 $\alpha+\beta$，公式 $$\frac{1}{2}$$。`),
    ).toEqual([
      { kind: "text", value: "分析 " },
      { kind: "inline", value: "E=mc^2" },
      { kind: "text", value: " 和 " },
      { kind: "inline", value: String.raw`\alpha+\beta` },
      { kind: "text", value: "，公式 " },
      { kind: "block", value: String.raw`\frac{1}{2}` },
      { kind: "text", value: "。" },
    ]);
    // The gateway escapes brackets in text, so this is a citation and no formula.
    expect(tokenizeChatText(String.raw`见 \[7\]\[8\]。`)).toEqual([
      { kind: "text", value: String.raw`见 \[7\]\[8\]。` },
    ]);
    expect(tokenizeChatText(String.raw`$$x^2+y^2=1$$`)).toEqual([
      { kind: "block", value: "x^2+y^2=1" },
    ]);
  });
  it("preserves partial streaming, escaped dollars, currency and code", () => {
    for (const text of [
      "正在输出 $$\\frac{1}{",
      String.raw`价格 \$20 和 $30`,
      "费用 $20和$30",
      "前文 $ x $ 后文",
    ]) {
      expect(tokenizeChatText(text)).toEqual([{ kind: "text", value: text }]);
    }
    expect(tokenizeChatText("`$literal$` 与 $x$")).toEqual([
      { kind: "code", value: "$literal$" },
      { kind: "text", value: " 与 " },
      { kind: "inline", value: "x" },
    ]);
  });
});
