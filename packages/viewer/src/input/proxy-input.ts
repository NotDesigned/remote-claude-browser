/**
 * The local proxy of single-writer input: one real focused element in the viewer document, never
 * inside the replay, so this device's keyboard, IME, autocorrect and soft keyboard work as in any
 * text field, while the replay's own fields stay read-only (read-only.ts).
 *
 * It holds a window of the remote field's text around the caret (64 code units before it and 32
 * after, cut at a line), which an IME or autocorrect reads as context. Each trusted edit (an
 * `input` outside a composition, or a composition's end) is compared with what the proxy held
 * before, and proxy-plan.ts turns the difference into presses and text, sent with input sequence
 * numbers; the page gets them only as trusted CDP input. The prediction overlay shows them until
 * their acknowledgements settle. Text insertion is never prevented here, so the keyboard keeps its
 * own state; keys that move the caret or are shortcuts are prevented and forwarded as keys.
 *
 * The proxy's window is written again from the replay (a reseed) only when nothing is outstanding,
 * no composition is open and the replay shows what the page reported: writing a field's value
 * restarts a phone keyboard.
 */
import type { RemoteFocus, TabId, Up } from "@mirror/protocol";
import { editHash } from "@mirror/protocol";
import { createCompositionGuard } from "./composition-guard";
import { eventMods, isPasteShortcut } from "./encode";
import type { HiddenKeyboard } from "./focus-follow";
import { pastedFiles } from "./keys";
import type { SettledAck } from "./input-seq";
import {
  nextGrapheme,
  planEdit,
  previousGrapheme,
  type PlanOp,
  type ProxyState,
} from "./proxy-plan";
import { replayFieldText, type PredictOverlay, type ProxyLab } from "./predict-overlay";

/** Context the proxy holds before and after the caret. */
export const WINDOW_BEFORE = 64;
export const WINDOW_AFTER = 32;
/** A non-editable remote focus this long blurs the proxy (an editor remounting is quicker). */
export const BLUR_GRACE_MS = 300;

