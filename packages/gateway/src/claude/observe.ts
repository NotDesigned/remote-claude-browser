import { randomUUID } from "node:crypto";
import type { BrowserHandle } from "../browser/launch";
import type { TargetRef } from "../types";
import { CHAT_CACHE_GLOBAL, CHAT_MESSAGE_SELECTOR } from "./extract";

/**
 * Installed in the chat observer's isolated world: wakes the poller on relevant DOM changes
 * and marks changed messages dirty in the per-message read cache.
 */
export function chatObserverExpression(binding: string): string {
  return `(() => {
    if (window.top !== window) return;
    const name = ${JSON.stringify(binding)};
    const selector = '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .ProseMirror, [contenteditable="true"], textarea, button[aria-label], button[data-testid], a[href^="/chat/"], title';
    let timer;
    const relevant = node => {
      const element = node.nodeType === 1 ? node : node.parentElement;
      return element && (element.closest(selector) || element.querySelector(selector));
    };
    const messageSelector = ${JSON.stringify(CHAT_MESSAGE_SELECTOR)};
    const cache = globalThis[${JSON.stringify(CHAT_CACHE_GLOBAL)}] = { entries: new WeakMap(), dirty: new WeakSet() };
    const markDirty = node => {
      let element = node && (node.nodeType === 1 ? node : node.parentElement);
      for (element = element && element.closest(messageSelector); element; element = element.parentElement && element.parentElement.closest(messageSelector))
        cache.dirty.add(element);
    };
    const observer = new MutationObserver(records => {
      for (const record of records) markDirty(record.target);
      if (timer || !records.some(record => relevant(record.target) || [...record.addedNodes, ...record.removedNodes].some(relevant))) return;
      timer = setTimeout(() => { timer = undefined; globalThis[name](location.href); }, 60);
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['disabled', 'aria-label', 'aria-hidden', 'aria-expanded', 'hidden', 'contenteditable', 'href', 'data-testid', 'data-state', 'download'] });
    globalThis[name + '_dispose'] = () => { observer.disconnect(); clearTimeout(timer); delete globalThis[${JSON.stringify(CHAT_CACHE_GLOBAL)}]; delete globalThis[name + '_dispose']; };
  })()`;
}

/** Private DOM invalidations let native chat sleep between actual page changes. */
export function observeChat(
  browser: BrowserHandle,
  target: TargetRef,
  changed: () => void,
  failed: (error: unknown) => void,
): { available(): boolean; contextId(): number | undefined; close(): void } {
  const binding = `mirrorChat_${randomUUID().replaceAll("-", "")}`;
  let contextId: number | undefined;
  let disposed = false,
    available = false,
    generation = 0;
  const expression = chatObserverExpression(binding);
  const send = async (method: string, params?: Record<string, unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        browser.send(target.sessionId, method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Chat observer timed out")), 2500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const install = async () => {
    const version = ++generation;
    available = false;
    const tree = (await send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } };
    if (disposed || generation !== version || !tree.frameTree?.frame?.id) return;
    const world = (await send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "mirror-native-chat",
    })) as { executionContextId: number };
    if (disposed || generation !== version) return;
    contextId = world.executionContextId;
    await send("Runtime.addBinding", { name: binding, executionContextId: contextId });
    if (disposed || generation !== version) return;
    const result = (await send("Runtime.evaluate", {
      contextId,
      expression,
      timeout: 200,
    })) as { exceptionDetails?: unknown };
    if (result.exceptionDetails) throw new Error("Chat observer execution failed");
    if (!disposed && generation === version) {
      available = true;
      changed();
    }
  };
  const removeBindingListener = browser.onSessionEvent(
    "Runtime.bindingCalled",
    (session, event) => {
      if (
        !disposed &&
        session === target.sessionId &&
        event.name === binding &&
        event.executionContextId === contextId
      )
        changed();
    },
  );
  const removeNavigationListener = browser.onSessionEvent(
    "Page.frameNavigated",
    (session, event) => {
      if (!disposed && session === target.sessionId && !event.frame.parentId) {
        changed();
        void install().catch(failed);
      }
    },
  );
  void install().catch(failed);
  return {
    available: () => available,
    contextId: () => (available ? contextId : undefined),
    close() {
      if (disposed) return;
      disposed = true;
      removeBindingListener();
      removeNavigationListener();
      if (contextId !== undefined)
        void send("Runtime.evaluate", {
          contextId,
          expression: `globalThis[${JSON.stringify(binding + "_dispose")}]?.()`,
          timeout: 200,
        }).catch(() => {});
      void send("Runtime.removeBinding", { name: binding }).catch(() => {});
    },
  };
}
