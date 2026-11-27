/**
 * The page's answer to a `fence`: what its focused field holds, emitted once every effect of the
 * input sent before the fence has reached the recorder.
 *
 * The gateway sends a fence after it dispatched input. That input's own task, the microtasks it
 * queued (an editor's DOM update, rrweb's MutationObserver callback, which emits its mutations
 * synchronously) and the command's own task have all run by the time a message posted on a
 * private MessageChannel is delivered, so the fence follows them in the binding stream. A channel
 * rather than a timer: a timer would take an id the page could notice going missing.
 *
 * The channel's methods are the ones captured when the agent was evaluated, called with
 * Reflect.apply: a page that wraps MessagePort.prototype.postMessage or the onmessage setter
 * never sees a port it did not make.
 *
 * The fence carries the field's length, editHash and selection, never its text, except for the
 * submit guard (`text`), whose text stays in the gateway. A submit-guard fence is answered at
 * once: the guard compares what the field holds before Enter, and the gateway does not hold Enter
 * back for it unless the guard may refuse. Passwords, and fields that were passwords (a "show
 * password" toggle; rrweb keeps masking them), report their length only.
 */
import {
  editableOffset,
  editableText,
  editHash,
  normalizeEditableText,
  type AgentMsg,
  type EditState,
} from "@mirror/protocol";
import { deepFocusedElement, describeFocus } from "./focus-report";

/** Captured when the agent is evaluated, before any page script could replace them. */
const NativeMessageChannel: typeof MessageChannel | undefined = globalThis.MessageChannel;
const PortProto: object | undefined = globalThis.MessagePort?.prototype;
const nativePostMessage: ((this: MessagePort, message: unknown) => void) | undefined =
  PortProto === undefined
    ? undefined
    : (Reflect.getOwnPropertyDescriptor(PortProto, "postMessage")?.value as
        ((this: MessagePort, message: unknown) => void) | undefined);
const nativeSetOnMessage: ((this: MessagePort, handler: unknown) => void) | undefined =
  PortProto === undefined ? undefined : findSetter(PortProto, "onmessage");
const nativeQueueMicrotask: typeof queueMicrotask | undefined = globalThis.queueMicrotask;
const nativeHasAttribute = globalThis.Element?.prototype.hasAttribute;

function findSetter(proto: object, key: string) {
  for (let at: object | null = proto; at !== null; at = Reflect.getPrototypeOf(at)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(at, key);
    if (descriptor !== undefined)
      return descriptor.set as ((this: MessagePort, v: unknown) => void) | undefined;
  }
  return undefined;
}

/** rrweb marks a field that was a password once its `type` changes, and keeps masking it. */
const RR_PASSWORD = "data-rr-is-password";

function wasPassword(element: Element): boolean {
  try {
    return nativeHasAttribute === undefined
      ? element.hasAttribute(RR_PASSWORD)
      : Reflect.apply(nativeHasAttribute, element, [RR_PASSWORD]) === true;
  } catch {
    return false;
  }
}

export interface FenceOptions {
  emitter: { emit(message: AgentMsg): void };
  docId: number;
  /** The recorder's id for a node, or -1. */
  getId(node: Node): number;
  document: Document;
  MessageChannel?: typeof MessageChannel;
}

export interface FenceCommand {
  reqId: number;
  n: number;
  text?: boolean;
}

/** The editing host around the focused element of `document`, if it is in one. */
export function focusedEditingHost(document: Document): HTMLElement | null {
  let active = document.activeElement as HTMLElement | null;
  if (active === null || !active.isContentEditable) return null;
  while (active.parentElement?.isContentEditable) active = active.parentElement;
  return active;
}

