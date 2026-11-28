/**
 * Gateway -> page command handler.
 *
 * Production retains this handler in a MAIN-world closure reached by a randomized isolated-world
 * relay; the standalone legacy bundle still exposes `window.__mirror_cmd`.
 * Responses return through the binding as `cmdres` matched by reqId. The command set in
 * @mirror/protocol is the complete v1 agent API surface. Extend it only through a reviewed
 * protocol change.
 */
import {
  NODE_IN_FRAME_ERROR,
  editablePoint,
  editableText,
  normalizeEditableText,
  sameEditableText,
  type AgentCmd,
  type ResolveResult,
} from "@mirror/protocol";
import { record } from "@rrweb/record";
import type { Emitter } from "./emit";
import { isHardened } from "./config";
import {
  SCROLL_UP_MIN_PX,
  WHEEL_MAX_PX,
  defaultWheelPointDom,
  scrollUpWheelPoint,
  type WheelPointDom,
} from "./wheel-point";
import { createFence, focusedEditingHost } from "./fence";
import { revealCaret } from "./caret-view";

export interface NodeMirror {
  getIds(): number[];
  getNode(nodeId: number): Node | null;
  /** The recorder's id for a node, or -1 (rrweb's mirror has it). */
  getId?(node: Node): number;
}

export interface CrossOriginIframeMirror {
  iframeRemoteIdToIdMap?: WeakMap<HTMLIFrameElement, Map<number, number>>;
  getRemoteId(iframe: HTMLIFrameElement, nodeId: number): number;
}

export interface RecordReadiness {
  isStarted(): boolean;
  onStarted(listener: () => void): () => void;
  waitUntilStarted(timeoutMs: number): Promise<boolean>;
}

export interface RecordReadinessController extends RecordReadiness {
  markStarted(): void;
}

export interface CommandDependencies {
  getNodeMirror?: () => NodeMirror;
  getCrossOriginIframeMirror?: () => CrossOriginIframeMirror | null;
  recordReadiness?: RecordReadiness;
  snapshotReadyTimeoutMs?: number;
  takeFullSnapshot?: () => void;
  /** Timers for re-checking an editor after an edit; tests replace them. */
  schedule?: (callback: () => void, delayMs: number) => void;
  editableSettleDelaysMs?: readonly number[];
  /** Hit testing for `wheelpoint`; tests replace it. */
  wheelPointDom?: WheelPointDom;
  /** The document a fence reads the focused field of, and its channel; tests replace them. */
  fenceDocument?: Document;
  fenceChannel?: typeof MessageChannel;
}

const DEFAULT_SNAPSHOT_READY_TIMEOUT_MS = 2_000;
const SNAPSHOT_RETRY_ERROR = "recorder not ready; retry snapshot";

export function createRecordReadiness(): RecordReadinessController {
  let started = false;
  const listeners = new Set<() => void>();
  const waiters = new Set<() => void>();

  return {
    isStarted: () => started,
    onStarted(listener) {
      if (started) {
        queueMicrotask(listener);
        return () => undefined;
      }

      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitUntilStarted(timeoutMs) {
      if (started) return Promise.resolve(true);

      return new Promise((resolve) => {
        const onStarted = () => {
          clearTimeout(timer);
          waiters.delete(onStarted);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(onStarted);
          resolve(false);
        }, timeoutMs);
        waiters.add(onStarted);
      });
    },
    markStarted() {
      if (started) return;
      started = true;
      for (const waiter of [...waiters]) waiter();
      // rrweb exposes the initial FullSnapshot from inside its startup call stack. Defer readiness
      // listeners until that stack has completed before they are allowed to request a checkout.
      for (const listener of [...listeners]) queueMicrotask(listener);
      listeners.clear();
    },
  };
}

function getMirrorNode(nodeMirror: NodeMirror, nodeId: number): Node | null {
  const node = nodeMirror.getNode(nodeId);
  return node?.isConnected === true ? node : null;
}

function isIframeElement(node: Node | null): node is HTMLIFrameElement {
  return node?.nodeType === 1 && node.nodeName === "IFRAME";
}

/**
 * The ids of the frames a recorder last found. Finding them means walking every node id the
 * recorder has, which a page with a cross-origin frame paid twice for each pointer move or scroll
 * in it (`rect`, then `resolve`). Frames come and go rarely; a node found in none of these still
 * walks everything, so a new frame is never missed.
 */
