// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRebuildRestoreHooks } from "./rebuild-restore";

class FakeCollection<T> extends Array<T> {
  item(index: number): T | null {
    return this[index] ?? null;
  }
}

class FakeView {
  HTMLElement = FakeElement;
  scrollX = 0;
  scrollY = 0;

  scrollTo(options: ScrollToOptions) {
    this.scrollX = options.left ?? this.scrollX;
    this.scrollY = options.top ?? this.scrollY;
  }
}

class FakeElement {
  readonly nodeType = 1;
  isConnected = true;
  value = "";
  readonly attributes = new Map<string, string>();
  readonly children = new FakeCollection<FakeElement>();
  readonly childNodes = this.children as unknown as FakeCollection<Node>;
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | null = null;
  scrollLeft = 0;
  scrollTop = 0;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection: "forward" | "backward" | "none" | null = null;
  isContentEditable = false;
  contentDocument: FakeDocument | null = null;

  constructor(
    readonly owner: FakeDocument,
    readonly tagName: string,
    readonly id = "",
  ) {}

  get ownerDocument() {
    return this.owner;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  append(child: FakeElement) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
  }

  focus() {
    this.owner.activeElement = this;
  }

  setSelectionRange(start: number, end: number, direction: "forward" | "backward" | "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  scrollTo(options: ScrollToOptions) {
    this.scrollLeft = options.left ?? this.scrollLeft;
    this.scrollTop = options.top ?? this.scrollTop;
  }
}

class FakeDocument {
  readonly defaultView = new FakeView();
  readonly documentElement = new FakeElement(this, "HTML");
  activeElement: FakeElement | null = null;

  getElementById(id: string): FakeElement | null {
    return this.querySelectorAll("*").find((element) => element.id === id) ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      result.push(element);
      element.children.forEach(visit);
    };
    visit(this.documentElement);
    if (selector === "iframe") return result.filter((element) => element.tagName === "IFRAME");
    if (selector === "*") return result;
    return result.filter(
      (element) =>
        element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable,
    );
  }

  getSelection() {
    return null;
  }
}

function editableDocument() {
  const document = new FakeDocument();
  const body = new FakeElement(document, "BODY");
  const scroller = new FakeElement(document, "DIV", "editor-pane");
  const input = new FakeElement(document, "INPUT", "message");
  document.documentElement.append(body);
  body.append(scroller);
  scroller.append(input);
  return { document, scroller, input };
}

function framedEditableDocument() {
  const root = new FakeDocument();
  const body = new FakeElement(root, "BODY");
  const frame = new FakeElement(root, "IFRAME", "embed");
  const child = editableDocument();
  frame.contentDocument = child.document;
  root.documentElement.append(body);
  body.append(frame);
  root.activeElement = frame;
  return { root, frame, child };
}

