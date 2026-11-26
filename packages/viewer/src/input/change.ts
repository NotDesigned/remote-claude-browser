/**
 * Committed value-control forwarding.
 *
 * Native controls in the inert mirror still perform local default actions. A trusted `change`
 * therefore has to reconcile the authoritative page explicitly. A shared forwarded-input clock
 * keeps ordinary typing out of this value lane while an orphan native edit (autofill, context
 * menu, spellcheck, or drop) falls back to it.
 */
import { editableText, type TabId } from "@mirror/protocol";
import { createForwardedInputClock, type ForwardedInputClock } from "./forwarded";
import {
  collectSubtreeNodeIds,
  isContenteditableEchoField,
  isEchoField,
  type EditableFocus,
} from "./keys";
import { isElement, resolvePointerTarget, type SendInput } from "./pointer";
import {
  isPasswordField,
  passwordReplacement,
  passwordSelection,
  type PasswordSelection,
} from "./password";

const DEFAULT_TYPING_WINDOW_MS = 1_000;
const DEFAULT_ORPHAN_WINDOW_MS = 150;
const DEFAULT_COMPOSING_FLUSH_MS = 500;
const UNSUPPORTED_INPUT_TYPES = new Set(["button", "file", "hidden", "image", "reset", "submit"]);

export interface ChangeCaptureOptions {
  doc: Document;
  tab: TabId;
  getNodeId(node: Node): number;
  send: SendInput;
  forwardedClock?: ForwardedInputClock;
  now?: () => number;
  typingWindowMs?: number;
  orphanWindowMs?: number;
  composingFlushMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onEditableInput?(focus: EditableFocus): void;
  committedContenteditable?: boolean;
}

type ValueControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function attachChangeCapture(options: ChangeCaptureOptions): {
  dispose(): void;
  flush(target: Element, complete?: boolean): void;
} {
  const now = options.now ?? Date.now;
  const typingWindowMs = options.typingWindowMs ?? DEFAULT_TYPING_WINDOW_MS;
  const orphanWindowMs = options.orphanWindowMs ?? DEFAULT_ORPHAN_WINDOW_MS;
  const composingFlushMs = options.composingFlushMs ?? DEFAULT_COMPOSING_FLUSH_MS;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const forwardedClock = options.forwardedClock ?? createForwardedInputClock();
  const valueClock = createForwardedInputClock();
  const lastValues = new WeakMap<ValueControl, string>();
  const editedValues = new WeakSet<ValueControl>();
  const editedContenteditables = new WeakSet<HTMLElement>();
  const passwordBefore = new WeakMap<HTMLInputElement, PasswordSelection>();
  const capturePassword = (target: EventTarget | null) => {
    if (isElement(target) && isPasswordField(target))
      passwordBefore.set(target, passwordSelection(target));
  };
  const onBeforeInput = (event: InputEvent) => {
    if (!event.isTrusted) return;
    capturePassword(event.target);
    if (
      options.committedContenteditable &&
      isElement(event.target) &&
      isContenteditableEchoField(event.target)
    ) {
      const host = contenteditableHost(event.target);
      if (!editBases.has(host)) {
        editBases.set(host, sendableText(host));
        baseTakenBy = { event, host };
      }
    }
  };
  /** The edit that took a base and was then cancelled (Enter, sent as a key) never happens. */
  let baseTakenBy: { event: Event; host: HTMLElement } | null = null;
  const afterBeforeInput = (event: Event) => {
    if (baseTakenBy?.event !== event) return;
    if (event.defaultPrevented) editBases.delete(baseTakenBy.host);
    baseTakenBy = null;
  };
  const onFocusIn = (event: FocusEvent) => capturePassword(event.target);
  capturePassword(options.doc.activeElement);

  /** Each editing host's text as last sent: the base of an edit that began unseen. */
  const sentEditables = new WeakMap<HTMLElement, string>();
  /**
   * Each editing host's text before the edits not sent yet, taken when the first of them began.
   * The page makes the edit from this to the text sent on its own text, which can differ from
   * this replay's: the page cleared its composer after sending, or rewrote what was typed, and
   * this replay holds those changes back while someone types. Sending the whole text alone would
   * put the message just sent back into the composer, or undo the page's rewrite.
   */
  const editBases = new WeakMap<HTMLElement, string>();
  const sendEditable = (host: HTMLElement) => {
    const nodeId = options.getNodeId(host);
    if (nodeId < 0) return;
    const value = sendableText(host);
    const base = editBases.get(host) ?? sentEditables.get(host);
    editBases.delete(host);
    sentEditables.set(host, value);
    options.send({
      t: "value",
      tab: options.tab,
      nodeId,
      value,
      commit: false,
      ...(base === undefined ? {} : { base }),
    });
  };
  const composingNodes = new Set<number>();
  const composeFlushTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const resolveControl = (target: EventTarget | null) => {
    const control = valueControl(target);
    if (control === null) return null;
    const resolved = resolvePointerTarget(control, options.getNodeId);
    // Unlike pointer fallback, the agent value command must address the control itself.
    return resolved?.element === control ? { control, nodeId: resolved.nodeId } : null;
  };

  const sendValue = (control: ValueControl, nodeId: number, commit = false) => {
    const message: Extract<Parameters<SendInput>[0], { t: "value" }> = {
      t: "value",
      tab: options.tab,
      nodeId,
      value: control.value,
      ...(commit ? {} : { commit: false }),
    };
    const tag = control.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const textControl = control as HTMLInputElement | HTMLTextAreaElement;
      if (
        typeof textControl.selectionStart === "number" &&
        typeof textControl.selectionEnd === "number"
      ) {
        message.selectionStart = textControl.selectionStart;
        message.selectionEnd = textControl.selectionEnd;
      }
    }
    if (tag === "input") {
      const input = control as HTMLInputElement;
      const type = input.type.toLowerCase();
      if (type === "checkbox" || type === "radio") message.checked = input.checked;
    } else if (tag === "select" && (control as HTMLSelectElement).multiple) {
      const select = control as HTMLSelectElement;
      message.values = Array.from(select.options)
        .filter((option) => option.selected)
        .map((option) => option.value);
    }
    options.send(message);
    valueClock.mark(nodeId, now());
    lastValues.set(control, control.value);
    // Only raw key/text forwarding may suppress its matching native input event.
    // A value update has no future native input to consume: marking this clock
    // would drop the next soft-keyboard edits in a fast typing burst.
  };

  const cancelComposeFlush = (nodeId: number) => {
    const timer = composeFlushTimers.get(nodeId);
    if (timer === undefined) return;
    cancel(timer);
    composeFlushTimers.delete(nodeId);
  };

  const armComposeFlush = (control: ValueControl, nodeId: number) => {
    cancelComposeFlush(nodeId);
    const timer = schedule(() => {
      composeFlushTimers.delete(nodeId);
      composingNodes.delete(nodeId);
      sendValue(control, nodeId);
    }, composingFlushMs);
    composeFlushTimers.set(nodeId, timer);
  };

  const onInput = (event: Event) => {
    if (!event.isTrusted) return;
    if (isElement(event.target) && isContenteditableEchoField(event.target)) {
      const host = contenteditableHost(event.target);
      const resolved = resolvePointerTarget(host, options.getNodeId);
      if (resolved !== null) {
        options.onEditableInput?.({
          element: host,
          nodeId: resolved.nodeId,
          subtreeNodeIds: collectSubtreeNodeIds(host, options.getNodeId),
        });
      }
      if (options.committedContenteditable) {
        editedContenteditables.add(host);
        if (
          !(event as InputEvent).isComposing ||
          (event as InputEvent).inputType === "insertFromComposition"
        )
          sendEditable(host);
      }
      return;
    }
    const resolved = resolveControl(event.target);
    if (resolved === null || !isEchoField(resolved.control)) return;
    editedValues.add(resolved.control);
    options.onEditableInput?.({ element: resolved.control, nodeId: resolved.nodeId });
    if (isPasswordField(resolved.control)) {
      const control = resolved.control;
      const after = passwordSelection(control);
      const before = passwordBefore.get(control);
      const inputType = (event as InputEvent).inputType;
      const edit =
        inputType === "historyUndo" || inputType === "historyRedo"
          ? { edit: inputType === "historyUndo" ? ("undo" as const) : ("redo" as const), value: "" }
          : before
            ? passwordReplacement(before, after)
            : { edit: { start: 0, end: Number.MAX_SAFE_INTEGER }, value: control.value };
      options.send({
        t: "value",
        tab: options.tab,
        nodeId: resolved.nodeId,
        ...edit,
        commit: false,
        selectionStart: after.start,
        selectionEnd: after.end,
      });
      passwordBefore.set(control, after);
      return;
    }
    const isComposing = (event as InputEvent).isComposing;
    if (composingNodes.has(resolved.nodeId) && !isComposing) {
      composingNodes.delete(resolved.nodeId);
      cancelComposeFlush(resolved.nodeId);
    }
    if (isComposing) {
      composingNodes.add(resolved.nodeId);
      armComposeFlush(resolved.control, resolved.nodeId);
      return;
    }
    const lastForwardedAt = forwardedClock.get(resolved.nodeId);
    if (lastForwardedAt !== undefined && now() - lastForwardedAt < orphanWindowMs) return;
    const lastValueAt = valueClock.get(resolved.nodeId);
    if (
      lastValueAt !== undefined &&
      now() - lastValueAt < orphanWindowMs &&
      lastValues.get(resolved.control) === resolved.control.value
    )
      return;
    sendValue(resolved.control, resolved.nodeId);
  };

  const onChange = (event: Event) => {
    if (!event.isTrusted) return;
    const resolved = resolveControl(event.target);
    if (resolved === null) return;
    if (isPasswordField(resolved.control)) {
      options.send({
        t: "value",
        tab: options.tab,
        nodeId: resolved.nodeId,
        value: "",
        edit: { start: 0, end: 0 },
      });
      return;
    }
    const lastForwardedAt = forwardedClock.get(resolved.nodeId);
    if (
      isEchoField(resolved.control) &&
      lastForwardedAt !== undefined &&
      now() - lastForwardedAt < typingWindowMs
    ) {
      return;
    }
    sendValue(resolved.control, resolved.nodeId, true);
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (!event.isTrusted) return;
    const resolved = resolveControl(event.target);
    if (resolved === null || !isEchoField(resolved.control) || isPasswordField(resolved.control))
      return;
    composingNodes.add(resolved.nodeId);
    armComposeFlush(resolved.control, resolved.nodeId);
  };

  const onCompositionEnd = (event: CompositionEvent) => {
    if (!event.isTrusted) return;
    if (
      options.committedContenteditable &&
      isElement(event.target) &&
      isContenteditableEchoField(event.target)
    ) {
      const host = contenteditableHost(event.target);
      editedContenteditables.add(host);
      sendEditable(host);
      return;
    }
    const resolved = resolveControl(event.target);
    if (resolved === null || !isEchoField(resolved.control) || isPasswordField(resolved.control))
      return;
    composingNodes.delete(resolved.nodeId);
    cancelComposeFlush(resolved.nodeId);
    sendValue(resolved.control, resolved.nodeId);
  };

  const flush = (target: Element, complete = false) => {
    if (options.committedContenteditable && isContenteditableEchoField(target)) {
      const host = contenteditableHost(target);
      if (complete && editedContenteditables.has(host)) sendEditable(host);
      return;
    }
    const resolved = resolveControl(target);
    if (
      resolved === null ||
      isPasswordField(resolved.control) ||
      (!composingNodes.has(resolved.nodeId) && !(complete && editedValues.has(resolved.control)))
    )
      return;
    composingNodes.delete(resolved.nodeId);
    cancelComposeFlush(resolved.nodeId);
    sendValue(resolved.control, resolved.nodeId);
  };

  options.doc.addEventListener("input", onInput, true);
  options.doc.addEventListener("beforeinput", onBeforeInput, true);
  options.doc.addEventListener("beforeinput", afterBeforeInput);
  options.doc.addEventListener("focusin", onFocusIn, true);
  options.doc.addEventListener("change", onChange, true);
  options.doc.addEventListener("compositionstart", onCompositionStart, true);
  options.doc.addEventListener("compositionend", onCompositionEnd, true);
  const dispose = () => {
    options.doc.removeEventListener("input", onInput, true);
    options.doc.removeEventListener("beforeinput", onBeforeInput, true);
    options.doc.removeEventListener("beforeinput", afterBeforeInput);
    options.doc.removeEventListener("focusin", onFocusIn, true);
    options.doc.removeEventListener("change", onChange, true);
    options.doc.removeEventListener("compositionstart", onCompositionStart, true);
    options.doc.removeEventListener("compositionend", onCompositionEnd, true);
    composingNodes.clear();
    for (const timer of composeFlushTimers.values()) cancel(timer);
    composeFlushTimers.clear();
  };
  return { dispose, flush };
}

/** An editing host's text as sent: an editor holding only blank lines holds nothing. */
function sendableText(host: HTMLElement): string {
  const text = editableText(host);
  return text.trim() ? text : "";
}

function contenteditableHost(element: HTMLElement): HTMLElement {
  let host = element;
  while (host.parentElement !== null && isContenteditableEchoField(host.parentElement)) {
    host = host.parentElement;
  }
  return host;
}

function valueControl(target: EventTarget | null): ValueControl | null {
  if (!isElement(target)) return null;
  const tag = target.tagName.toLowerCase();
  if (tag === "select") {
    return target as HTMLSelectElement;
  }
  if (tag === "textarea") return target as HTMLTextAreaElement;
  if (tag !== "input") return null;
  const input = target as HTMLInputElement;
  return UNSUPPORTED_INPUT_TYPES.has(input.type.toLowerCase()) ? null : input;
}