export interface FrameIdCache {
  ids: number[] | null;
}

export function resolveMirrorNode(
  nodeMirror: NodeMirror,
  crossOriginIframeMirror: CrossOriginIframeMirror | null,
  nodeId: number,
  frames: FrameIdCache = { ids: null },
): ResolveResult | null {
  if (nodeMirror.getNode(nodeId) !== null) return { kind: "local" };
  if (crossOriginIframeMirror === null) return null;

  const findIn = (frameIds: Iterable<number>): ResolveResult | null => {
    for (const iframeNodeId of frameIds) {
      const iframe = nodeMirror.getNode(iframeNodeId);
      if (!isIframeElement(iframe)) continue;
      const mappedRemoteId = crossOriginIframeMirror.iframeRemoteIdToIdMap
        ?.get(iframe)
        ?.get(nodeId);
      const remoteId = mappedRemoteId ?? crossOriginIframeMirror.getRemoteId(iframe, nodeId);
      if (remoteId !== -1) return { kind: "remote", iframeNodeId, remoteId };
    }
    return null;
  };
  if (frames.ids !== null) {
    const found = findIn(frames.ids);
    if (found !== null) return found;
  }
  frames.ids = nodeMirror.getIds().filter((id) => isIframeElement(nodeMirror.getNode(id)));
  return findIn(frames.ids);
}

function isElement(node: Node | null): node is Element {
  return node?.nodeType === Node.ELEMENT_NODE;
}

function isValueControl(
  node: Node | null,
): node is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!isElement(node)) return false;
  const view = node.ownerDocument.defaultView;
  return (
    view !== null &&
    (node instanceof view.HTMLInputElement ||
      node instanceof view.HTMLTextAreaElement ||
      node instanceof view.HTMLSelectElement)
  );
}

function toRootViewport(x: number, y: number, document: Document): { x: number; y: number } {
  let current = document;
  const visited = new Set<Document>();
  while (!visited.has(current)) {
    visited.add(current);
    const frame = current.defaultView?.frameElement;
    if (frame === null || frame === undefined) break;
    const rect = frame.getBoundingClientRect();
    x += rect.left + frame.clientLeft;
    y += rect.top + frame.clientTop;
    current = frame.ownerDocument;
  }
  return { x, y };
}

function setNativeValue(
  node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const view = node.ownerDocument.defaultView;
  if (view === null) throw new Error("element has no window");
  const prototype =
    node instanceof view.HTMLInputElement
      ? view.HTMLInputElement.prototype
      : node instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("element has no native value setter");
  setter.call(node, value);
}

function setNativeChecked(node: HTMLInputElement, checked: boolean): void {
  const view = node.ownerDocument.defaultView;
  if (view === null) throw new Error("element has no window");
  const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "checked")?.set;
  if (setter === undefined) throw new Error("element has no native checked setter");
  setter.call(node, checked);
}

function setNativeSelectedValues(node: HTMLSelectElement, values: string[]): void {
  const view = node.ownerDocument.defaultView;
  if (view === null) throw new Error("element has no window");
  const setter = Object.getOwnPropertyDescriptor(view.HTMLOptionElement.prototype, "selected")?.set;
  if (setter === undefined) throw new Error("option has no native selected setter");
  const selectedValues = new Set(values);
  for (const option of node.options) setter.call(option, selectedValues.has(option.value));
}

/** The gateway's wheel for a scroll up lands within this long. */
const WHEEL_SETTLE_MS = 1_000;
/** Scroller -> the hold on its position after the latest scroll up, until the wheel has landed. */
const wheelHolds = new WeakMap<Element, () => void>();

/**
 * A page that follows a live transcript to its end puts back any scroll it did not see a person
 * start, and only wheel input tells it one did. Without this it stays at the bottom while the mirror
 * shows the place the person scrolled to, and its own "scroll to bottom" control has nothing to do.
 */
