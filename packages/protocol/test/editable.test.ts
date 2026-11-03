import { describe, expect, it } from "vitest";
import { editableText, type EditableTextNode } from "../src/editable";

const text = (value: string): EditableTextNode => ({
  nodeType: 3,
  nodeName: "#text",
  textContent: value,
  childNodes: [],
});
const element = (name: string, ...children: EditableTextNode[]): EditableTextNode => ({
  nodeType: 1,
  nodeName: name,
  textContent: null,
  childNodes: children,
});

describe("contenteditable text contract", () => {
  it("reads native divs and editor paragraphs identically", () => {
    const native = element("DIV", text("分析AI问题"), element("DIV", text("第二行😃")));
    const editor = element("DIV", element("P", text("分析AI问题")), element("P", text("第二行😃")));
    expect(editableText(native)).toBe("分析AI问题\n第二行😃");
    expect(editableText(editor)).toBe(editableText(native));
  });
  it("retains blank paragraphs and ignores the editor caret placeholder", () => {
    expect(
      editableText(
        element(
          "DIV",
          element("P", text("前")),
          element("P", element("BR")),
          element("P", text("后")),
        ),
      ),
    ).toBe("前\n\n后");
    const placeholder = { ...element("BR"), getAttribute: () => "ProseMirror-trailingBreak" };
    expect(
      editableText(
        element("DIV", element("P", text("前"), element("BR"), text("后"), placeholder)),
      ),
    ).toBe("前\n后");
    expect(editableText(element("DIV", element("P", placeholder)))).toBe("");
  });
});
