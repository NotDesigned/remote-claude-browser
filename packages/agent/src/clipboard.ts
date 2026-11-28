/** Page-local clipboard virtualization keeps shared Chrome's OS clipboard out of client data. */
import type { Emitter } from "./emit";
import type { NativeMask } from "./native-mask";

interface ClipboardLike {
  writeText(text: string): Promise<void>;
  readText?(): Promise<string>;
  read?(): Promise<ClipboardItem[]>;
  write?(items: ClipboardItem[]): Promise<void>;
}

interface NavigatorLike {
  readonly clipboard?: ClipboardLike;
}

interface SelectionLike {
  toString(): string;
}

interface CopyEventLike {
  readonly clipboardData?: { getData(format: string): string; clearData?(): void } | null;
  readonly isTrusted?: boolean;
  preventDefault?(): void;
  stopImmediatePropagation?(): void;
  readonly target?: EventTarget | null;
}

interface WindowLike {
  addEventListener(
    type: "copy" | "cut" | "paste",
    listener: (event: CopyEventLike) => void,
    capture?: boolean,
  ): void;
  removeEventListener(
    type: "copy" | "cut" | "paste",
    listener: (event: CopyEventLike) => void,
    capture?: boolean,
  ): void;
  getSelection(): SelectionLike | null;
  readonly document?: Pick<Document, "execCommand">;
}

export interface CapturedClipboardWrite {
  readonly clipboard: ClipboardLike;
  readonly writeText: ClipboardLike["writeText"];
}

export interface ClipboardHookOptions {
  readonly capturedWrite: CapturedClipboardWrite | null;
  readonly emitter: Pick<Emitter, "emitClipboard">;
  readonly window?: WindowLike;
  /** Hardening: the replacements go on the prototype and look like the browser's own. */
  readonly mask?: NativeMask;
}

/** Capture both the receiver and method before page code can replace either reference. */
export function captureClipboardWrite(navigatorLike: NavigatorLike): CapturedClipboardWrite | null {
  const clipboard = navigatorLike.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return null;
  return { clipboard, writeText: clipboard.writeText };
}