function announceScrollUp(scroller: Element, y: number): void {
  // Hardening: a page can see this event is not trusted. The gateway sends real wheel input for a
  // scroll up instead (gateway/src/input/scroll-announce.ts), before this command, at the point
  // `wheelpoint` chose from this page's live position (wheel-point.ts). Chromium may
  // apply that wheel's scroll after the exact position below, as a further step up, so the position
  // is put back once if the scroll that ends next leaves it at most one wheel above.
  if (isHardened()) {
    wheelHolds.get(scroller)?.();
    if (y >= scroller.scrollTop - 1) return;
    const doc = scroller.ownerDocument;
    const target: EventTarget = scroller === doc.scrollingElement ? doc : scroller;
    const until = performance.now() + WHEEL_SETTLE_MS;
    const release = (): void => {
      target.removeEventListener("scrollend", onEnd, true);
      if (wheelHolds.get(scroller) === release) wheelHolds.delete(scroller);
    };
    const onEnd = (): void => {
      if (performance.now() > until) return release();
      const above = y - scroller.scrollTop;
      if (above <= 0.5 || above > WHEEL_MAX_PX + 1) return;
      release();
      scroller.scrollTop = y;
    };
    wheelHolds.set(scroller, release);
    target.addEventListener("scrollend", onEnd, true);
    return;
  }
  const deltaY = y - scroller.scrollTop;
  if (deltaY >= -SCROLL_UP_MIN_PX) return;
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
}

/**
 * An exact check one microtask after an edit reported failures that were not failures and blocked
 * the user's Enter: rich editors rebuild their DOM a moment later and store a typed space as
 * U+00A0. The comparison that ignores what no reader could see is shared through the protocol.
 */
export { normalizeEditableText, sameEditableText };

/** When to look again after the edit: about 100 ms in all, which a rich editor settles within. */
const EDITABLE_SETTLE_DELAYS_MS = [0, 16, 34, 50];

/**
 * Resolves true as soon as the editor shows the expected text. Past the last look it is also true
 * when the editor took the edit and made something of its own from it, and has stopped changing:
 * its text is no longer what it was before the edit (`before`) and the last two looks agree. That
 * is a page rewriting what was typed (ProseMirror's input rules turn "--" into "—", Markdown
 * shortcuts and smart quotes do the same), which is the page's answer, not a lost edit. An edit
 * that never reached the editor leaves its text as it was, and that stays a failure. The gateway
 * gives a command 3 s, far longer than these ~100 ms.
 */
export async function settleEditable(
  read: () => string | null,
  expected: string,
  schedule: (callback: () => void, delayMs: number) => void,
  delaysMs: readonly number[] = EDITABLE_SETTLE_DELAYS_MS,
  before?: string,
): Promise<boolean> {
  await Promise.resolve();
  let previous: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const actual = read();
    if (actual !== null && sameEditableText(actual, expected)) return true;
    if (attempt >= delaysMs.length)
      return (
        before !== undefined &&
        actual !== null &&
        previous !== null &&
        sameEditableText(actual, previous) &&
        !sameEditableText(actual, before)
      );
    previous = actual;
    await new Promise<void>((resolve) => schedule(resolve, delaysMs[attempt]!));
  }
}

/** Equal-length folding for comparing a page's text with a viewer's: U+00A0 reads as a space. */
const foldSpaces = (text: string) => text.replace(/\u00a0/g, " ");

/**
 * The text the page's editor should hold after a viewer's edit, made against what the page holds
 * now rather than against what the viewer saw.
 *
 * The viewer edits its own copy of the editor and sends the whole text (`value`) with the text it
 * edited (`base`). Most of the time the page holds `base` too. When it does not, the page changed
 * the editor meanwhile: it cleared it after sending a message, or rewrote what was typed. Setting
 * the page to `value` would undo that and, after a send, put the message just sent back into the
 * composer. Instead the one change from `base` to `value` is made at the same place in the page's
 * text: typing at the end goes on at the end, an edit elsewhere is found by the unchanged text
 * before or after it.
 *
 * When neither is still there, the edit was made on text the page no longer has, and the page's
 * text stands: the viewer catches up with it. Above all that is a composer the page cleared after
 * sending, while the viewer still showed the message: a Backspace, or a phone keyboard's
 * autocorrect replacing the last word as Return or the send button is tapped, edits the message
 * just sent. Taking the viewer's whole text then put that message back into the page's composer.
 */
