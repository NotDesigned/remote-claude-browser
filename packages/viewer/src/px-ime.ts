import { Mod, type TabId, type Up } from "@mirror/protocol";

interface PxKeyboardOptions {
  canvas: HTMLCanvasElement;
  tab: TabId;
  send(message: Up): void;
}

/** A real local editor gives the OS an IME caret while the remote page owns the actual text. */
export function attachPxKeyboard(options: PxKeyboardOptions) {
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
  let composing = false;
  let trustedComposition = false;
  let trustedPreedit: string | null = null;
  let committedText: string | null = null;
  const forwardedKeys = new Set<string>();
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
  const onCanvasFocus = () => focus();
  const sendKey = (event: KeyboardEvent, kind: "down" | "up") => {
    options.send({
      t: "key",
      tab: options.tab,
      kind,
      key: event.key,
      code: event.code,
      mods:
        (event.altKey ? Mod.Alt : 0) |
        (event.ctrlKey ? Mod.Ctrl : 0) |
        (event.metaKey ? Mod.Meta : 0) |
        (event.shiftKey ? Mod.Shift : 0),
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (disposed || !event.isTrusted) return;
    committedText = null;
    if (
      composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Dead" ||
      event.key === "Unidentified"
    )
      return;
    // Native paste reads the user's clipboard; forwarding Ctrl/Cmd-V would use B's clipboard.
    if (
      (!event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") ||
      (event.shiftKey && event.key === "Insert")
    )
      return;
    const altGraph = event.getModifierState?.("AltGraph") === true;
    if (
      [...event.key].length === 1 &&
      ((!event.altKey && !event.ctrlKey && !event.metaKey) || altGraph)
    )
      return;
    event.preventDefault();
    forwardedKeys.add(event.code || event.key);
    sendKey(event, "down");
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (disposed || !event.isTrusted || !forwardedKeys.delete(event.code || event.key)) return;
    event.preventDefault();
    sendKey(event, "up");
  };
  const onCompositionStart = (event: CompositionEvent) => {
    if (disposed || !event.isTrusted) return;
    composing = true;
    trustedComposition = true;
    trustedPreedit = event.data;
    committedText = null;
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    if (disposed || !event.isTrusted) return;
    composing = true;
    if (trustedComposition) trustedPreedit = event.data;
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (disposed) return;
    let text = event.data;
    if (!event.isTrusted) {
      // Some native Chromium IME traces end with an untrusted compositionend. Its payload is
      // usable only as confirmation of preedit already observed through trusted native events.
      if (!composing || !trustedComposition) return;
      if (text !== "") {
        if (trustedPreedit === null || text !== trustedPreedit) return;
        text = trustedPreedit;
      }
    }
    composing = false;
    trustedComposition = false;
    trustedPreedit = null;
    commit(text);
  };
  const onInput = (event: Event) => {
    const edit = event as InputEvent;
    if (disposed || !edit.isTrusted) return;
    if (edit.isComposing) {
      composing = true;
      trustedComposition = true;
      trustedPreedit = edit.data;
      return;
    }
    if (composing) return;
    const text = edit.data ?? input.value;
    if (committedText === text) clearInput();
    else sendText(text);
    committedText = null;
  };
  const onBeforeInput = (event: InputEvent) => {
    if (disposed || !event.isTrusted || composing || event.isComposing) return;
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
    for (const kind of ["down", "up"] as const)
      options.send({ t: "key", tab: options.tab, kind, key, code: key, mods: 0 });
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

  options.canvas.addEventListener("focus", onCanvasFocus);
  const keyboardTargets: HTMLElement[] = [options.canvas, input];
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
    dispose() {
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
      composing = false;
      trustedComposition = false;
      trustedPreedit = null;
      committedText = null;
      forwardedKeys.clear();
      clearInput();
      input.remove();
    },
  };
}