/** Installs the observation hooks and returns a test/dev cleanup function. */
export function installClipboardHooks(options: ClipboardHookOptions): () => void {
  const view = options.window ?? (window as unknown as WindowLike);
  const clipboard = options.capturedWrite?.clipboard;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const prototypeDescriptors = new Map<string, { owner: object; descriptor: PropertyDescriptor }>();
  let text = "";
  let writeVersion = 0;
  let items: ClipboardItem[] = [];
  const remember = (value: string) => {
    text = value;
    options.emitter.emitClipboard(value);
  };
  const mask = options.mask;
  const realm = view as unknown as {
    TypeError?: TypeErrorConstructor;
    DOMException?: typeof DOMException;
    navigator?: { userActivation?: { isActive?: boolean } };
  };
  const NativeTypeError = realm.TypeError ?? TypeError;
  const NativeDOMException =
    realm.DOMException ?? (typeof DOMException !== "undefined" ? DOMException : Error);
  const assertReceiver = (self: unknown, name: string): void => {
    if (clipboard !== undefined && self !== clipboard) {
      throw new NativeTypeError(`Failed to execute '${name}' on 'Clipboard': Illegal invocation`);
    }
  };
  const assertReadAllowed = (name: string): void => {
    if (mask === undefined || writeVersion > 0) return;
    throw new NativeDOMException(
      `Failed to execute '${name}' on 'Clipboard': Read permission denied.`,
      "NotAllowedError",
    );
  };
  const replace = (name: string, value: unknown) => {
    if (clipboard === undefined) return;
    if (mask !== undefined) {
      // On the prototype, where the browser keeps them, and looking like its own methods: an
      // own property of navigator.clipboard is something no browser has.
      const owner = Object.getPrototypeOf(clipboard) as object | null;
      const native = owner === null ? undefined : Object.getOwnPropertyDescriptor(owner, name);
      if (owner === null || typeof native?.value !== "function") return;
      try {
        Object.defineProperty(owner, name, {
          ...native,
          value: mask.method(name, value as () => unknown, native.value as () => unknown),
        });
        prototypeDescriptors.set(name, { owner, descriptor: native });
      } catch {
        // Event interception still protects native keyboard copy in constrained embeddings.
      }
      return;
    }
    const previous = Object.getOwnPropertyDescriptor(clipboard, name);
    try {
      Object.defineProperty(clipboard, name, { configurable: true, writable: true, value });
      descriptors.set(name, previous);
    } catch {
      // Event interception still protects native keyboard copy in constrained embeddings.
    }
  };
  replace("writeText", async function (this: unknown, value: string) {
    assertReceiver(this, "writeText");
    if (arguments.length < 1) {
      throw new NativeTypeError(
        "Failed to execute 'writeText' on 'Clipboard': 1 argument required, but only 0 present.",
      );
    }
    writeVersion++;
    items = [];
    remember(String(value));
  });
  replace("readText", async function (this: unknown) {
    assertReceiver(this, "readText");
    assertReadAllowed("readText");
    return text;
  });
  replace("write", async function (this: unknown, value: ClipboardItem[]) {
    assertReceiver(this, "write");
    if (arguments.length < 1) {
      throw new NativeTypeError(
        "Failed to execute 'write' on 'Clipboard': 1 argument required, but only 0 present.",
      );
    }
    const version = ++writeVersion;
    items = Array.from(value);
    text = "";
    const item = items.find((entry) => entry.types.includes("text/plain"));
    if (item) {
      const nextText = await (await item.getType("text/plain")).text();
      if (version === writeVersion) remember(nextText);
    }
  });
  replace("read", async function (this: unknown) {
    assertReceiver(this, "read");
    assertReadAllowed("read");
    if (items.length > 0) return [...items];
    return text === ""
      ? []
      : [new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) })];
  });

  const onCopy = (event: CopyEventLike): void => {
    writeVersion++;
    items = [];
    remember(copiedText(event, view));
    event.preventDefault?.();
    event.clipboardData?.clearData?.();
  };
  const onCut = (event: CopyEventLike): void => {
    onCopy(event);
    view.document?.execCommand("delete");
  };
  const onPaste = (event: CopyEventLike): void => {
    // Untrusted synthetic ClipboardEvents carry no OS clipboard data; let page listeners run.
    if (event.isTrusted === false) return;
    // This fallback covers remote context-menu paste. Client keyboard paste uses Input.insertText.
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    if (text) view.document?.execCommand("insertText", false, text);
  };
  view.addEventListener("copy", onCopy, false);
  view.addEventListener("cut", onCut, false);
  view.addEventListener("paste", onPaste, true);

  return () => {
    view.removeEventListener("copy", onCopy, false);
    view.removeEventListener("cut", onCut, false);
    view.removeEventListener("paste", onPaste, true);
    for (const [name, { owner, descriptor }] of prototypeDescriptors)
      Object.defineProperty(owner, name, descriptor);
    if (clipboard === undefined) return;
    for (const [name, previous] of descriptors) {
      if (previous === undefined) delete (clipboard as unknown as Record<string, unknown>)[name];
      else Object.defineProperty(clipboard, name, previous);
    }
  };
}

function copiedText(event: CopyEventLike, view: WindowLike): string {
  const clipboardText = event.clipboardData?.getData("text/plain");
  if (clipboardText !== undefined && clipboardText !== "") return clipboardText;

  const target = event.target;
  if (isTextControl(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return target.value.slice(Math.min(start, end), Math.max(start, end));
  }
  return view.getSelection()?.toString() ?? "";
}

function isTextControl(value: EventTarget | null | undefined): value is EventTarget & {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const control = value as unknown as Record<string, unknown>;
  return (
    typeof control.value === "string" &&
    (typeof control.selectionStart === "number" || control.selectionStart === null) &&
    (typeof control.selectionEnd === "number" || control.selectionEnd === null)
  );
}