export function rebaseEditable(
  current: string,
  base: string,
  value: string,
  split: (text: string) => string[] = (text) => Array.from(text),
): string {
  if (sameEditableText(current, base)) return value;
  const was = split(base);
  const now = split(value);
  let prefix = 0;
  while (prefix < was.length && prefix < now.length && was[prefix] === now[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < was.length - prefix &&
    suffix < now.length - prefix &&
    was[was.length - suffix - 1] === now[now.length - suffix - 1]
  )
    suffix++;
  // Nothing was edited (a flush of text already sent): what the page made of it stands.
  if (prefix === was.length && prefix === now.length) return current;
  const before = was.slice(0, prefix).join("");
  const removed = was.slice(prefix, was.length - suffix).join("");
  const after = was.slice(was.length - suffix).join("");
  const insert = now.slice(prefix, now.length - suffix).join("");
  const page = foldSpaces(current);
  const at = (position: number) =>
    current.slice(0, position) + insert + current.slice(position + removed.length);
  const fromStart = () =>
    page.startsWith(foldSpaces(before + removed)) ? at(before.length) : null;
  const fromEnd = (end: number) =>
    foldSpaces(page.slice(0, end)).endsWith(foldSpaces(removed + after))
      ? at(end - removed.length - after.length)
      : null;
  if (after === "") {
    // At the end of the text: on at the end of the page's text, before an editor's closing break.
    const end = base.endsWith("\n") ? current.length : current.replace(/\n+$/, "").length;
    return fromEnd(end) ?? fromStart() ?? current;
  }
  return fromStart() ?? fromEnd(current.length) ?? current;
}

export { focusedEditingHost };

export function createCommandHandler(
  emitter: Pick<Emitter, "emit"> & { readonly docId?: number },
  dependencies: CommandDependencies = {},
): (cmd: AgentCmd) => void {
  const schedule =
    dependencies.schedule ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const settleDelaysMs = dependencies.editableSettleDelaysMs ?? EDITABLE_SETTLE_DELAYS_MS;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const getNodeMirror = dependencies.getNodeMirror ?? (() => record.mirror);
  const takeFullSnapshot = dependencies.takeFullSnapshot ?? (() => record.takeFullSnapshot(true));
  const snapshotReadyTimeoutMs =
    dependencies.snapshotReadyTimeoutMs ?? DEFAULT_SNAPSHOT_READY_TIMEOUT_MS;

  const emitSnapshot = (reqId: number): void => {
    try {
      takeFullSnapshot();
      emitter.emit({ kind: "cmdres", reqId, ok: true });
    } catch {
      // Readiness is deliberately the only rrweb state exposed to callers. In particular, never
      // leak rrweb's "please take full snapshot after start recording" startup exception.
      emitter.emit({ kind: "cmdres", reqId, ok: false, err: SNAPSHOT_RETRY_ERROR });
    }
  };

  const frames: FrameIdCache = { ids: null };
  const wheelDom = dependencies.wheelPointDom ?? defaultWheelPointDom(toRootViewport);
  let fence: ReturnType<typeof createFence> | null = null;
  const handler = (cmd: AgentCmd): void => {
    try {
      const nodeMirror = getNodeMirror();
      /** A node this frame does not have may belong to a cross-origin frame inside it. */
      const missing = (nodeId: number) =>
        resolveMirrorNode(
          nodeMirror,
          dependencies.getCrossOriginIframeMirror?.() ?? null,
          nodeId,
          frames,
        )?.kind === "remote"
          ? NODE_IN_FRAME_ERROR
          : "node not found";
      switch (cmd.cmd) {
        case "snapshot": {
          const readiness = dependencies.recordReadiness;
          if (readiness === undefined || readiness.isStarted()) {
            emitSnapshot(cmd.reqId);
            return;
          }
          void readiness.waitUntilStarted(snapshotReadyTimeoutMs).then((started) => {
            if (!started) {
              emitter.emit({
                kind: "cmdres",
                reqId: cmd.reqId,
                ok: false,
                err: SNAPSHOT_RETRY_ERROR,
              });
              return;
            }
            // Starting has just produced the snapshot that was asked for.
            emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true });
          });
          return;
        }
        case "resolve": {
          const result = resolveMirrorNode(
            nodeMirror,
            dependencies.getCrossOriginIframeMirror?.() ?? null,
            cmd.nodeId,
            frames,
          );
          if (result === null) {
            emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: false, err: "node not found" });
            return;
          }
          emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true, data: result });
          return;
        }
        case "rect": {
          const node = getMirrorNode(nodeMirror, cmd.nodeId);
          if (!isElement(node)) {
            emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: false, err: missing(cmd.nodeId) });
            return;
          }
          const rect = node.getBoundingClientRect();
          const rootPosition = toRootViewport(rect.x, rect.y, node.ownerDocument);
          const style = getComputedStyle(node);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < innerHeight &&
            rect.left < innerWidth &&
            style.display !== "none" &&
            style.visibility !== "hidden";
          emitter.emit({
            kind: "cmdres",
            reqId: cmd.reqId,
            ok: true,
            data: {
              x: rootPosition.x,
              y: rootPosition.y,
              w: rect.width,
              h: rect.height,
              visible,
              // A frame's content starts inside its border.
              ...(isIframeElement(node)
                ? { borderLeft: node.clientLeft, borderTop: node.clientTop }
                : {}),
            },
          });
          return;
        }
        case "wheelpoint": {
          // Where the gateway's trusted wheel for this scroll up goes, decided from where the
          // page is now; null for no wheel.
          const scroller =
            cmd.nodeId === 0 ? document.scrollingElement : getMirrorNode(nodeMirror, cmd.nodeId);
          if (cmd.nodeId !== 0 && !isElement(scroller)) {
            emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: false, err: missing(cmd.nodeId) });
            return;
          }
          const data = isElement(scroller) ? scrollUpWheelPoint(scroller, cmd.y, wheelDom) : null;
          emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true, data });
          return;
        }
        case "scroll": {
          if (cmd.nodeId === 0) {
            const root = document.scrollingElement;
            if (root !== null) announceScrollUp(root, cmd.y);
            window.scrollTo(cmd.x, cmd.y);
          } else {
            const node = getMirrorNode(nodeMirror, cmd.nodeId);
            if (!isElement(node)) {
              emitter.emit({
                kind: "cmdres",
                reqId: cmd.reqId,
                ok: false,
                err: missing(cmd.nodeId),
              });
              return;
            }
            announceScrollUp(node, cmd.y);
            node.scrollTo(cmd.x, cmd.y);
          }
          emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true });
          return;
        }
        case "value": {
          const node = getMirrorNode(nodeMirror, cmd.nodeId);
          if (isElement(node) && (node as HTMLElement).isContentEditable) {
            const host = node as HTMLElement;
            if (cmd.checked !== undefined || cmd.values !== undefined)
              throw new Error("invalid editable value");
            host.focus({ preventScroll: true });
            const current = editableText(host);
            const segment = (text: string) =>
              Array.from(graphemes.segment(text), (part) => part.segment);
            const wanted =
              cmd.base === undefined
                ? cmd.value
                : rebaseEditable(current, cmd.base, cmd.value, segment);
            if (current !== wanted) {
              const document = host.ownerDocument;
              const range = document.createRange();
              range.selectNodeContents(host);
              let insert = wanted;
              // Only the text that changed is replaced, between points found by the editor's text
              // with its line breaks: inline formatting stays, and so does the rest of an editor of
              // many paragraphs (a long paste). Replacing all of it would empty the editor's box
              // for a moment, which puts the box back at its top.
              if (current.length > 0) {
                const before = segment(current);
                const after = segment(wanted);
                let prefix = 0;
                while (
                  prefix < before.length &&
                  prefix < after.length &&
                  before[prefix] === after[prefix]
                )
                  prefix++;
                let suffix = 0;
                while (
                  suffix < before.length - prefix &&
                  suffix < after.length - prefix &&
                  before[before.length - suffix - 1] === after[after.length - suffix - 1]
                )
                  suffix++;
                const start = before.slice(0, prefix).join("").length;
                const end = current.length - before.slice(before.length - suffix).join("").length;
                const from = editablePoint<Node>(host, start);
                const to = start === end ? from : editablePoint<Node>(host, end);
                if (from !== null && to !== null) {
                  range.setStart(from.container, from.offset);
                  range.setEnd(to.container, to.offset);
                  insert = after.slice(prefix, after.length - suffix).join("");
                }
              }
              const selection = document.getSelection();
              if (!selection) throw new Error("editable selection unavailable");
              selection.removeAllRanges();
              selection.addRange(range);
              if (!document.execCommand("insertText", false, insert))
                throw new Error("editable update failed");
              // Where typing would have left the editor's box: at the caret. After the editor
              // has redrawn what it was given (its own update runs in a microtask).
              queueMicrotask(() => revealCaret(host));
            }
            const expected = wanted;
            const reqId = cmd.reqId;
            void settleEditable(
              () => {
                // A framework can re-render the editor and replace the host after the edit. The
                // focused editing host is then the same editor, not a different field.
                const current = host.isConnected ? host : focusedEditingHost(host.ownerDocument);
                return current === null ? null : editableText(current);
              },
              expected,
              schedule,
              settleDelaysMs,
              current,
            ).then((matched) => {
              emitter.emit({
                kind: "cmdres",
                reqId,
                ok: matched,
                ...(matched ? {} : { err: "editable text does not match" }),
              });
            });
            return;
          }
          if (!isValueControl(node)) {
            emitter.emit({
              kind: "cmdres",
              reqId: cmd.reqId,
              ok: false,
              // A field the page removed is gone, not some other kind of node.
              err: node === null ? "node not found" : "node is not a value control",
            });
            return;
          }
          const view = node.ownerDocument.defaultView;
          if (view === null) throw new Error("element has no window");
          let dispatchCheckedClick = false;
          if (cmd.checked !== undefined) {
            if (
              !(node instanceof view.HTMLInputElement) ||
              (node.type.toLowerCase() !== "checkbox" && node.type.toLowerCase() !== "radio")
            ) {
              throw new Error("checked state requires a checkbox or radio");
            }
            setNativeChecked(node, cmd.checked);
            dispatchCheckedClick = true;
          } else if (cmd.values !== undefined) {
            if (!(node instanceof view.HTMLSelectElement) || !node.multiple) {
              throw new Error("selected values require a multiple select");
            }
            setNativeSelectedValues(node, cmd.values);
          } else {
            if (cmd.edit !== undefined) {
              if (!(node instanceof view.HTMLInputElement))
                throw new Error("password edit requires an input");
              if (typeof cmd.edit === "string") {
                node.focus({ preventScroll: true });
                node.ownerDocument.execCommand(cmd.edit);
              } else if (cmd.edit.start !== cmd.edit.end || cmd.value !== "") {
                node.focus({ preventScroll: true });
                node.setSelectionRange(cmd.edit.start, cmd.edit.end);
                if (!node.ownerDocument.execCommand("insertText", false, cmd.value))
                  throw new Error("password edit failed");
              }
            } else setNativeValue(node, cmd.value);
            if (
              (node instanceof view.HTMLInputElement || node instanceof view.HTMLTextAreaElement) &&
              cmd.selectionStart !== undefined &&
              cmd.selectionEnd !== undefined
            ) {
              const start = Math.max(0, Math.min(cmd.selectionStart, node.value.length));
              const end = Math.max(start, Math.min(cmd.selectionEnd, node.value.length));
              node.setSelectionRange(start, end);
            }
          }
          // React's ChangeEventPlugin observes checkbox/radio state through `click`, not `change`.
          // A base Event does not run native checkbox activation, so the state set above is stable.
          if (dispatchCheckedClick) {
            node.dispatchEvent(new Event("click", { bubbles: true, composed: true }));
          }
          // Native password edits already emitted input and populated the browser undo stack.
          if (cmd.edit === undefined)
            node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          if (cmd.commit !== false) node.dispatchEvent(new Event("change", { bubbles: true }));
          emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true });
          return;
        }
        case "fence":
          fence ??= createFence({
            emitter,
            docId: emitter.docId ?? 0,
            getId: (node) => getNodeMirror().getId?.(node) ?? -1,
            document: dependencies.fenceDocument ?? document,
            ...(dependencies.fenceChannel ? { MessageChannel: dependencies.fenceChannel } : {}),
          });
          fence(cmd);
          return;
        case "ping":
          emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true, data: "pong" });
          return;
        default:
          emitter.emit({
            kind: "cmdres",
            reqId: (cmd as AgentCmd).reqId,
            ok: false,
            err: `unknown command: ${String((cmd as { cmd?: unknown }).cmd)}`,
          });
      }
    } catch (e) {
      emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: false, err: String(e) });
    }
  };
  return handler;
}
