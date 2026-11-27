import type { Replayer } from "@rrweb/replay";
import type { TabId } from "@mirror/protocol";
import { attachChangeCapture } from "./change";
import { attachDefaultActionContainment, opensLocalTextMenu } from "./default-actions";
import { attachFileCapture } from "./files";
import { createForwardedInputClock } from "./forwarded";
import {
  attachKeyCapture,
  deepActiveElement,
  isEchoField,
  quietKeyboardCorrections,
  type EditableFocus,
} from "./keys";
import { createFocusFollower, followsFocusByItself } from "./focus-follow";
import { attachPxKeyboard, type PxKeyboard } from "../px-ime";
import { onRemoteFocus } from "../remote-focus";
import { attachPointerCapture, createTouchMouseFilter, type SendInput } from "./pointer";
import { attachTouchCapture } from "./touch";
import { attachWheelCapture } from "./wheel";
import { attachReadOnly } from "./read-only";
import { frameTransform } from "./caret";
import type { ProxyInput } from "./proxy-input";
import { attachScrollSync, type ScrollFilter } from "../pipeline/scroll";

export interface MirrorInputOptions {
  replayer: Replayer;
  tab: TabId;
  send: SendInput;
  onEditableFocus?(focus: EditableFocus | null): void;
  onEditableInput?(focus: EditableFocus): void;
  onKeyDown?(event: KeyboardEvent, focus: EditableFocus | null): void;
  onFileSelection?(tab: TabId, input: HTMLInputElement): void;
  onFilePickerOpened?(): void;
  onFilePickerCanceled?(tab: TabId): void;
  /** The address of a link to open in this device's browser instead of clicking it remotely. */
  linkToOpen?(target: EventTarget | null): string | null;
  openLink?(url: string): void;
  /** Files pasted into the mirror; they are uploaded to the remote page as attachments. */
  onPasteFiles?(tab: TabId, files: File[]): void;
  scrollFilter?: ScrollFilter;
  /**
   * Single-writer input (proxy-input.ts). The proxy belongs to the runtime and outlives this
   * replay; while `active()`, typing goes only to it and the replay's text fields are read-only.
   */
  proxy?: { active(): boolean; input: ProxyInput };
}

/**
 * A phone's keyboard reads a field's correction settings as it opens, which a tap does just
 * before focus, so they are set on the press as well as on focus.
 */
function quietCorrections(doc: Document): () => void {
  const quiet = (event: Event) => quietKeyboardCorrections(event.target);
  const types = ["pointerdown", "touchstart", "focusin"] as const;
  for (const type of types) doc.addEventListener(type, quiet, { capture: true, passive: true });
  return () => {
    for (const type of types) doc.removeEventListener(type, quiet, { capture: true });
  };
}

