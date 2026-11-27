import type { TabId, Up } from "@mirror/protocol";
import { createCompositionGuard } from "./input/composition-guard";
import { isPasteShortcut, keyEventMessage, sendKeyPress } from "./input/encode";

interface PxKeyboardOptions {
  /** The surface the textarea serves: the pixel canvas, or the page mode's replay iframe. */
  canvas: HTMLElement;
  tab: TabId;
  send(message: Up): void;
  /**
   * Pixel mode: keys pressed on the canvas itself are handled here and focusing the canvas
   * focuses the textarea. Page mode has its own key capture inside the replay and sets false.
   */
  ownerKeys?: boolean;
}

export type PxKeyboard = ReturnType<typeof attachPxKeyboard>;

/**
 * A real local editor gives the OS an IME caret while the remote page owns the actual text.
 * Page mode uses it too, when the remote page has a field focused that the mirror cannot focus.
 */
export function attachPxKeyboard(options: PxKeyboardOptions) {
  const ownerKeys = options.ownerKeys ?? true;
  const input = options.canvas.ownerDocument.createElement("textarea");
  input.className = "px-ime-input";
  input.tabIndex = -1;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("aria-label", "Remote browser text input");
  Object.assign(input.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "1px",
    height: "20px",
    padding: "0",
    border: "0",
    opacity: "0",
    fontSize: "16px",
    pointerEvents: "none",
  });
  (options.canvas.parentElement ?? options.canvas.ownerDocument.body).appendChild(input);

  let disposed = false;
  const guard = createCompositionGuard();
  let committedText: string | null = null;
  /** Keys pressed on the page and not yet released there, with the press that sent them. */
  const forwardedKeys = new Map<string, KeyboardEvent>();
  const clearInput = () => {
    input.value = "";
  };
  const sendText = (insert: string) => {
    if (insert.length > 0) options.send({ t: "text", tab: options.tab, insert });
    clearInput();
  };
  const commit = (text: string) => {
    if (committedText !== text) sendText(text);
    else clearInput();
    // Chromium can send a final input after compositionend (and paste). Keep one commit
    // identity until that input or the next real keystroke, never a time-based typing window.
    committedText = text || null;
  };
  const focus = (point?: Pick<MouseEvent, "clientX" | "clientY">) => {
    if (disposed) return;
    if (point !== undefined) {
      input.style.left = `${Math.max(0, point.clientX)}px`;
      input.style.top = `${Math.max(0, point.clientY)}px`;
    }
    input.focus({ preventScroll: true });
  };
  /**
   * Commit what is still being composed. Android keyboards keep a whole word (a password is one)
   * in composition until a space or punctuation, and a tap on the page does not end it: the tap
   * refocuses this same textarea, so the word was never sent and the page got an empty or partial
   * field. Before any tap, tab switch or mode switch, the pending text goes out, and blurring ends
   * the keyboard's composition; its compositionend repeats the same text, which `commit` drops.
   */
  const flush = () => {
    if (disposed || !guard.composing) return;
    const text = input.value;
    guard.reset();
    if (text.length > 0) options.send({ t: "text", tab: options.tab, insert: text });
    committedText = text || null;
    if (input.ownerDocument.activeElement === input) input.blur();
    clearInput();
  };
  const onCanvasFocus = () => focus();
  const sendKey = (event: KeyboardEvent, kind: "down" | "up") => {
    options.send(keyEventMessage(options.tab, kind, event));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || !event.isTrusted) return;
    committedText = null;
    if (
      guard.composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Dead" ||
      event.key === "Unidentified"
    )
      return;
    // Native paste reads the user's clipboard; forwarding Ctrl/Cmd-V would use B's clipboard.
    if (isPasteShortcut(event)) return;
    const altGraph = event.getModifierState?.("AltGraph") === true;
    if (
      [...event.key].length === 1 &&
      ((!event.altKey && !event.ctrlKey && !event.metaKey) || altGraph)
    )
      return;
    event.preventDefault();
    forwardedKeys.set(event.code || event.key, event);
    sendKey(event, "down");
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (disposed || !event.isTrusted || !forwardedKeys.delete(event.code || event.key)) return;
    event.preventDefault();
    sendKey(event, "up");
  };
  const onCompositionStart = (event: CompositionEvent) => {
    if (disposed || !event.isTrusted) return;
    guard.start(event);
    committedText = null;
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    if (disposed || !event.isTrusted) return;
    guard.update(event);
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (disposed) return;
    // Some native Chromium IME traces end with an untrusted compositionend (composition-guard.ts).
    const text = guard.end(event);
    if (text === null) return;
    commit(text);
  };
  const onInput = (event: Event) => {
    const edit = event as InputEvent;
    if (disposed || !edit.isTrusted) return;
    if (edit.isComposing) {
      guard.composingInput(edit);
      return;
    }
    if (guard.composing) return;
    const text = edit.data ?? input.value;
    if (committedText === text) clearInput();
    else sendText(text);
    committedText = null;
  };
  const onBeforeInput = (event: InputEvent) => {
    if (disposed || !event.isTrusted || guard.composing || event.isComposing) return;
    if (event.inputType === "insertFromComposition" && event.cancelable) {
      event.preventDefault();
      commit(event.data ?? input.value);
      return;
    }
    const key =
      event.inputType === "insertLineBreak" || event.inputType === "insertParagraph"
        ? "Enter"
        : event.inputType === "deleteContentBackward"
          ? "Backspace"
          : event.inputType === "deleteContentForward"
            ? "Delete"
            : null;
    if (key === null) return;
    event.preventDefault();
    sendKeyPress(options.send, options.tab, key, key, 0);
    clearInput();
  };
  const onPaste = (event: ClipboardEvent) => {
    if (disposed || !event.isTrusted) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    committedText = null;
    commit(text);
  };

  if (ownerKeys) options.canvas.addEventListener("focus", onCanvasFocus);
  const keyboardTargets: HTMLElement[] = ownerKeys ? [options.canvas, input] : [input];
  for (const target of keyboardTargets) {
    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
  }
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionupdate", onCompositionUpdate);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("beforeinput", onBeforeInput);
  input.addEventListener("input", onInput);
  input.addEventListener("paste", onPaste);
  return {
    focus,
    flush,
    hasFocus: () => input.ownerDocument.activeElement === input,
    blur: () => input.blur(),
    dispose() {
      flush();
      // Its key-ups will not come here any more: a key left down on the page repeats there, or
      // keeps a modifier applied to whatever the person does next.
      for (const press of forwardedKeys.values()) sendKey(press, "up");
      forwardedKeys.clear();
      disposed = true;
      options.canvas.removeEventListener("focus", onCanvasFocus);
      for (const target of keyboardTargets) {
        target.removeEventListener("keydown", onKeyDown);
        target.removeEventListener("keyup", onKeyUp);
      }
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionupdate", onCompositionUpdate);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("input", onInput);
      input.removeEventListener("paste", onPaste);
      guard.reset();
      committedText = null;
      forwardedKeys.clear();
      clearInput();
      input.remove();
    },
  };
}
