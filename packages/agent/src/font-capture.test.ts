import { describe, expect, it, vi } from "vitest";
import { addFontsToSnapshot, encodeBase64, fontFaceRule, installFontCapture } from "./font-capture";

class FakeFontFace {
  constructor(
    readonly family: string,
    readonly source: unknown,
  ) {}
}

function fakeWindow() {
  const set = new Set<object>();
  class FakeFontFaceSet {
    add(face: object) {
      set.add(face);
      return this;
    }
  }
  return {
    FontFace: FakeFontFace,
    FontFaceSet: FakeFontFaceSet,
    location: { href: "https://frame.test/doc/page" },
    fonts: new FakeFontFaceSet(),
    set,
  };
}

describe("fontFaceRule", () => {
  it("writes the same font as a stylesheet rule", () => {
    expect(
      fontFaceRule({
        family: "Icons",
        source: 'url("https://a.test/i.woff2")',
        descriptors: { weight: "300 800", style: "normal", unicodeRange: "U+E000-F8FF" },
      }),
    ).toBe(
      '@font-face { font-family: "Icons"; src: url("https://a.test/i.woff2"); font-style: normal; font-weight: 300 800; unicode-range: U+E000-F8FF; }',
    );
  });

  it("embeds bytes, and keeps a quoted family name valid", () => {
    expect(fontFaceRule({ family: '"Fizzy Lake"', source: new Uint8Array([1, 2, 3]) })).toBe(
      '@font-face { font-family: "Fizzy Lake"; src: url("data:font/woff2;base64,AQID"); }',
    );
  });

  it("encodes more than one chunk", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 1).fill(65);
    expect(atob(encodeBase64(bytes))).toBe("A".repeat(bytes.length));
  });
});

describe("installFontCapture", () => {
  it("remembers only fonts added to the document, and copies their bytes", () => {
    const win = fakeWindow();
    const capture = installFontCapture(win as unknown as Window);
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    new win.FontFace("Unused", buffer);
    const face = new win.FontFace("Icons", buffer);
    expect(face).toBeInstanceOf(FakeFontFace);
    new Uint8Array(buffer).fill(0);
    win.fonts.add(face);
    expect(win.set.has(face)).toBe(true);
    expect(capture.css()).toBe(
      '@font-face { font-family: "Icons"; src: url("data:font/woff2;base64,AQID"); }',
    );
  });

  it("resolves a relative source against the document", () => {
    const win = fakeWindow();
    const capture = installFontCapture(win as unknown as Window);
    win.fonts.add(new win.FontFace("Icons", "url(../i.woff2)"));
    expect(capture.css()).toContain('src: url("https://frame.test/i.woff2")');
  });

  it("asks for one more snapshot when fonts arrive after the last one", () => {
    const win = fakeWindow();
    const onLateFont = vi.fn();
    const timers: (() => void)[] = [];
    const capture = installFontCapture(win as unknown as Window, {
      onLateFont,
      setTimer: (callback) => timers.push(callback),
    });
    win.fonts.add(new win.FontFace("Early", "url(a.woff2)"));
    expect(timers).toHaveLength(0);

    capture.css();
    win.fonts.add(new win.FontFace("Late", "url(b.woff2)"));
    win.fonts.add(new win.FontFace("Later", "url(c.woff2)"));
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(onLateFont).toHaveBeenCalledOnce();
  });
});

describe("addFontsToSnapshot", () => {
  const snapshot = () => ({
    type: 0,
    childNodes: [
      { type: 1 },
      {
        type: 2,
        tagName: "html",
        childNodes: [{ type: 2, tagName: "head", childNodes: [] as unknown[] }],
      },
    ],
  });
  const head = (root: ReturnType<typeof snapshot>) =>
    root.childNodes[1]!.childNodes![0]!.childNodes!;

  it("adds a stylesheet to the head", () => {
    const root = snapshot();
    addFontsToSnapshot(root, "@font-face {}");
    expect(head(root)).toMatchObject([
      { type: 2, tagName: "style", attributes: { _cssText: "@font-face {}" } },
    ]);
  });

  it("changes nothing without fonts, or without a head", () => {
    const root = snapshot();
    addFontsToSnapshot(root, "");
    expect(head(root)).toEqual([]);
    expect(() => addFontsToSnapshot({ type: 0, childNodes: [] }, "x")).not.toThrow();
  });
});
