// @vitest-environment node
import type { Up } from "@mirror/protocol";
import { describe, expect, it, vi } from "vitest";
import { createPxView } from "./pxview";

type Listener = (event: never) => void;

interface FakeDocument {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  activeElement: FakeCanvas | FakeTextarea | null;
  createElement(name: string): FakeCanvas | FakeTextarea;
  body: { appendChild(input: FakeTextarea): FakeTextarea };
}

class FakeTextarea {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly style: Record<string, string> = {};
  className = "";
  tabIndex = -1;
  autocomplete = "";
  spellcheck = true;
  value = "";
  parent: FakeContainer | null = null;
  readonly focus = vi.fn(() => {
    this.ownerDocument.activeElement = this;
  });
  constructor(readonly ownerDocument: FakeDocument) {}
  setAttribute() {}
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, event: object) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  remove() {
    this.parent?.inputs.delete(this);
    this.parent = null;
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
}

class FakeCanvas {
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  readonly documentListeners = new Map<string, Set<Listener>>();
  className = "";
  tabIndex = -1;
  private intrinsicWidth = 300;
  private intrinsicHeight = 150;
  readonly dimensionWrites: ["width" | "height", number][] = [];
  painted: FakeImage | null = null;
  parent: FakeContainer | null = null;
  readonly drawImage = vi.fn((image: FakeImage) => {
    this.painted = image;
  });
  readonly focus = vi.fn();

  get ownerDocument(): FakeDocument {
    return this.parent!.ownerDocument;
  }
  get parentElement() {
    return this.parent;
  }

  get width() {
    return this.intrinsicWidth;
  }
  set width(value: number) {
    this.intrinsicWidth = value;
    this.dimensionWrites.push(["width", value]);
    this.painted = null;
  }
  get height() {
    return this.intrinsicHeight;
  }
  set height(value: number) {
    this.intrinsicHeight = value;
    this.dimensionWrites.push(["height", value]);
    this.painted = null;
  }

  setAttribute() {}
  getContext(type: string) {
    return type === "2d" ? { drawImage: this.drawImage } : null;
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 400, height: 200 };
  }
  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  /** Events bubble up to the document, as they do from a real canvas. */
  fire(type: string, event: object) {
    const dispatched = { target: this, ...event } as never;
    for (const listener of this.listeners.get(type) ?? []) listener(dispatched);
    for (const listener of this.documentListeners.get(type) ?? []) listener(dispatched);
  }
  /** An event over the page around the picture. */
  fireOutside(type: string, event: object) {
    const dispatched = { target: { outside: true }, ...event } as never;
    for (const listener of this.documentListeners.get(type) ?? []) listener(dispatched);
  }
  remove() {
    if (this.parent?.child === this) this.parent.child = null;
    this.parent = null;
  }
}

class FakeContainer {
  readonly dataset: Record<string, string> = {};
  child: FakeCanvas | { kind: "mirror" } | null = { kind: "mirror" };
  readonly canvas = new FakeCanvas();
  readonly inputs = new Set<FakeTextarea>();
  replaceCount = 0;
  readonly ownerDocument: FakeDocument = {
    addEventListener: (type, listener) => {
      const listeners = this.canvas.documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      this.canvas.documentListeners.set(type, listeners);
    },
    removeEventListener: (type, listener) => {
      this.canvas.documentListeners.get(type)?.delete(listener);
    },
    activeElement: null,
    createElement: (name: string) => {
      if (name === "canvas") return this.canvas;
      if (name === "textarea") return new FakeTextarea(this.ownerDocument);
      throw new Error(`unexpected element ${name}`);
    },
    body: { appendChild: (input) => this.appendChild(input) },
  };

  appendChild(input: FakeTextarea) {
    input.parent = this;
    this.inputs.add(input);
    return input;
  }

  replaceChildren(child?: FakeCanvas | { kind: "mirror" }) {
    this.replaceCount += 1;
    this.child = child ?? null;
    if (child instanceof FakeCanvas) child.parent = this;
  }
}

