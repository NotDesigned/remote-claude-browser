/**
 * A small fake DOM for the single-writer input tests (proxy-input, predict-overlay, read-only):
 * enough of elements, text fields, events and frames to drive them without a browser. Test-only.
 */
type Listener = (event: never) => void;

export class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  /** Calls the listeners; returns the event (check `defaultPrevented`). */
  emit<T extends FakeEvent>(event: T): T {
    (event as { target: unknown }).target ??= this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event as never);
    return event;
  }
}

export interface FakeEvent {
  type: string;
  isTrusted: boolean;
  target?: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  [key: string]: unknown;
}

export function fakeEvent(type: string, init: Record<string, unknown> = {}): FakeEvent {
  const event: FakeEvent = {
    type,
    isTrusted: true,
    defaultPrevented: false,
    timeStamp: 0,
    preventDefault() {
      event.defaultPrevented = true;
    },
    getModifierState: () => false,
    ...init,
  };
  return event;
}

export class FakeElement extends FakeEventTarget {
  readonly nodeType = 1;
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  isConnected = true;
  isContentEditable = false;
  disabled = false;
  readOnly = false;
  className = "";
  tabIndex = 0;
  autocomplete = "";
  wrap = "";
  textContent: string | null = "";
  value = "";
  type = "text";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  selectionDirection: "forward" | "backward" | "none" = "none";
  readonly tagName: string;
  constructor(
    tag: string,
    readonly ownerDocument: FakeDocument,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get nodeName() {
    return this.tagName;
  }
  get childNodes() {
    return this.children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node: FakeElement) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
    this.isConnected = false;
  }
  closest(selector: string): FakeElement | null {
    const tags = selector.split(",").map((part) => part.trim());
    let current: FakeElement | null = this;
    while (current !== null) {
      for (const tag of tags) {
        if (tag === "[contenteditable]" && current.attributes.has("contenteditable"))
          return current;
        if (tag.toUpperCase() === current.tagName) return current;
      }
      current = current.parentElement;
    }
    return null;
  }
  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    const previous = doc.activeElement;
    doc.activeElement = this;
    previous?.emit(fakeEvent("blur"));
    this.emit(fakeEvent("focus"));
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = null;
    this.emit(fakeEvent("blur"));
  }
  setSelectionRange(start: number, end: number, direction: "forward" | "backward" = "forward") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  contains(node: unknown): boolean {
    for (let current = node as FakeElement | null; current; current = current.parentElement)
      if (current === this) return true;
    return false;
  }
  setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

export class FakeDocument extends FakeEventTarget {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;
  frames: Array<() => void> = [];
  readonly defaultView = {
    requestAnimationFrame: (callback: (time: number) => void) => {
      this.frames.push(() => callback(0));
      return this.frames.length;
    },
    cancelAnimationFrame: () => undefined,
    getComputedStyle: (_element: FakeElement) => ({}) as CSSStyleDeclaration,
    navigator: { clipboard: undefined },
  };
  constructor() {
    super();
    this.body = new FakeElement("body", this);
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  /** Runs the animation frames queued so far. */
  frame() {
    const due = this.frames;
    this.frames = [];
    for (const run of due) run();
  }
}

/** A field as the person types into it: value and caret change, then `input`. */
export function typeInto(field: FakeElement, value: string, caret = value.length, init = {}) {
  field.value = value;
  field.selectionStart = field.selectionEnd = caret;
  return field.emit(fakeEvent("input", { isComposing: false, inputType: "insertText", ...init }));
}
