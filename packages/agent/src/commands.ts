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
  CMD_FN_NAME,
  MIRROR_NODE_FN_NAME,
  editableText,
  type AgentCmd,
  type ResolveResult,
} from "@mirror/protocol";
import { record } from "@rrweb/record";
import type { Emitter } from "./emit";

export interface NodeMirror {
  getIds(): number[];
  getNode(nodeId: number): Node | null;
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

export function resolveMirrorNode(
  nodeMirror: NodeMirror,
  crossOriginIframeMirror: CrossOriginIframeMirror | null,
  nodeId: number,
): ResolveResult | null {
  if (nodeMirror.getNode(nodeId) !== null) return { kind: "local" };
  if (crossOriginIframeMirror === null) return null;

  for (const iframeNodeId of nodeMirror.getIds()) {
    const iframe = nodeMirror.getNode(iframeNodeId);
    if (!isIframeElement(iframe)) continue;
    const mappedRemoteId = crossOriginIframeMirror.iframeRemoteIdToIdMap?.get(iframe)?.get(nodeId);
    const remoteId = mappedRemoteId ?? crossOriginIframeMirror.getRemoteId(iframe, nodeId);
    if (remoteId !== -1) return { kind: "remote", iframeNodeId, remoteId };
  }
  return null;
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

/** Rounding in the mirror moves it this far without anyone scrolling. */
const SCROLL_UP_MIN_PX = 3;

/**
 * A page that follows a live transcript to its end puts back any scroll it did not see a person
 * start, and only wheel input tells it one did. Without this it stays at the bottom while the mirror
 * shows the place the person scrolled to, and its own "scroll to bottom" control has nothing to do.
 */
function announceScrollUp(scroller: Element, y: number): void {
  const deltaY = y - scroller.scrollTop;
  if (deltaY >= -SCROLL_UP_MIN_PX) return;
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
}

export function createCommandHandler(
  emitter: Pick<Emitter, "emit">,
  dependencies: CommandDependencies = {},
): (cmd: AgentCmd) => void {
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

  const handler = (cmd: AgentCmd): void => {
    try {
      const nodeMirror = getNodeMirror();
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
            emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: false, err: "node not found" });
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
            },
          });
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
                err: "node not found",
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
            if (current !== cmd.value) {
              const document = host.ownerDocument;
              const range = document.createRange();
              range.selectNodeContents(host);
              let insert = cmd.value;
              // Preserve inline formatting when the browser text has no block separators.
              if (current.length > 0 && host.textContent === current) {
                const before = Array.from(graphemes.segment(current), (part) => part.segment);
                const after = Array.from(graphemes.segment(cmd.value), (part) => part.segment);
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
                const point = (offset: number): [Node, number] => {
                  const walker = document.createTreeWalker(host, 4);
                  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                    const length = text.textContent?.length ?? 0;
                    if (offset <= length) return [text, offset];
                    offset -= length;
                  }
                  return [host, host.childNodes.length];
                };
                range.setStart(...point(start));
                range.setEnd(...point(end));
                insert = after.slice(prefix, after.length - suffix).join("");
              }
              const selection = document.getSelection();
              if (!selection) throw new Error("editable selection unavailable");
              selection.removeAllRanges();
              selection.addRange(range);
              if (!document.execCommand("insertText", false, insert))
                throw new Error("editable update failed");
            }
            queueMicrotask(() => {
              const actual = editableText(host);
              emitter.emit({
                kind: "cmdres",
                reqId: cmd.reqId,
                ok: actual === cmd.value,
                ...(actual === cmd.value ? {} : { err: "editable text does not match" }),
              });
            });
            return;
          }
          if (!isValueControl(node)) {
            emitter.emit({
              kind: "cmdres",
              reqId: cmd.reqId,
              ok: false,
              err: "node is not a value control",
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
            setNativeValue(node, cmd.value);
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
          node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          if (cmd.commit !== false) node.dispatchEvent(new Event("change", { bubbles: true }));
          emitter.emit({ kind: "cmdres", reqId: cmd.reqId, ok: true });
          return;
        }
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

export function installCommandHandler(
  emitter: Pick<Emitter, "emit">,
  dependencies: CommandDependencies = {},
): void {
  const handler = createCommandHandler(emitter, dependencies);
  (window as unknown as Record<string, unknown>)[CMD_FN_NAME] = handler;
}

export function installMirrorNodeHelper(
  getNodeMirror: () => NodeMirror = () => record.mirror,
): void {
  const w = window as unknown as Record<string, unknown>;
  w[MIRROR_NODE_FN_NAME] = (nodeId: number): Node | null => getNodeMirror().getNode(nodeId);
}