describe("synthetic rrweb rebuild interaction restore", () => {
  it("re-focuses the editable and restores caret plus page/element scroll", () => {
    const before = editableDocument();
    before.document.defaultView.scrollTo({ left: 13, top: 47 });
    before.scroller.scrollTo({ left: 5, top: 29 });
    before.input.focus();
    before.input.setSelectionRange(2, 6, "backward");

    const iframe = {
      contentDocument: before.document,
      contentWindow: before.document.defaultView,
    } as unknown as HTMLIFrameElement;
    const hooks = createRebuildRestoreHooks();
    const restorePoint = hooks.capture(iframe);

    const after = editableDocument();
    Object.assign(iframe, {
      contentDocument: after.document,
      contentWindow: after.document.defaultView,
    });
    hooks.restore(iframe, restorePoint);

    expect(after.document.activeElement).toBe(after.input);
    expect([
      after.input.selectionStart,
      after.input.selectionEnd,
      after.input.selectionDirection,
    ]).toEqual([2, 6, "backward"]);
    expect([after.scroller.scrollLeft, after.scroller.scrollTop]).toEqual([5, 29]);
    expect([after.document.defaultView.scrollX, after.document.defaultView.scrollY]).toEqual([
      13, 47,
    ]);
  });

  it("restores focus, caret, and scroll in a nested same-origin document", () => {
    const before = framedEditableDocument();
    before.root.defaultView.scrollTo({ left: 3, top: 7 });
    before.child.document.defaultView.scrollTo({ left: 13, top: 47 });
    before.child.scroller.scrollTo({ left: 5, top: 29 });
    before.child.input.focus();
    before.child.input.setSelectionRange(1, 4, "forward");

    const iframe = { contentDocument: before.root } as unknown as HTMLIFrameElement;
    const hooks = createRebuildRestoreHooks();
    const restorePoint = hooks.capture(iframe);

    const after = framedEditableDocument();
    Object.assign(iframe, { contentDocument: after.root });
    hooks.restore(iframe, restorePoint);

    expect(after.child.document.activeElement).toBe(after.child.input);
    expect([
      after.child.input.selectionStart,
      after.child.input.selectionEnd,
      after.child.input.selectionDirection,
    ]).toEqual([1, 4, "forward"]);
    expect([after.child.scroller.scrollLeft, after.child.scroller.scrollTop]).toEqual([5, 29]);
    expect([
      after.child.document.defaultView.scrollX,
      after.child.document.defaultView.scrollY,
    ]).toEqual([13, 47]);
    expect([after.root.defaultView.scrollX, after.root.defaultView.scrollY]).toEqual([3, 7]);
  });

  describe("when the page changed under the rebuild", () => {
    /** A page whose fields have rrweb ids, as the replay's mirror gives them. */
    function page() {
      const document = new FakeDocument();
      const body = new FakeElement(document, "BODY");
      const thread = new FakeElement(document, "DIV");
      const composer = new FakeElement(document, "TEXTAREA");
      composer.attributes.set("placeholder", "Reply");
      document.documentElement.append(body);
      body.append(thread);
      body.append(composer);
      const ids = new Map<unknown, number>();
      const context = {
        getId: (node: Node) => ids.get(node) ?? -1,
        getNode: (id: number) =>
          ([...ids].find(([, value]) => value === id)?.[0] as Node | undefined) ?? null,
        remoteFocusId: (): number | null => null,
      };
      return { document, body, composer, ids, context };
    }
    const frameOf = (document: FakeDocument) =>
      ({ contentDocument: document }) as unknown as HTMLIFrameElement;
    /** The composer moved into a pane of its own, as a re-rendered layout puts it. */
    const movedField = (after: ReturnType<typeof page>, placeholder: string) => {
      after.body.children.splice(1, 1);
      const pane = new FakeElement(after.document, "DIV");
      const field = new FakeElement(after.document, "TEXTAREA");
      field.attributes.set("placeholder", placeholder);
      pane.append(field);
      after.body.append(pane);
      return field;
    };

    it("finds the same field by its rrweb id after something was inserted before it", () => {
      const before = page();
      before.ids.set(before.composer, 42);
      before.composer.value = "hello";
      before.composer.focus();
      before.composer.setSelectionRange(2, 3, "forward");
      const hooks = createRebuildRestoreHooks();
      const point = hooks.capture(frameOf(before.document), before.context);

      const after = page();
      const notice = new FakeElement(after.document, "TEXTAREA");
      notice.parentElement = after.body;
      after.body.children.unshift(notice);
      after.ids.set(after.composer, 42);
      after.composer.value = "hello";
      hooks.restore(frameOf(after.document), point, after.context);

      expect(after.document.activeElement).toBe(after.composer);
      expect([after.composer.selectionStart, after.composer.selectionEnd]).toEqual([2, 3]);
    });

    it("focuses a composer mounted anew, with the caret at the end of its text", () => {
      const before = page();
      before.ids.set(before.composer, 42);
      before.composer.value = "sent text";
      before.composer.focus();
      before.composer.setSelectionRange(1, 1, "none");
      const hooks = createRebuildRestoreHooks();
      const point = hooks.capture(frameOf(before.document), before.context);

      const after = page();
      after.ids.set(after.composer, 77);
      after.composer.value = "new";
      hooks.restore(frameOf(after.document), point, after.context);

      expect(after.document.activeElement).toBe(after.composer);
      expect([after.composer.selectionStart, after.composer.selectionEnd]).toEqual([3, 3]);
    });

    it("follows the remote page's focused field when the old one is nowhere", () => {
      const before = page();
      before.ids.set(before.composer, 42);
      before.composer.focus();
      const hooks = createRebuildRestoreHooks();
      const point = hooks.capture(frameOf(before.document), before.context);

      const after = page();
      const moved = movedField(after, "Reply to Claude");
      after.ids.set(moved, 90);
      after.context.remoteFocusId = () => 90;
      hooks.restore(frameOf(after.document), point, after.context);

      expect(after.document.activeElement).toBe(moved);
    });

    it("takes the one field that looks the same when nothing else names it", () => {
      const before = page();
      before.composer.focus();
      const hooks = createRebuildRestoreHooks();
      const point = hooks.capture(frameOf(before.document));

      const after = page();
      const moved = movedField(after, "Reply");
      moved.value = "abc";
      hooks.restore(frameOf(after.document), point);

      expect(after.document.activeElement).toBe(moved);
      expect([moved.selectionStart, moved.selectionEnd]).toEqual([3, 3]);
    });

    it("keeps a caret that typed at the end at the end of text the rebuild brought", () => {
      const before = page();
      before.ids.set(before.composer, 42);
      before.composer.value = "ab";
      before.composer.focus();
      before.composer.setSelectionRange(2, 2, "none");
      const hooks = createRebuildRestoreHooks();
      const point = hooks.capture(frameOf(before.document), before.context);

      const after = page();
      after.ids.set(after.composer, 42);
      after.composer.value = "abcd";
      hooks.restore(frameOf(after.document), point, after.context);
      expect([after.composer.selectionStart, after.composer.selectionEnd]).toEqual([4, 4]);

      // Editing in the middle stays in the middle.
      before.composer.setSelectionRange(1, 1, "none");
      const middle = hooks.capture(frameOf(before.document), before.context);
      const again = page();
      again.ids.set(again.composer, 42);
      again.composer.value = "abcd";
      hooks.restore(frameOf(again.document), middle, again.context);
      expect([again.composer.selectionStart, again.composer.selectionEnd]).toEqual([1, 1]);
    });

    it("leaves focus alone rather than guess between fields", () => {
      const before = page();
      before.composer.focus();
      const hooks = createRebuildRestoreHooks();
      const point = hooks.capture(frameOf(before.document));

      const after = page();
      movedField(after, "Reply");
      const other = new FakeElement(after.document, "TEXTAREA");
      other.attributes.set("placeholder", "Reply");
      after.body.append(other);
      hooks.restore(frameOf(after.document), point);

      expect(after.document.activeElement).toBeNull();
    });
  });
});