/** What a fence reports, and the text itself for the submit guard. */
export function readFocusedField(
  document: Document,
  getId: (node: Node) => number,
): { edit: EditState | null; text: string | null } {
  const active = deepFocusedElement(document);
  if (active === null) return { edit: null, text: null };
  // Focus inside a cross-origin frame: that frame's recorder has the field (a P0 limit).
  if (active.tagName.toLowerCase() === "iframe")
    return { edit: { node: -1, len: 0, hash: "", sel: [0, 0] }, text: null };
  const focus = describeFocus(active);
  if (!focus.editable) return { edit: null, text: null };
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const control = active as HTMLInputElement | HTMLTextAreaElement;
    const value = control.value ?? "";
    const node = getId(control);
    const start =
      typeof control.selectionStart === "number" ? control.selectionStart : value.length;
    const end = typeof control.selectionEnd === "number" ? control.selectionEnd : start;
    if (focus.password === true || wasPassword(control))
      return { edit: { node, len: value.length, hash: "", sel: [start, end] }, text: null };
    const text = normalizeEditableText(value);
    const clamp = (at: number) => Math.max(0, Math.min(at, text.length));
    return {
      edit: { node, len: text.length, hash: editHash(value), sel: [clamp(start), clamp(end)] },
      text,
    };
  }
  const host = focusedEditingHost(active.ownerDocument);
  if (host === null) return { edit: null, text: null };
  const raw = editableText(host);
  const text = normalizeEditableText(raw);
  const clamp = (at: number) => Math.max(0, Math.min(at, text.length));
  let sel: [number, number] = [text.length, text.length];
  const selection = host.ownerDocument.getSelection?.() ?? null;
  if (selection !== null && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const start = editableOffset(host, range.startContainer, range.startOffset);
    const end = editableOffset(host, range.endContainer, range.endOffset);
    if (start >= 0 && end >= 0) sel = [clamp(start), clamp(end)];
  }
  return { edit: { node: getId(host), len: text.length, hash: editHash(raw), sel }, text };
}

/**
 * The fence command's handler. Each fence is answered after one hop through a private channel;
 * fences are answered in the order they came.
 */
export function createFence(options: FenceOptions): (command: FenceCommand) => void {
  const Channel = options.MessageChannel ?? NativeMessageChannel;
  const waiting: FenceCommand[] = [];
  let port: MessagePort | null = null;

  const answer = (command: FenceCommand) => {
    let read: ReturnType<typeof readFocusedField>;
    try {
      read = readFocusedField(options.document, options.getId);
    } catch {
      read = { edit: null, text: null };
    }
    options.emitter.emit({
      kind: "fence",
      docId: options.docId,
      n: command.n,
      edit: read.edit,
      ...(command.text === true && read.text !== null ? { text: read.text } : {}),
    });
    options.emitter.emit({ kind: "cmdres", reqId: command.reqId, ok: true });
  };

  const post = (target: MessagePort) => {
    if (nativePostMessage !== undefined && options.MessageChannel === undefined)
      Reflect.apply(nativePostMessage, target, [0]);
    else target.postMessage(0);
  };
  const listen = (target: MessagePort, handler: () => void) => {
    if (nativeSetOnMessage !== undefined && options.MessageChannel === undefined)
      Reflect.apply(nativeSetOnMessage, target, [handler]);
    else target.onmessage = handler;
  };

  return (command) => {
    // The submit guard reads the field as it is when the command runs, before Enter.
    if (command.text === true) {
      answer(command);
      return;
    }
    if (Channel === undefined) {
      // No channel to wait on: a microtask still runs after the command's own task.
      const run = () => answer(command);
      if (nativeQueueMicrotask !== undefined)
        Reflect.apply(nativeQueueMicrotask, globalThis, [run]);
      else queueMicrotask(run);
      return;
    }
    if (port === null) {
      const channel = new Channel();
      listen(channel.port1, () => {
        const next = waiting.shift();
        if (next !== undefined) answer(next);
      });
      // Node's ports would otherwise keep a test process alive; browsers have no unref.
      (channel.port1 as MessagePort & { unref?: () => void }).unref?.();
      port = channel.port2;
    }
    waiting.push(command);
    post(port);
  };
}
