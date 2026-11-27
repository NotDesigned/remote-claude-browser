// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scrollUpWheelPoint, type WheelPointDom } from "./wheel-point";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FakeOptions {
  tag?: string;
  box?: Box;
  overflowY?: string;
  position?: string;
  scrollTop?: number;
  scrollHeight?: number;
}

/** A page of boxes; `hit` finds the last-added box under a point, as painting order would. */
function fakePage(viewport = { w: 800, h: 600 }) {
  const all: FakeEl[] = [];
  const document = {
    defaultView: { innerWidth: viewport.w, innerHeight: viewport.h },
    scrollingElement: null as unknown as FakeEl,
    documentElement: null as unknown as FakeEl,
  };
  class FakeEl {
    parentElement: FakeEl | null = null;
    parentNode: FakeEl | null = null;
    localName: string;
    box: Box;
    style: { overflowY: string; position: string };
    scrollTop: number;
    scrollHeight: number;
    clientLeft = 0;
    clientTop = 0;
    ownerDocument = document;
    constructor(options: FakeOptions) {
      this.localName = options.tag ?? "div";
      this.box = options.box ?? { left: 0, top: 0, width: 0, height: 0 };
      this.style = {
        overflowY: options.overflowY ?? "visible",
        position: options.position ?? "static",
      };
      this.scrollTop = options.scrollTop ?? 0;
      this.scrollHeight = options.scrollHeight ?? this.box.height;
    }
    get clientWidth() {
      return this.box.width;
    }
    get clientHeight() {
      return this.box.height;
    }
    getBoundingClientRect() {
      return { ...this.box, x: this.box.left, y: this.box.top };
    }
    getRootNode() {
      return document;
    }
    add(options: FakeOptions): FakeEl {
      const child = new FakeEl(options);
      child.parentElement = this;
      child.parentNode = this;
      all.push(child);
      return child;
    }
  }
  const html = new FakeEl({
    tag: "html",
    box: { left: 0, top: 0, width: viewport.w, height: viewport.h },
    scrollHeight: 5_000,
  });
  document.documentElement = html;
  document.scrollingElement = html;
  const dom: WheelPointDom = {
    hit: (_root, x, y) => {
      for (let index = all.length - 1; index >= 0; index--) {
        const { left, top, width, height } = all[index]!.box;
        if (x >= left && x < left + width && y >= top && y < top + height)
          return all[index] as unknown as Element;
      }
      return html as unknown as Element;
    },
    style: (element) => (element as unknown as FakeEl).style as unknown as CSSStyleDeclaration,
    toRoot: (x, y) => ({ x, y }),
    touch: () => false,
  };
  return { html, dom, el: (e: FakeEl) => e as unknown as Element };
}

describe("scrollUpWheelPoint", () => {
  it("decides from the scroller's live position, not from any earlier report", () => {
    const page = fakePage();
    const transcript = page.html.add({
      box: { left: 100, top: 100, width: 400, height: 300 },
      overflowY: "auto",
      scrollTop: 5_000,
      scrollHeight: 9_000,
    });
    // Up from where it is now: a wheel at its centre, one notch at most.
    expect(scrollUpWheelPoint(page.el(transcript), 4_800, page.dom)).toEqual({
      x: 300,
      y: 250,
      dy: 120,
    });
    expect(scrollUpWheelPoint(page.el(transcript), 4_960, page.dom)?.dy).toBe(40);
    // Down, level, or within rounding of where it is: no wheel.
    expect(scrollUpWheelPoint(page.el(transcript), 5_200, page.dom)).toBeNull();
    expect(scrollUpWheelPoint(page.el(transcript), 4_998, page.dom)).toBeNull();
    expect(scrollUpWheelPoint(page.el(transcript), Number.NaN, page.dom)).toBeNull();
  });

  it("never wheels a page that is above the requested position", () => {
    const page = fakePage();
    page.html.scrollTop = 0;
    expect(scrollUpWheelPoint(page.el(page.html), 500, page.dom)).toBeNull();
    page.html.scrollTop = 3_000;
    expect(scrollUpWheelPoint(page.el(page.html), 2_900, page.dom)).toEqual({
      x: 400,
      y: 300,
      dy: 100,
    });
  });

  it("moves off a nested scroller at the centre onto the scroller itself", () => {
    const page = fakePage();
    const transcript = page.html.add({
      box: { left: 0, top: 0, width: 400, height: 400 },
      overflowY: "auto",
      scrollTop: 2_000,
      scrollHeight: 6_000,
    });
    const message = transcript.add({ box: { left: 0, top: 100, width: 400, height: 200 } });
    // A code block in the middle that scrolls on its own.
    message.add({
      box: { left: 0, top: 150, width: 400, height: 100 },
      overflowY: "auto",
      scrollHeight: 500,
      scrollTop: 400,
    });
    const point = scrollUpWheelPoint(page.el(transcript), 1_500, page.dom)!;
    expect(point).not.toBeNull();
    expect(point.y < 150 || point.y >= 250).toBe(true);
  });

  it("does not hand the page's wheel to an inner panel, a frame or a fixed overlay", () => {
    const page = fakePage({ w: 200, h: 200 });
    page.html.scrollTop = 1_000;
    // A panel that scrolls on its own and a frame, side by side, cover the whole viewport.
    page.html.add({
      box: { left: 0, top: 0, width: 100, height: 200 },
      overflowY: "scroll",
      scrollHeight: 900,
    });
    page.html.add({ tag: "iframe", box: { left: 100, top: 0, width: 100, height: 200 } });
    expect(scrollUpWheelPoint(page.el(page.html), 500, page.dom)).toBeNull();

    const other = fakePage({ w: 200, h: 200 });
    const list = other.html.add({
      box: { left: 0, top: 0, width: 200, height: 200 },
      overflowY: "auto",
      scrollTop: 300,
      scrollHeight: 900,
    });
    // Fixed inside the list: its wheel goes to the viewport, not the list.
    list.add({ box: { left: 0, top: 0, width: 200, height: 200 }, position: "fixed" });
    expect(scrollUpWheelPoint(other.el(list), 100, other.dom)).toBeNull();
  });

  it("uses the visible part of a scroller whose centre is outside the viewport", () => {
    const page = fakePage({ w: 390, h: 664 });
    const transcript = page.html.add({
      box: { left: 0, top: 100, width: 390, height: 1_400 },
      overflowY: "auto",
      scrollTop: 800,
      scrollHeight: 4_000,
    });
    const point = scrollUpWheelPoint(page.el(transcript), 700, page.dom)!;
    expect(point).toEqual({ x: 195, y: 382, dy: 100 });
    // Entirely outside the viewport: no point at all.
    transcript.box = { left: 0, top: 700, width: 390, height: 300 };
    expect(scrollUpWheelPoint(page.el(transcript), 700, page.dom)).toBeNull();
  });

  it("says when the page runs as a phone", () => {
    const page = fakePage();
    page.html.scrollTop = 1_000;
    const dom = { ...page.dom, touch: () => true };
    expect(scrollUpWheelPoint(page.el(page.html), 900, dom)).toMatchObject({ touch: true });
  });
});