function mouse(overrides: Record<string, unknown> = {}) {
  return {
    isTrusted: true,
    clientX: 210,
    clientY: 120,
    button: 0,
    buttons: 1,
    detail: 1,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function key(overrides: Record<string, unknown> = {}) {
  return {
    isTrusted: true,
    isComposing: false,
    key: "a",
    code: "KeyA",
    keyCode: 65,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function edit(overrides: Record<string, unknown> = {}) {
  return {
    isTrusted: true,
    isComposing: false,
    inputType: "insertText",
    data: "",
    cancelable: true,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

function pixelInputFixture() {
  const container = new FakeContainer();
  const sent: Up[] = [];
  const view = createPxView({
    container: container as unknown as HTMLElement,
    send: (message) => sent.push(message),
    onEnterPx: vi.fn(),
    createImage: () => new FakeImage() as unknown as HTMLImageElement,
  });
  view.selectTab("tab-1");
  view.handle({ t: "mode", tab: "tab-1", mode: "px" });
  view.handle({ t: "px", tab: "tab-1", data: "first", w: 800, h: 400 });
  const input = [...container.inputs][0]!;
  return { container, view, input, sent };
}

describe("selecting text in the picture", () => {
  const kinds = (sent: Up[]) =>
    sent.flatMap((message) => (message.t === "ptr" ? [[message.kind, message.vx]] : []));

  it("tells the page where the pointer ended before releasing", () => {
    vi.useFakeTimers();
    try {
      const { container, view, sent } = pixelInputFixture();
      container.canvas.fire("mousedown", mouse({ clientX: 110 }));
      container.canvas.fire("mousemove", mouse({ clientX: 150 }));
      container.canvas.fire("mousemove", mouse({ clientX: 170 }));
      container.canvas.fire("mouseup", mouse({ clientX: 170, buttons: 0 }));
      expect(kinds(sent)).toEqual([
        ["down", 75],
        ["move", 105],
        ["move", 120],
        ["up", 120],
      ]);
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps following a drag outside the picture until the button comes up", () => {
    const { container, view, sent } = pixelInputFixture();
    const outside = { clientX: 5000 };
    container.canvas.fireOutside("mousemove", mouse(outside));
    expect(sent).toHaveLength(0);

    container.canvas.fire("mousedown", mouse());
    container.canvas.fireOutside("mousemove", mouse(outside));
    container.canvas.fireOutside("mouseup", mouse({ ...outside, buttons: 0 }));
    expect(kinds(sent).map(([kind]) => kind)).toEqual(["down", "move", "up"]);

    sent.length = 0;
    container.canvas.fireOutside("mousemove", mouse(outside));
    container.canvas.fireOutside("mouseup", mouse({ ...outside, buttons: 0 }));
    expect(sent).toHaveLength(0);
    view.destroy();
  });

  it("passes a triple click on, which selects a paragraph", () => {
    const { container, view, sent } = pixelInputFixture();
    container.canvas.fire("mousedown", mouse({ detail: 3 }));
    expect(sent.at(-1)).toMatchObject({ t: "ptr", kind: "down", clicks: 3 });
    view.destroy();
  });
});

describe("P2 viewer pixel fallback", () => {
  it("forwards scaled touch pans to the original scroll target without clicking or opening IME", () => {
    const { container, view, input, sent } = pixelInputFixture();
    container.canvas.width = 800;
    container.canvas.height = 400;
    const touch = (x: number, y: number) => ({ target: container.canvas, clientX: x, clientY: y });
    container.canvas.fire("touchstart", { ...mouse(), touches: [touch(210, 120)] });
    container.canvas.fire("touchmove", { ...mouse(), touches: [touch(210, 70)] });
    container.canvas.fire("touchend", { ...mouse(), changedTouches: [touch(210, 70)] });
    expect(sent).toMatchObject([
      { t: "ptr", kind: "wheel", vx: 400, vy: 200, dx: 0, dy: 100, buttons: 0 },
    ]);
    expect(input.focus).not.toHaveBeenCalled();
    view.destroy();
  });

  it("forwards one touch tap and ignores its compatibility mouse events", () => {
    const { container, view, input, sent } = pixelInputFixture();
    const point = { target: container.canvas, clientX: 210, clientY: 120 };
    container.canvas.fire("touchstart", { ...mouse(), touches: [point] });
    container.canvas.fire("touchend", { ...mouse(), changedTouches: [point] });
    for (const type of ["mousemove", "mousedown", "mouseup"])
      container.canvas.fire(type, mouse({ sourceCapabilities: { firesTouchEvents: true } }));
    expect(sent.map((message) => (message.t === "ptr" ? message.kind : message.t))).toEqual([
      "move",
      "down",
      "up",
    ]);
    expect(input.focus).toHaveBeenCalledOnce();
    container.canvas.fire("mousedown", mouse({ sourceCapabilities: { firesTouchEvents: false } }));
    expect(sent).toHaveLength(4);
    view.destroy();
  });

  it("never turns a canceled or multi-touch gesture into a click", () => {
    const { container, view, input, sent } = pixelInputFixture();
    const point = { target: container.canvas, clientX: 210, clientY: 120 };
    container.canvas.fire("touchstart", { ...mouse(), touches: [point] });
    container.canvas.fire("touchcancel", { ...mouse(), changedTouches: [point] });
    container.canvas.fire("touchend", { ...mouse(), changedTouches: [point] });
    container.canvas.fire("touchstart", {
      ...mouse(),
      touches: [point, { ...point, clientX: 250 }],
    });
    container.canvas.fire("touchend", { ...mouse(), changedTouches: [point] });
    expect(sent).toEqual([]);
    expect(input.focus).not.toHaveBeenCalled();
    view.destroy();
  });
  it("focuses a native textarea after a pixel click and keeps composition preedit local", () => {
    const { container, view, input, sent } = pixelInputFixture();
    const click = mouse();
    container.canvas.fire("mousedown", click);
    expect(container.ownerDocument.activeElement).toBe(input);
    expect(input.className).toBe("px-ime-input");
    expect(input.style.left).toBe("210px");
    expect(input.style.top).toBe("120px");
    expect(click.preventDefault).toHaveBeenCalled();
    sent.length = 0;

    const initialPinyinKey = key({ key: "f", code: "KeyF" });
    input.fire("keydown", initialPinyinKey);
    expect(initialPinyinKey.preventDefault).not.toHaveBeenCalled();
    input.fire("compositionstart", { isTrusted: true, data: "" });
    input.fire("compositionupdate", { isTrusted: true, data: "fenxi" });
    input.fire("keydown", key({ key: "n", code: "KeyN", isComposing: true }));
    input.fire(
      "input",
      edit({ inputType: "insertCompositionText", data: "fenxi", isComposing: true }),
    );
    input.fire("keydown", key({ key: "Enter", code: "Enter", isComposing: true }));
    input.fire("input", edit({ inputType: "insertCompositionText", data: "分析" }));
    expect(sent).toEqual([]);
    input.fire("compositionend", { isTrusted: true, data: "分析" });
    input.fire("input", edit({ data: "分析" }));
    input.fire("keyup", key({ key: "Enter", code: "Enter" }));
    expect(sent).toEqual([{ t: "text", tab: "tab-1", insert: "分析" }]);
    expect(input.value).toBe("");
    view.destroy();
  });

  it("submits repeated compositions once each and continues with English and navigation keys", () => {
    const { container, view, input, sent } = pixelInputFixture();
    container.canvas.fire("focus", {});
    expect(container.ownerDocument.activeElement).toBe(input);
    for (let index = 0; index < 2; index++) {
      input.fire("compositionstart", { isTrusted: true, data: "" });
      input.fire("compositionend", { isTrusted: true, data: "问题" });
      input.fire("beforeinput", edit({ inputType: "insertFromComposition", data: "问题" }));
      input.fire("input", edit({ data: "问题" }));
    }
    for (const character of "AI") {
      input.fire("keydown", key({ key: character, code: `Key${character}` }));
      input.value = character;
      input.fire("input", edit({ data: character }));
      input.fire("keyup", key({ key: character, code: `Key${character}` }));
    }
    input.fire("keydown", key({ key: "Enter", code: "Enter" }));
    input.fire("keyup", key({ key: "Enter", code: "Enter" }));
    expect(sent).toEqual([
      { t: "text", tab: "tab-1", insert: "问题" },
      { t: "text", tab: "tab-1", insert: "问题" },
      { t: "text", tab: "tab-1", insert: "A" },
      { t: "text", tab: "tab-1", insert: "I" },
      { t: "key", tab: "tab-1", kind: "down", key: "Enter", code: "Enter", mods: 0 },
      { t: "key", tab: "tab-1", kind: "up", key: "Enter", code: "Enter", mods: 0 },
    ]);
    view.destroy();
  });

  it("uses local paste once without forwarding Ctrl-V or canceled IME text", () => {
    const { view, input, sent } = pixelInputFixture();
    input.fire("compositionstart", { isTrusted: true, data: "" });
    input.value = "weizhengshi";
    input.fire("compositionend", { isTrusted: true, data: "" });
    input.fire("keydown", key({ key: "v", code: "KeyV", ctrlKey: true }));
    const paste = {
      isTrusted: true,
      clipboardData: { getData: () => "粘贴\nlocal" },
      preventDefault: vi.fn(),
    };
    input.fire("paste", paste);
    input.fire("input", edit({ inputType: "insertFromPaste", data: "粘贴\nlocal" }));
    input.fire("keyup", key({ key: "v", code: "KeyV", ctrlKey: true }));
    expect(paste.preventDefault).toHaveBeenCalled();
    expect(sent).toEqual([{ t: "text", tab: "tab-1", insert: "粘贴\nlocal" }]);
    view.destroy();
  });

  it("accepts committed native input without key events and ignores synthetic composition", () => {
    const { view, input, sent } = pixelInputFixture();
    input.fire("compositionstart", { isTrusted: false, data: "" });
    input.fire("compositionend", { isTrusted: false, data: "synthetic" });
    input.value = "输入";
    input.fire("input", edit({ data: null }));
    expect(sent).toEqual([{ t: "text", tab: "tab-1", insert: "输入" }]);
    expect(input.value).toBe("");
    view.destroy();
  });

  it("accepts an untrusted native end only for the exact preedit proven by trusted events", () => {
    const { view, input, sent } = pixelInputFixture();
    input.fire("compositionstart", { isTrusted: true, data: "" });
    input.fire("compositionupdate", { isTrusted: true, data: "fenxi" });
    input.fire(
      "input",
      edit({ inputType: "insertCompositionText", data: "fenxi", isComposing: true }),
    );
    input.fire("compositionupdate", { isTrusted: true, data: "分析" });
    input.fire(
      "input",
      edit({ inputType: "insertCompositionText", data: "分析", isComposing: true }),
    );
    input.fire("compositionend", { isTrusted: false, data: "分析" });
    input.fire("compositionend", { isTrusted: false, data: "分析" });
    input.fire("input", edit({ data: "分析" }));
    input.fire("input", edit({ data: "AI" }));
    expect(sent).toEqual([
      { t: "text", tab: "tab-1", insert: "分析" },
      { t: "text", tab: "tab-1", insert: "AI" },
    ]);
    view.destroy();
  });

  it("rejects synthetic or mismatched composition ends without trusting their data", () => {
    const { view, input, sent } = pixelInputFixture();
    input.fire("compositionstart", { isTrusted: false, data: "" });
    input.fire("compositionupdate", { isTrusted: false, data: "synthetic" });
    input.fire("input", edit({ isTrusted: false, data: "synthetic", isComposing: true }));
    input.fire("compositionend", { isTrusted: false, data: "synthetic" });
    expect(sent).toEqual([]);

    input.fire("compositionstart", { isTrusted: true, data: "" });
    input.fire(
      "input",
      edit({ inputType: "insertCompositionText", data: "分析", isComposing: true }),
    );
    input.fire("compositionend", { isTrusted: false, data: "different" });
    expect(sent).toEqual([]);
    input.fire("compositionend", { isTrusted: false, data: "分析" });
    expect(sent).toEqual([{ t: "text", tab: "tab-1", insert: "分析" }]);
    view.destroy();
  });

  it("can prove a native composition without start and cancels empty ends without locking input", () => {
    const { view, input, sent } = pixelInputFixture();
    input.fire(
      "input",
      edit({ inputType: "insertCompositionText", data: "分析", isComposing: true }),
    );
    input.fire("compositionend", { isTrusted: false, data: "分析" });
    input.fire("input", edit({ data: "分析" }));
    input.fire("compositionstart", { isTrusted: true, data: "" });
    input.fire(
      "input",
      edit({ inputType: "insertCompositionText", data: "cancel", isComposing: true }),
    );
    input.fire("compositionend", { isTrusted: false, data: "" });
    input.fire("input", edit({ data: "AI" }));
    input.fire("compositionend", { isTrusted: false, data: "cancel" });
    expect(sent).toEqual([
      { t: "text", tab: "tab-1", insert: "分析" },
      { t: "text", tab: "tab-1", insert: "AI" },
    ]);
    view.destroy();
  });

  it("removes native IME state and ignores late commits on mode changes, tab changes, and teardown", () => {
    const { container, view, input, sent } = pixelInputFixture();
    input.fire("compositionstart", { isTrusted: true, data: "" });
    const lateCommit = [...input.listeners.get("compositionend")!][0]!;
    view.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    expect(container.inputs.size).toBe(0);
    expect([...input.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    lateCommit({ isTrusted: true, data: "late" } as never);

    view.handle({ t: "mode", tab: "tab-1", mode: "px" });
    view.handle({ t: "px", tab: "tab-1", data: "again", w: 800, h: 400 });
    const secondInput = [...container.inputs][0]!;
    secondInput.fire("compositionstart", { isTrusted: true, data: "" });
    view.selectTab("tab-2");
    expect(container.inputs.size).toBe(0);
    secondInput.fire("compositionend", { isTrusted: true, data: "old tab" });
    view.handle({ t: "mode", tab: "tab-2", mode: "px" });
    view.handle({ t: "px", tab: "tab-2", data: "new tab", w: 800, h: 400 });
    const thirdInput = [...container.inputs][0]!;
    thirdInput.fire("compositionstart", { isTrusted: true, data: "" });
    view.destroy();
    expect(container.inputs.size).toBe(0);
    thirdInput.fire("compositionend", { isTrusted: true, data: "after destruction" });
    expect(sent).toEqual([]);
  });

  it("paints JPEG frames, sends raw viewport input, and swaps cleanly back to a mirror", () => {
    const container = new FakeContainer();
    const images: FakeImage[] = [];
    const sent: Up[] = [];
    const enterPx = vi.fn(() => container.replaceChildren());
    const enterDom = vi.fn(() => container.replaceChildren({ kind: "mirror" }));
    const view = createPxView({
      container: container as unknown as HTMLElement,
      send: (message) => sent.push(message),
      onEnterPx: enterPx,
      onEnterDom: enterDom,
      createImage: () => {
        const image = new FakeImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
    });

    view.selectTab("tab-1");
    view.handle({ t: "mode", tab: "tab-1", mode: "px" });
    expect(enterPx).not.toHaveBeenCalled();
    expect(container.child).toEqual({ kind: "mirror" });
    view.handle({ t: "px", tab: "tab-1", data: "jpeg-base64", w: 800, h: 400 });

    expect(enterPx).toHaveBeenCalledWith("tab-1");
    expect(container.child).toBe(container.canvas);
    expect(container.canvas.width).toBe(300);
    expect(container.canvas.height).toBe(150);
    expect(images[0]?.src).toBe("data:image/jpeg;base64,jpeg-base64");
    images[0]?.onload?.();
    expect(container.canvas.width).toBe(800);
    expect(container.canvas.height).toBe(400);
    expect(container.canvas.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 800, 400);

    container.canvas.fire("mousedown", mouse());
    expect(sent).toEqual([
      {
        t: "ptr",
        tab: "tab-1",
        kind: "down",
        nodeId: -1,
        rx: 0,
        ry: 0,
        vx: 400,
        vy: 200,
        button: 0,
        buttons: 1,
        mods: 0,
        clicks: 1,
      },
    ]);

    view.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    expect(enterDom).toHaveBeenCalledWith("tab-1");
    expect(view.getCanvas()).toBeNull();
    expect(container.child).toEqual({ kind: "mirror" });
    expect(container.canvas.listeners.get("mousedown")?.size).toBe(0);

    view.handle({ t: "px", tab: "tab-1", data: "late", w: 1, h: 1 });
    expect(images).toHaveLength(1);
  });

  it("keeps the painted frame while decoding and coalesces a burst without starving the decoder", async () => {
    const container = new FakeContainer();
    const images: FakeImage[] = [];
    const view = createPxView({
      container: container as unknown as HTMLElement,
      send: vi.fn(),
      onEnterPx: vi.fn(),
      createImage: () => {
        const image = new FakeImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
    });
    const decode = async (image: FakeImage) => {
      const onload = image.onload;
      await Promise.resolve();
      onload?.();
    };
    view.selectTab("tab-1");
    view.handle({ t: "mode", tab: "tab-1", mode: "px" });
    view.handle({ t: "px", tab: "tab-1", data: "first", w: 800, h: 400 });
    await decode(images[0]!);
    expect(container.canvas.painted).toBe(images[0]);
    expect(container.canvas.dimensionWrites).toHaveLength(2);

    view.handle({ t: "px", tab: "tab-1", data: "decoding", w: 800, h: 400 });
    const inFlight = images[1]!.onload;
    for (let index = 0; index < 100; index++) {
      view.handle({ t: "px", tab: "tab-1", data: `pending-${index}`, w: 1024, h: 600 });
    }
    expect(images).toHaveLength(2);
    expect(images[1]!.onload).toBe(inFlight);
    expect(container.canvas.painted).toBe(images[0]);
    expect(container.canvas.dimensionWrites).toHaveLength(2);

    await decode(images[1]!);
    expect(container.canvas.painted).toBe(images[1]);
    expect(container.canvas.dimensionWrites).toHaveLength(2);
    expect(images).toHaveLength(3);
    expect(images[2]!.src).toBe("data:image/jpeg;base64,pending-99");
    expect(container.canvas.width).toBe(800);
    expect(container.canvas.height).toBe(400);

    await decode(images[2]!);
    expect(container.canvas.painted).toBe(images[2]);
    expect(container.canvas.dimensionWrites).toEqual([
      ["width", 800],
      ["height", 400],
      ["width", 1024],
      ["height", 600],
    ]);
    expect(container.canvas.drawImage.mock.calls.map(([image]) => image.src)).toEqual([
      "data:image/jpeg;base64,first",
      "data:image/jpeg;base64,decoding",
      "data:image/jpeg;base64,pending-99",
    ]);
    view.destroy();
  });

  it("preserves the last picture on decode failure and ignores late callbacks after a tab switch or destruction", async () => {
    const container = new FakeContainer();
    const images: FakeImage[] = [];
    const view = createPxView({
      container: container as unknown as HTMLElement,
      send: vi.fn(),
      onEnterPx: vi.fn(),
      createImage: () => {
        const image = new FakeImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
    });
    view.selectTab("tab-1");
    view.handle({ t: "mode", tab: "tab-1", mode: "px" });
    view.handle({ t: "px", tab: "tab-1", data: "last-good", w: 800, h: 400 });
    images[0]!.onload?.();
    view.handle({ t: "px", tab: "tab-1", data: "broken", w: 1200, h: 900 });
    view.handle({ t: "px", tab: "tab-1", data: "waiting", w: 640, h: 480 });
    await Promise.resolve();
    images[1]!.onerror?.();
    expect(container.canvas.painted).toBe(images[0]);
    expect(container.canvas.dimensionWrites).toHaveLength(2);
    expect(images).toHaveLength(3);

    const afterSwitch = images[2]!.onload;
    view.selectTab("tab-2");
    await Promise.resolve();
    afterSwitch?.();
    expect(container.canvas.drawImage).toHaveBeenCalledTimes(1);
    expect(container.canvas.dimensionWrites).toHaveLength(2);

    view.handle({ t: "mode", tab: "tab-2", mode: "px" });
    view.handle({ t: "px", tab: "tab-2", data: "new-tab", w: 640, h: 480 });
    view.handle({ t: "px", tab: "tab-2", data: "never-decoded", w: 640, h: 480 });
    const afterDestroy = images[3]!.onload;
    view.destroy();
    await Promise.resolve();
    afterDestroy?.();
    expect(container.canvas.drawImage).toHaveBeenCalledTimes(1);
    expect(images).toHaveLength(4);
    expect(view.getCanvas()).toBeNull();
  });

  it("leaves the mirror host untouched while DOM mode owns it", () => {
    const container = new FakeContainer();
    const enterPx = vi.fn();
    const enterDom = vi.fn();
    const view = createPxView({
      container: container as unknown as HTMLElement,
      send: vi.fn(),
      onEnterPx: enterPx,
      onEnterDom: enterDom,
    });

    view.selectTab("tab-1");
    view.handle({ t: "mode", tab: "tab-1", mode: "dom" });
    view.selectTab("tab-2");
    view.handle({ t: "mode", tab: "tab-2", mode: "px" });

    expect(container.replaceCount).toBe(0);
    expect(container.child).toEqual({ kind: "mirror" });
    expect(enterPx).not.toHaveBeenCalled();
    expect(enterDom).not.toHaveBeenCalled();
  });
});