/** Install every capture listener in the rrweb document set, never above the replay iframe. */
export function attachMirrorInput(options: MirrorInputOptions): () => void {
  const rootDoc = options.replayer.iframe.contentDocument;
  if (rootDoc === null) return () => {};
  const getNodeId = (node: Node) => options.replayer.getMirror().getId(node);
  const forwardedClock = createForwardedInputClock();
  const documents = new Map<Document, () => void>();
  const watchedFrames = new Map<HTMLIFrameElement, () => void>();
  const frameDocuments = new Map<HTMLIFrameElement, { doc: Document; root: HTMLElement | null }>();
  let active = true;
  const replayFrame = options.replayer.iframe;
  let hidden: PxKeyboard | null = null;
  const follower = createFocusFollower({
    rootDoc,
    getNode: (id) => options.replayer.getMirror().getNode(id),
    followsByItself: followsFocusByItself(replayFrame.ownerDocument?.defaultView ?? null),
    hiddenKeyboard: () => {
      if (!active) return null;
      if (options.proxy?.active() === true) return options.proxy.input;
      if (hidden === null) {
        hidden = attachPxKeyboard({
          canvas: replayFrame,
          tab: options.tab,
          send: options.send,
          ownerKeys: false,
        });
        const focus = hidden.focus;
        // The IME's candidate window opens at the textarea: keep it over the page.
        hidden.focus = (point) => {
          const rect = replayFrame.getBoundingClientRect();
          focus(point ?? { clientX: rect.left + 16, clientY: rect.top + rect.height / 2 });
        };
      }
      return hidden;
    },
    focusMirror: () => replayFrame.focus?.({ preventScroll: true }),
    proxyMode: () => options.proxy?.active() === true,
  });
  const stopFollowing = onRemoteFocus(options.replayer, (focus) => {
    if (options.proxy?.active() === true) options.proxy.input.remoteFocus(focus);
    follower.remoteFocus(focus);
  });
  const viewerDoc = replayFrame.ownerDocument;

  const attachDocument = (doc: Document): void => {
    if (!active || documents.has(doc)) return;

    const cleanups: Array<() => void> = [];
    // Set the map entry before recursively walking frames so malformed frame trees cannot loop.
    documents.set(doc, () => {
      for (const cleanup of cleanups) cleanup();
    });
    cleanups.push(
      attachDefaultActionContainment({
        doc,
        ...(options.linkToOpen === undefined ? {} : { linkToOpen: options.linkToOpen }),
        ...(options.openLink === undefined ? {} : { openLink: options.openLink }),
      }),
      ...(options.onFileSelection === undefined
        ? []
        : [
            attachFileCapture({
              doc,
              tab: options.tab,
              select: options.onFileSelection,
              ...(options.onFilePickerOpened === undefined
                ? {}
                : { opened: options.onFilePickerOpened }),
              ...(options.onFilePickerCanceled === undefined
                ? {}
                : { canceled: options.onFilePickerCanceled }),
            }),
          ]),
      attachWheelCapture({ doc, rootDoc, tab: options.tab, getNodeId, send: options.send }),
      ...(options.proxy === undefined
        ? []
        : [
            attachReadOnly({
              doc,
              active: options.proxy.active,
              flush: options.proxy.input.flush,
              focus: options.proxy.input.focus,
              pressed: options.proxy.input.pressed,
              clickedElsewhere: options.proxy.input.release,
              toViewer: (point) => {
                const map = frameTransform(doc, viewerDoc);
                return map === null
                  ? point
                  : {
                      clientX: map.x + point.clientX * map.scale,
                      clientY: map.y + point.clientY * map.scale,
                    };
              },
            }),
          ]),
    );
    const change = attachChangeCapture({
      doc,
      tab: options.tab,
      getNodeId,
      send: options.send,
      forwardedClock,
      committedContenteditable: true,
      onEditableInput: options.onEditableInput,
    });
    const mouseFilter = createTouchMouseFilter();
    // What is still being composed goes out before the press does (a phone keyboard keeps a word
    // composing until a space): the press may be the send button.
    const beforePointerDown = () => {
      if (options.proxy?.active() === true) options.proxy.input.flush();
      const focused = deepActiveElement(rootDoc);
      if (focused && isEchoField(focused)) change.flush(focused, true);
    };
    cleanups.push(
      attachPointerCapture({
        doc,
        rootDoc,
        tab: options.tab,
        getNodeId,
        send: options.send,
        ignoreMouse: mouseFilter.ignore,
        opensLocally: (event) =>
          event.type === "contextmenu" || event.button === 2
            ? opensLocalTextMenu(event.target)
            : event.button === 0 &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              (options.linkToOpen?.(event.target) ?? null) !== null,
        beforePointerDown,
      }),
      attachTouchCapture({
        doc,
        rootDoc,
        tab: options.tab,
        getNodeId,
        send: options.send,
        mouseFilter,
        ...(options.linkToOpen === undefined ? {} : { linkToOpen: options.linkToOpen }),
        ...(options.openLink === undefined ? {} : { openLink: options.openLink }),
        beforePointerDown,
      }),
      change.dispose,
      follower.watch(doc),
      quietCorrections(doc),
      attachKeyCapture({
        doc,
        focusRoot: rootDoc,
        tab: options.tab,
        getNodeId,
        send: options.send,
        forwardedClock,
        flushComposing: change.flush,
        committedContenteditable: true,
        onEditableFocus: options.onEditableFocus,
        onKeyDown: options.onKeyDown,
        routeTyping: follower.routeTyping,
        onPasteFiles:
          options.onPasteFiles === undefined
            ? undefined
            : (files) => options.onPasteFiles?.(options.tab, files),
      }),
    );

    if (options.scrollFilter !== undefined) {
      cleanups.push(
        attachScrollSync({
          doc,
          rootDoc,
          tab: options.tab,
          getNodeId,
          filter: options.scrollFilter,
        }),
      );
    }

    const Observer = doc.defaultView?.MutationObserver;
    if (Observer !== undefined) {
      const root = doc.documentElement;
      const observer = new Observer((records) => {
        // rrweb can rebuild an iframe long after its load event. document.open() keeps the
        // Document but clears its input listeners, so renew them when its root is replaced.
        if (doc.documentElement !== root) {
          documents.get(doc)?.();
          documents.delete(doc);
          attachDocument(doc);
          return;
        }
        let removed = false;
        for (const record of records) {
          for (const node of record.addedNodes) discoverFrames(node);
          if (record.removedNodes.length > 0) removed = true;
        }
        // rrweb moves nodes by removing and adding them again in one batch: only what is still
        // out of the document afterwards is gone.
        if (removed) {
          for (const frame of [...watchedFrames.keys()]) {
            if (frame.isConnected === false) forgetFrame(frame);
          }
        }
      });
      observer.observe(doc, { childList: true, subtree: true });
      cleanups.push(() => observer.disconnect());
    }

    for (const frame of doc.querySelectorAll("iframe")) watchFrame(frame);
  };

  const refreshFrameSoon = (frame: HTMLIFrameElement): void => {
    // document.open() can retain Document identity while replacing its root and clearing listeners.
    // Watch for that rebuild without interrupting gestures on an unchanged child document.
    let attempts = 60;
    const refresh = () => {
      if (!active || !watchedFrames.has(frame)) return;
      attachFrameDocument(frame);
      attempts -= 1;
      if (attempts <= 0) return;
      frame.ownerDocument.defaultView?.requestAnimationFrame(refresh);
    };
    frame.ownerDocument.defaultView?.requestAnimationFrame(refresh);
  };

  const watchFrame = (frame: HTMLIFrameElement): void => {
    if (!active || watchedFrames.has(frame)) return;
    const onLoad = () => {
      attachFrameDocument(frame, true);
      refreshFrameSoon(frame);
    };
    frame.addEventListener("load", onLoad);
    watchedFrames.set(frame, () => frame.removeEventListener("load", onLoad));
    attachFrameDocument(frame);
    refreshFrameSoon(frame);
  };

  const attachFrameDocument = (frame: HTMLIFrameElement, renew = false): boolean => {
    try {
      const child = frame.contentDocument;
      if (child === null) return false;
      const previous = frameDocuments.get(frame);
      if (previous?.doc === child && previous.root === child.documentElement && !renew) return true;
      if (previous !== undefined) {
        documents.get(previous.doc)?.();
        documents.delete(previous.doc);
      }
      frameDocuments.set(frame, { doc: child, root: child.documentElement });
      attachDocument(child);
      return true;
    } catch {
      // A transient non-same-origin document is outside this same-origin document set.
      return false;
    }
  };

  /**
   * A frame the page removed: let go of its document's listeners and observer, and of every
   * frame inside that document, which would otherwise live as long as the replay.
   */
  const forgetFrame = (frame: HTMLIFrameElement): void => {
    watchedFrames.get(frame)?.();
    watchedFrames.delete(frame);
    const entry = frameDocuments.get(frame);
    frameDocuments.delete(frame);
    if (entry === undefined) return;
    documents.get(entry.doc)?.();
    documents.delete(entry.doc);
    for (const inner of [...watchedFrames.keys()]) {
      if (inner.ownerDocument === entry.doc) forgetFrame(inner);
    }
  };

  const discoverFrames = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.tagName.toLowerCase() === "iframe") watchFrame(element as HTMLIFrameElement);
    for (const frame of element.querySelectorAll("iframe")) watchFrame(frame);
  };

  attachDocument(rootDoc);
  return () => {
    active = false;
    stopFollowing();
    hidden?.dispose();
    hidden = null;
    for (const cleanup of watchedFrames.values()) cleanup();
    watchedFrames.clear();
    frameDocuments.clear();
    for (const cleanup of documents.values()) cleanup();
    documents.clear();
    forwardedClock.clear();
  };
}