export interface ProxyInputOptions {
  /** The viewer document; the proxy is appended to its body. */
  doc: Document;
  tab(): TabId | null;
  /** Sends one input message; false when it was not sent. */
  send(message: Up): boolean;
  /** The newest iseq stamped for the tab (input-seq.ts). */
  lastStamped(tab: TabId): number;
  /** Inputs of the tab sent and not yet acknowledged. */
  outstanding(tab: TabId): number;
  overlay: PredictOverlay;
  /** The replay node of a recorder id. */
  node(id: number): Node | null;
  /** Text selected in the replay with the mouse, for a local copy. */
  replaySelection?(): string;
  onPasteFiles?(files: File[]): void;
  lab?: ProxyLab;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

export interface ProxyInput extends HiddenKeyboard {
  readonly element: HTMLTextAreaElement | HTMLInputElement;
  /** Commit an open composition (a tap, a tab or mode switch). */
  flush(): void;
  /** The remote page's focus moved. */
  remoteFocus(focus: RemoteFocus | null): void;
  /** An acknowledgement settled for the tab. */
  settled(ack: SettledAck): void;
  /** The replay applied more of the page's stream: reseed if idle and the field changed. */
  replayApplied(): void;
  /** Writes the window of `text` around `sel` into the proxy, if it differs. */
  seed(text: string, sel: [number, number]): void;
  /** 「放回」: text back into the proxy at its caret, to be sent with the next edit. */
  putBack(text: string): void;
  composing(): boolean;
  model(): ProxyState & { start: number };
  dispose(): void;
}

/** The window of `text` the proxy holds around [selStart, selEnd]. */
export function proxyWindow(
  text: string,
  selStart: number,
  selEnd: number,
): { value: string; start: number; selStart: number; selEnd: number } {
  const lo = Math.max(0, Math.min(selStart, selEnd, text.length));
  const hi = Math.max(lo, Math.min(Math.max(selStart, selEnd), text.length));
  let start = Math.max(0, lo - WINDOW_BEFORE);
  let end = Math.min(text.length, hi + WINDOW_AFTER);
  if (start > 0) {
    // Cut at a line where the window has one, so an IME sees whole lines.
    const newline = text.indexOf("\n", start);
    if (newline >= 0 && newline < lo) start = newline + 1;
    else if (isLow(text.charCodeAt(start))) start += 1;
  }
  if (end < text.length) {
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline >= hi) end = newline;
    else if (isLow(text.charCodeAt(end))) end -= 1;
  }
  return { value: text.slice(start, end), start, selStart: lo - start, selEnd: hi - start };
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Keys forwarded as keys: they move the caret, leave the field or are shortcuts. */
const FORWARDED_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Tab",
  "Escape",
  "Enter",
  "Insert",
]);
const CARET_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export function createProxyInput(options: ProxyInputOptions): ProxyInput {
  const doc = options.doc;
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number));
  const guard = createCompositionGuard();
  const overlay = options.overlay;
  let element: HTMLTextAreaElement | HTMLInputElement = make(false);
  let disposed = false;
  let password = false;
  let focusId: number | null = null;
  /** What the page holds around its caret, as far as this viewer knows; `start` is its offset. */
  let model: ProxyState & { start: number } = { value: "", selStart: 0, selEnd: 0, start: 0 };
  let lastKey: KeyboardEvent | null = null;
  const forwardedKeys = new Map<string, KeyboardEvent>();
  /** The caret moved on the page in a way the proxy cannot follow: reseed at the next chance. */
  let caretUnknown = true;
  let blurTimer: unknown = null;
  let intendedBlur = false;

  function make(isPassword: boolean): HTMLTextAreaElement | HTMLInputElement {
    const field = isPassword ? doc.createElement("input") : doc.createElement("textarea");
    if (isPassword) {
      (field as HTMLInputElement).type = "password";
      field.autocomplete = "off";
    } else (field as HTMLTextAreaElement).wrap = "off";
    field.className = "proxy-input";
    field.tabIndex = -1;
    field.setAttribute("aria-label", "Remote browser text input");
    field.setAttribute("data-proxy-input", "true");
    Object.assign(field.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "2px",
      height: "1.4em",
      padding: "0",
      margin: "0",
      border: "0",
      outline: "none",
      resize: "none",
      overflow: "hidden",
      whiteSpace: "pre",
      opacity: "0",
      caretColor: "transparent",
      color: "transparent",
      background: "transparent",
      fontSize: "16px",
      pointerEvents: "none",
      zIndex: "2147482999",
    });
    doc.body.appendChild(field);
    return field;
  }

  const tab = () => options.tab();
  const replayNode = (): HTMLElement | null => {
    if (focusId === null || focusId < 0) return null;
    const node = options.node(focusId);
    return node !== null && node.nodeType === 1 ? (node as HTMLElement) : null;
  };

  /** The replay field's correction settings, so the keyboard behaves as it would there. */
  const mirrorAttributes = () => {
    const node = replayNode();
    const attr = (name: string) => node?.getAttribute(name) ?? null;
    const autocomplete = (attr("autocomplete") ?? "").toLowerCase();
    const quiet = password || autocomplete === "off" || autocomplete === "one-time-code";
    const set = (name: string, value: string | null) => {
      if (value === null) element.removeAttribute(name);
      else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    };
    set("autocorrect", quiet ? "off" : (attr("autocorrect") ?? "on"));
    set("autocapitalize", quiet ? "off" : (attr("autocapitalize") ?? "sentences"));
    set("spellcheck", quiet ? "false" : (attr("spellcheck") ?? "true"));
    set("inputmode", attr("inputmode"));
    set("enterkeyhint", attr("enterkeyhint"));
    // iOS zooms into a field whose text is smaller than 16px.
    const size = node?.ownerDocument.defaultView?.getComputedStyle(node).fontSize;
    element.style.fontSize = `${Math.max(16, parseFloat(size ?? "16") || 16)}px`;
  };

  const place = (point?: { clientX: number; clientY: number }) => {
    const caret = overlay.caret();
    const x = caret?.left ?? point?.clientX;
    const y = caret?.top ?? point?.clientY;
    if (x !== undefined && y !== undefined) {
      element.style.left = `${Math.max(0, x)}px`;
      element.style.top = `${Math.max(0, y)}px`;
    }
  };

  const current = (): ProxyState => ({
    value: element.value,
    selStart: element.selectionStart ?? element.value.length,
    selEnd: element.selectionEnd ?? element.value.length,
  });

  const keyMessage = (
    kind: "down" | "up",
    key: string,
    code: string,
    mods: number,
    text?: string,
  ): Up => {
    const id = tab()!;
    return {
      t: "key",
      tab: id,
      kind,
      key,
      code,
      mods,
      ...(text === undefined ? {} : { text }),
    };
  };

  /** Sends the ops; the iseqs they got, or null when nothing went out. */
  const sendOps = (ops: readonly PlanOp[], keyEvent: KeyboardEvent | null) => {
    const id = tab();
    if (id === null) return null;
    const before = options.lastStamped(id);
    let sent = true;
    const send = (message: Up) => {
      if (!options.send(message)) sent = false;
    };
    for (const op of ops) {
      if (op.t === "press") {
        send(keyMessage("down", op.key, op.key, 0));
        send(keyMessage("up", op.key, op.key, 0));
      } else if (op.t === "char" && keyEvent !== null) {
        const mods = eventMods(keyEvent);
        send(keyMessage("down", keyEvent.key, keyEvent.code, mods, op.text));
        send(keyMessage("up", keyEvent.key, keyEvent.code, mods));
      } else {
        send({ t: "text", tab: id, insert: op.text });
      }
    }
    const after = options.lastStamped(id);
    return sent ? { first: before + 1, last: after } : null;
  };

  /** The page's field as the proxy should show it: a reseed. */
  const seed = (text: string, sel: [number, number]) => {
    const window = password
      ? { value: "", start: 0, selStart: 0, selEnd: 0 }
      : proxyWindow(text, sel[0], sel[1]);
    const same =
      element.value === window.value &&
      element.selectionStart === window.selStart &&
      element.selectionEnd === window.selEnd;
    model = {
      value: window.value,
      selStart: window.selStart,
      selEnd: window.selEnd,
      start: window.start,
    };
    caretUnknown = false;
    if (same) return;
    element.value = window.value;
    try {
      element.setSelectionRange(window.selStart, window.selEnd);
    } catch {
      // A detached or password field may refuse a selection.
    }
    if (options.lab) options.lab.reseeds += 1;
  };

  const idle = () => {
    const id = tab();
    return (
      id !== null && !guard.composing && overlay.pending() === 0 && options.outstanding(id) === 0
    );
  };

  /** Reseeds from the replay when nothing is on its way and the replay's field differs. */
  const reseedFromReplay = (sel?: [number, number], hash?: string) => {
    if (!idle()) return;
    const node = replayNode();
    if (node === null) return;
    const text = replayFieldText(node);
    if (hash !== undefined && hash !== "" && editHash(text) !== hash) return;
    if (password) {
      // The replay shows a mask; the page emptied the field when it reports no characters.
      const selection = overlay.lastSelection();
      if (selection !== null && selection[1] === 0 && element.value !== "") seed("", [0, 0]);
      return;
    }
    const selection = sel ?? overlay.lastSelection() ?? [text.length, text.length];
    const clamped: [number, number] = [
      Math.min(selection[0], text.length),
      Math.min(selection[1], text.length),
    ];
    const window = proxyWindow(text, clamped[0], clamped[1]);
    if (
      !caretUnknown &&
      window.value === element.value &&
      window.selStart === element.selectionStart &&
      window.selEnd === element.selectionEnd
    )
      return;
    seed(text, clamped);
  };

  /** One trusted edit of the proxy: plan it, send it, predict it. */
  const plan = (event: Event | null) => {
    if (disposed || tab() === null) return;
    const next = current();
    const keyEvent = lastKey;
    lastKey = null;
    const ops = planEdit(model, next, keyEvent?.key);
    if (ops === "fallback") {
      if (options.lab) options.lab.planFallback += 1;
      overlay.undelivered(next.value.slice(Math.min(model.selStart, next.selStart)), false);
      caretUnknown = true;
      model = { ...next, start: model.start };
      reseedFromReplay();
      return;
    }
    model = {
      value: next.value,
      selStart: next.selEnd,
      selEnd: next.selEnd,
      start: model.start,
    };
    if (ops.length === 0) return;
    const sent = sendOps(ops, keyEvent);
    const text = ops.map((op) => (op.t === "press" ? "" : op.text)).join("");
    if (sent === null) {
      overlay.undelivered(text, false);
      return;
    }
    overlay.push({ first: sent.first, last: sent.last, ops, text });
    place();
    measureEcho(event);
  };

  const measureEcho = (event: Event | null) => {
    const lab = options.lab;
    if (lab === undefined || event === null || !event.isTrusted) return;
    const stamp = event.timeStamp;
    lab.echoSync.push(now() - stamp);
    doc.defaultView?.requestAnimationFrame((time) => {
      lab.echo.push(time - stamp);
      if (lab.echo.length > 20_000) lab.echo.shift();
    });
    if (lab.echoSync.length > 20_000) lab.echoSync.shift();
  };

  const sendKey = (event: KeyboardEvent, kind: "down" | "up") => {
    const id = tab();
    if (id === null) return;
    const message = keyMessage(kind, event.key, event.code, eventMods(event));
    if (kind === "down" && event.key === "Enter" && message.t === "key") {
      const expect = overlay.expectFor();
      options.send(expect === null ? message : { ...message, expect });
    } else options.send(message);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || !event.isTrusted) return;
    if (
      guard.composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Dead" ||
      event.key === "Unidentified"
    ) {
      lastKey = null;
      return;
    }
    const altGraph = event.getModifierState?.("AltGraph") === true;
    const shortcut = (event.ctrlKey || event.metaKey) && !altGraph;
    const printable = [...event.key].length === 1;
    if (printable && !shortcut && !(event.altKey && !altGraph)) {
      lastKey = event;
      return;
    }
    lastKey = null;
    if (isPasteShortcut(event)) return;
    const key = event.key.toLowerCase();
    if (shortcut && key === "c") {
      const selected = options.replaySelection?.() ?? "";
      if (selected !== "") {
        event.preventDefault();
        void doc.defaultView?.navigator.clipboard?.writeText(selected).catch(() => undefined);
        return;
      }
    }
    // Deleting is the proxy's own edit (predicted, planned), unless it has nothing to delete.
    if ((event.key === "Backspace" || event.key === "Delete") && !(event.altKey && !altGraph)) {
      const state = current();
      const collapsed = state.selStart === state.selEnd;
      const nothing =
        collapsed &&
        (event.key === "Backspace" ? state.selStart === 0 : state.selEnd === state.value.length);
      if (!nothing) return;
    } else if (
      !FORWARDED_KEYS.has(event.key) &&
      !shortcut &&
      !event.altKey &&
      !/^F\d+$/.test(event.key)
    )
      return;
    event.preventDefault();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // The page's caret moves one grapheme; the proxy's follows it.
      const state = current();
      if (!event.shiftKey && !shortcut && !event.altKey && state.selStart === state.selEnd) {
        const value = element.value;
        const at =
          event.key === "ArrowLeft"
            ? Math.max(0, state.selStart - previousGrapheme(value, state.selStart))
            : Math.min(value.length, state.selStart + nextGrapheme(value, state.selStart));
        element.setSelectionRange(at, at);
        model = { ...model, selStart: at, selEnd: at };
      } else caretUnknown = true;
    } else if (CARET_KEYS.has(event.key) || shortcut) caretUnknown = true;
    forwardedKeys.set(event.code || event.key, event);
    sendKey(event, "down");
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (disposed || !event.isTrusted || !forwardedKeys.delete(event.code || event.key)) return;
    event.preventDefault();
    sendKey(event, "up");
  };
  const onBeforeInput = (event: InputEvent) => {
    if (disposed || !event.isTrusted) return;
    if (event.inputType === "insertFromDrop" || event.inputType === "deleteByDrag") {
      event.preventDefault();
      return;
    }
    if (guard.composing || event.isComposing) return;
    if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      // A soft keyboard's Return without a key event: the page gets Enter.
      event.preventDefault();
      const id = tab();
      if (id === null) return;
      const expect = overlay.expectFor();
      const down = keyMessage("down", "Enter", "Enter", 0);
      options.send(expect === null ? down : ({ ...down, expect } as Up));
      options.send(keyMessage("up", "Enter", "Enter", 0));
    }
  };
  const onInput = (event: Event) => {
    const edit = event as InputEvent;
    if (disposed || !edit.isTrusted) return;
    if (edit.isComposing) {
      guard.composingInput(edit);
      overlay.preedit(composedText());
      return;
    }
    if (guard.composing) return;
    plan(event);
  };
  /** The text of the open composition: what the proxy holds beyond the model. */
  const composedText = () => {
    const next = current().value;
    const before = model.value;
    let prefix = 0;
    while (prefix < before.length && prefix < next.length && before[prefix] === next[prefix])
      prefix++;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < next.length - prefix &&
      before[before.length - 1 - suffix] === next[next.length - 1 - suffix]
    )
      suffix++;
    return next.slice(prefix, next.length - suffix);
  };
  const onCompositionStart = (event: CompositionEvent) => {
    if (disposed) return;
    guard.start(event);
    lastKey = null;
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    if (disposed || !event.isTrusted) return;
    guard.update(event);
    overlay.preedit(event.data);
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (disposed) return;
    const text = guard.end(event);
    if (text === null) return;
    overlay.preedit(null);
    plan(event);
  };
  const onPaste = (event: ClipboardEvent) => {
    if (disposed || !event.isTrusted) return;
    const files = options.onPasteFiles === undefined ? [] : pastedFiles(event.clipboardData);
    if (files.length === 0) return;
    options.onPasteFiles?.(files);
    if ((event.clipboardData?.getData("text/plain") ?? "") === "") event.preventDefault();
  };
  const onBlur = () => {
    if (disposed) return;
    if (!intendedBlur && options.lab) options.lab.blurs += 1;
    intendedBlur = false;
  };

  const listen = (field: HTMLElement) => {
    field.addEventListener("keydown", onKeyDown);
    field.addEventListener("keyup", onKeyUp);
    field.addEventListener("beforeinput", onBeforeInput);
    field.addEventListener("input", onInput);
    field.addEventListener("compositionstart", onCompositionStart);
    field.addEventListener("compositionupdate", onCompositionUpdate);
    field.addEventListener("compositionend", onCompositionEnd);
    field.addEventListener("paste", onPaste);
    field.addEventListener("blur", onBlur);
  };
  const unlisten = (field: HTMLElement) => {
    field.removeEventListener("keydown", onKeyDown);
    field.removeEventListener("keyup", onKeyUp);
    field.removeEventListener("beforeinput", onBeforeInput);
    field.removeEventListener("input", onInput);
    field.removeEventListener("compositionstart", onCompositionStart);
    field.removeEventListener("compositionupdate", onCompositionUpdate);
    field.removeEventListener("compositionend", onCompositionEnd);
    field.removeEventListener("paste", onPaste);
    field.removeEventListener("blur", onBlur);
  };
  listen(element);

  const hasFocus = () => doc.activeElement === element;
  const blur = () => {
    if (!hasFocus()) return;
    intendedBlur = true;
    element.blur();
  };
  const flush = () => {
    if (disposed || !guard.composing) return;
    guard.reset();
    overlay.preedit(null);
    plan(null);
    // Blurring ends the keyboard's composition; its compositionend repeats text already sent.
    if (hasFocus()) {
      intendedBlur = true;
      element.blur();
    }
  };

  const swap = (isPassword: boolean) => {
    if (isPassword === password) return;
    const focused = hasFocus();
    password = isPassword;
    unlisten(element);
    if (focused) intendedBlur = true;
    element.remove();
    element = make(isPassword);
    listen(element);
    model = { value: "", selStart: 0, selEnd: 0, start: 0 };
    caretUnknown = true;
    if (focused) element.focus({ preventScroll: true });
  };

  const proxy: ProxyInput = {
    get element() {
      return element;
    },
    focus(point) {
      if (disposed) return;
      if (blurTimer !== null) clearTimer(blurTimer);
      blurTimer = null;
      mirrorAttributes();
      place(point);
      if (!hasFocus()) {
        element.focus({ preventScroll: true });
        if (caretUnknown) reseedFromReplay();
      }
    },
    hasFocus,
    blur,
    flush,
    remoteFocus(focus) {
      if (disposed) return;
      if (focus === null || !focus.editable) {
        // A composer being mounted anew reports no field for a moment; the keyboard stays.
        if (blurTimer !== null) clearTimer(blurTimer);
        blurTimer = setTimer(() => {
          blurTimer = null;
          if (focusId !== null) return;
          flush();
          blur();
          overlay.setTarget(null);
        }, BLUR_GRACE_MS);
        focusId = null;
        return;
      }
      if (blurTimer !== null) clearTimer(blurTimer);
      blurTimer = null;
      const changed = focus.id !== focusId;
      focusId = focus.id;
      swap(focus.password === true);
      overlay.setTarget({ nodeId: focus.id, password: focus.password === true });
      mirrorAttributes();
      if (changed) {
        caretUnknown = true;
        reseedFromReplay();
      }
      if (hasFocus()) place();
    },
    settled(ack) {
      if (disposed) return;
      overlay.settled(ack);
      if (ack.mode !== "page" || !ack.final) return;
      const edit = ack.edit;
      if (edit === null || edit === undefined || edit.node !== focusId) return;
      reseedFromReplay([edit.sel[0], edit.sel[1]], edit.hash);
    },
    replayApplied() {
      if (disposed || focusId === null || !idle()) return;
      reseedFromReplay();
    },
    seed,
    putBack(text) {
      if (disposed || text === "") return;
      element.focus({ preventScroll: true });
      element.setRangeText(
        text,
        element.selectionStart ?? element.value.length,
        element.selectionEnd ?? element.value.length,
        "end",
      );
    },
    composing: () => guard.composing,
    model: () => model,
    dispose() {
      if (disposed) return;
      flush();
      for (const press of forwardedKeys.values()) sendKey(press, "up");
      forwardedKeys.clear();
      disposed = true;
      if (blurTimer !== null) clearTimer(blurTimer);
      unlisten(element);
      element.remove();
    },
  };
  return proxy;
}
