/** Per-client CDP facade over a shared Chrome/Profile. Ownership is enforced before dispatch. */
import type { TargetRef } from "../types";
import type {
  BrowserHandle,
  BrowserSessionEventMap,
  BrowserTargetInfo,
  FlatSessionEventMap,
} from "./launch";

export interface ClientBrowserScope extends BrowserHandle {
  readonly sid: string;
  ownsTarget(targetId: string): boolean;
  targets(): TargetRef[];
  /** Stop facade callbacks without closing the physical browser or releasing live ownership. */
  dispose(): void;
}

export interface ClientBrowserPool {
  scope(sid: string): ClientBrowserScope;
  /** Reserve/claim a root page. This also adopts its popups and attached iframe descendants. */
  adopt(sid: string, targetId: string): void;
  ownerOf(targetId: string): string | undefined;
  unownedPages(): TargetRef[];
  /** Unsubscribe and forget pool bookkeeping; the caller still owns physical Chrome shutdown. */
  dispose(): void;
}

interface ScopeState {
  sid: string;
  facade: ClientBrowserScope;
  disposed: boolean;
  closing: boolean;
  attached: Set<(target: TargetRef) => void>;
  detached: Set<(target: TargetRef) => void>;
  metadata: Set<(info: BrowserTargetInfo) => void>;
  unsubscribe: Set<() => void>;
  pendingCreates: Map<string, { resolve(): void; reject(error: Error): void }>;
  creates: Set<Promise<unknown>>;
  closePromise?: Promise<void>;
}

const CREATE_ATTACH_TIMEOUT_MS = 10_000;
const LOGIN_CHECK_MS = 5_000;
/** Fits every new window in the part of the screen left of the picture slots. */
const WINDOW_OFFSET_STEP = 10;
const WINDOW_OFFSETS = 24;

export interface ClientBrowserPoolOptions {
  /** Someone signed in, so pages waiting on a sign-in screen can leave it. */
  onSignedIn?(): void;
  /** Each check of the login cookie: whether it is signed in, and whether the login changed. */
  onLoginState?(signedIn: boolean, changed: boolean): void;
  /** New windows open this size, as a maximised window on the account's screen would be. */
  windowSize?: { width: number; height: number };
}

export function createClientBrowserPool(
  browser: BrowserHandle,
  options: ClientBrowserPoolOptions = {},
): ClientBrowserPool {
  const targets = new Map<string, TargetRef>();
  const sessions = new Map<string, string>();
  const infos = new Map<string, BrowserTargetInfo>();
  let openedWindows = 0;
  const owners = new Map<string, string>();
  // A createTarget acknowledgement reserves a page even before its flat session attaches.
  const createdRoots = new Set<string>();
  // A disposed facade's late create result must not appear in a replacement with the same SID.
  const retiredTargets = new Set<string>();
  const scopes = new Map<string, ScopeState>();
  let disposed = false;

  const liveScope = (sid: string) => {
    const state = scopes.get(sid);
    return state === undefined || state.disposed ? undefined : state;
  };
  const emitAttached = (sid: string, target: TargetRef) => {
    const state = liveScope(sid);
    if (!state || state.closing) return;
    for (const callback of state.attached) callback(target);
    const info = infos.get(target.targetId);
    if (info) for (const callback of state.metadata) callback(info);
  };
  const inheritedOwner = (target: TargetRef): string | undefined => {
    const parent = target.type === "iframe" ? target.parentTargetId : target.openerTabId;
    return parent === undefined || retiredTargets.has(parent) ? undefined : owners.get(parent);
  };
  const claim = (sid: string, targetId: string): void => {
    const previous = owners.get(targetId);
    if (previous !== undefined && previous !== sid)
      throw new Error("Browser target belongs to another client session");
    if (previous === sid) return;
    owners.set(targetId, sid);
    const target = targets.get(targetId);
    if (target) emitAttached(sid, target);
    // A child can attach before the new root's createTarget acknowledgement or adoption.
    for (const child of targets.values()) {
      if (!owners.has(child.targetId) && inheritedOwner(child) === sid) claim(sid, child.targetId);
    }
  };

  browser.onAttached((target) => {
    if (disposed) return;
    const previous = targets.get(target.targetId);
    if (previous?.sessionId === target.sessionId) return;
    if (previous) sessions.delete(previous.sessionId);
    targets.set(target.targetId, target);
    sessions.set(target.sessionId, target.targetId);
    if (retiredTargets.has(target.targetId)) return;
    const owner = owners.get(target.targetId);
    if (owner !== undefined) {
      emitAttached(owner, target);
      liveScope(owner)?.pendingCreates.get(target.targetId)?.resolve();
    } else {
      const parentOwner = inheritedOwner(target);
      if (parentOwner === undefined) return;
      if (target.type !== "page") {
        claim(parentOwner, target.targetId);
        return;
      }
      // A session starts reading a claimed page at once. Every other listener for this attach has to
      // have run first, or the agent link has nothing to give it and the page stays unmirrored.
      queueMicrotask(() => {
        if (disposed || targets.get(target.targetId) !== target) return;
        if (!owners.has(target.targetId)) claim(parentOwner, target.targetId);
      });
    }
  });
  browser.onDetached((target) => {
    if (disposed || targets.get(target.targetId)?.sessionId !== target.sessionId) return;
    const owner = owners.get(target.targetId);
    const retired = retiredTargets.has(target.targetId);
    targets.delete(target.targetId);
    sessions.delete(target.sessionId);
    infos.delete(target.targetId);
    owners.delete(target.targetId);
    createdRoots.delete(target.targetId);
    retiredTargets.delete(target.targetId);
    if (owner !== undefined && !retired) {
      const state = liveScope(owner);
      if (state) {
        state.pendingCreates.get(target.targetId)?.reject(new Error("Created page detached"));
        for (const callback of state.detached) callback(target);
      }
    }
  });
  browser.onTargetInfoChanged((info) => {
    if (disposed) return;
    infos.set(info.targetId, info);
    if (retiredTargets.has(info.targetId)) return;
    const owner = owners.get(info.targetId);
    if (owner !== undefined) {
      const state = liveScope(owner);
      if (state && targets.has(info.targetId))
        for (const callback of state.metadata) callback(info);
      return;
    }
    // Some Chromium notifications report opener metadata after attachment.
    const target = targets.get(info.targetId);
    if (target && (info.openerTabId !== undefined || info.parentTargetId !== undefined)) {
      if (info.openerTabId !== undefined) target.openerTabId = info.openerTabId;
      if (info.parentTargetId !== undefined) target.parentTargetId = info.parentTargetId;
      const parentOwner = inheritedOwner(target);
      if (parentOwner !== undefined) claim(parentOwner, target.targetId);
    }
  });

  const poolSend = (method: string, params?: Record<string, unknown>) => {
    if (!browser.sendBrowser) return Promise.reject(new Error("Browser/root CDP is unavailable"));
    return browser.sendBrowser(method, params);
  };

  let login: string | undefined;
  let loginRead = false;
  const loginTimer =
    options.onSignedIn || options.onLoginState
      ? setInterval(() => {
          void poolSend("Storage.getCookies")
            .then((saved) => {
              const current = loginValue(
                (saved as { cookies?: Record<string, unknown>[] }).cookies,
              );
              const changed = current !== login;
              const signedIn = loginRead && current !== undefined && changed;
              login = current;
              loginRead = true;
              if (disposed) return;
              if (signedIn) options.onSignedIn?.();
              options.onLoginState?.(current !== undefined, changed);
            })
            .catch(() => undefined);
        }, LOGIN_CHECK_MS)
      : undefined;
  loginTimer?.unref?.();

  function scope(sid: string): ClientBrowserScope {
    if (disposed) throw new Error("Client browser pool is disposed");
    if (sid.trim().length === 0) throw new TypeError("Client session id must not be empty");
    const previous = liveScope(sid);
    if (previous) return previous.facade;
    const ensureActive = (allowClosing = false) => {
      if (disposed || state.disposed || (!allowClosing && state.closing))
        throw new Error("Client browser scope is closed");
    };
    const ownsTarget = (targetId: string) =>
      owners.get(targetId) === sid && !retiredTargets.has(targetId);
    const ownTargets = () => [...targets.values()].filter((target) => ownsTarget(target.targetId));
    const ownWindows = new Set<unknown>();
    const track = (off: () => void) => {
      let subscribed = true;
      const unsubscribe = () => {
        if (!subscribed) return;
        subscribed = false;
        state.unsubscribe.delete(unsubscribe);
        off();
      };
      state.unsubscribe.add(unsubscribe);
      return unsubscribe;
    };
    const rootSend = (method: string, params?: Record<string, unknown>) => {
      if (!browser.sendBrowser) return Promise.reject(new Error("Browser/root CDP is unavailable"));
      return browser.sendBrowser(method, params);
    };
    const awaitCreatedPage = (targetId: string): Promise<void> => {
      if (targets.get(targetId)?.type === "page") return Promise.resolve();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.pendingCreates.delete(targetId);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error("Created page did not attach")),
          CREATE_ATTACH_TIMEOUT_MS,
        );
        timer.unref?.();
        state.pendingCreates.set(targetId, {
          resolve: () => finish(),
          reject: (error) => finish(error),
        });
      });
    };
    const cleanupCreatedPage = async (targetId: string): Promise<void> => {
      retiredTargets.add(targetId);
      try {
        const result = (await rootSend("Target.closeTarget", { targetId })) as
          { success?: boolean } | undefined;
        // If attachment never happened, there is no flat detach callback to clear the claim.
        if (result?.success !== false && !targets.has(targetId)) {
          owners.delete(targetId);
          createdRoots.delete(targetId);
        }
      } catch {
        // Keep ownership on cleanup failure so no other client can adopt a surviving page.
      }
    };
    const createPage = async (url: string): Promise<unknown> => {
      // Force an independent window rather than another background tab in a client's window.
      const offset = (openedWindows++ % WINDOW_OFFSETS) * WINDOW_OFFSET_STEP;
      const result = (await rootSend("Target.createTarget", {
        url,
        newWindow: true,
        // Chromium would offset it from the last active window, which may be in a picture's slot.
        // Each keeps an edge showing, as Chromium stops drawing a window that is fully covered.
        left: offset,
        top: offset,
        width: options.windowSize?.width ?? 1050,
        height: options.windowSize?.height ?? 980,
      })) as {
        targetId?: string;
      };
      if (typeof result.targetId !== "string")
        throw new Error("Target.createTarget returned no id");
      if (disposed || state.disposed || state.closing) {
        if (!owners.has(result.targetId)) owners.set(result.targetId, sid);
        createdRoots.add(result.targetId);
        await cleanupCreatedPage(result.targetId);
        throw new Error("Client scope closed while creating a page");
      }
      createdRoots.add(result.targetId);
      try {
        claim(sid, result.targetId);
        // TabLifecycle activates immediately after createTarget resolves. Guarantee that
        // its target/session and all scoped observers are ready even when ACK comes first.
        await awaitCreatedPage(result.targetId);
        ensureActive();
        return result;
      } catch (error) {
        await cleanupCreatedPage(result.targetId);
        throw error;
      }
    };
    const closeOwned = (): Promise<void> => {
      if (state.closePromise) return state.closePromise;
      ensureActive();
      state.closing = true;
      state.closePromise = (async () => {
        try {
          for (const pending of [...state.pendingCreates.values()])
            pending.reject(new Error("Client scope closed while creating a page"));
          // Do not release/reassign this SID while an already dispatched createTarget can
          // still acknowledge and produce another window. Closing forces those results to reap.
          await Promise.allSettled([...state.creates]);
          const pages = new Set(
            ownTargets()
              .filter((target) => target.type === "page")
              .map((target) => target.targetId),
          );
          for (const targetId of createdRoots)
            if (owners.get(targetId) === sid) pages.add(targetId);
          const results = await Promise.allSettled(
            [...pages].map(async (targetId) => {
              const result = (await rootSend("Target.closeTarget", { targetId })) as
                { success?: boolean } | undefined;
              if (result?.success === false) throw new Error("Created page did not close");
              if (!targets.has(targetId)) {
                owners.delete(targetId);
                createdRoots.delete(targetId);
              }
            }),
          );
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        } finally {
          facade.dispose();
        }
      })();
      return state.closePromise;
    };
    const facade: ClientBrowserScope = {
      sid,
      ownsTarget,
      targets: ownTargets,
      async send(sessionId, method, params) {
        ensureActive();
        const targetId = sessions.get(sessionId);
        if (targetId === undefined || !ownsTarget(targetId))
          throw new Error("CDP session does not belong to this client");
        // A target CDP session can also carry global Browser/Target commands. Do not expose them.
        if (method.startsWith("Browser.") || method.startsWith("Target."))
          throw new Error("Browser-level commands require the scoped root interface");
        return browser.send(sessionId, method, params);
      },
      async sendBrowser(method, params = {}) {
        ensureActive();
        if (method === "Target.createTarget") {
          if (params.browserContextId !== undefined)
            throw new Error("Client windows must use the shared browser profile");
          if (typeof params.url !== "string") throw new TypeError("A new page requires a URL");
          const creating = createPage(params.url);
          state.creates.add(creating);
          void creating.then(
            () => state.creates.delete(creating),
            () => state.creates.delete(creating),
          );
          return creating;
        }
        if (method === "Target.activateTarget" || method === "Target.closeTarget") {
          const id = params.targetId;
          if (typeof id !== "string" || !ownsTarget(id) || targets.get(id)?.type !== "page")
            throw new Error("Page does not belong to this client");
          return rootSend(method, { targetId: id });
        }
        if (method === "Browser.getWindowForTarget") {
          const id = params.targetId;
          if (typeof id !== "string" || !ownsTarget(id))
            throw new Error("Page does not belong to this client");
          const found = (await rootSend(method, { targetId: id })) as { windowId: number };
          ownWindows.add(found.windowId);
          return found;
        }
        if (
          method === "Browser.getWindowBounds" ||
          method === "Browser.setWindowBounds" ||
          method === "Browser.setContentsSize"
        ) {
          if (!ownWindows.has(params.windowId as number))
            throw new Error("Window does not belong to this client");
          return rootSend(method, params);
        }
        throw new Error(`Browser command is not available in a client scope: ${method}`);
      },
      onAttached(callback) {
        ensureActive();
        state.attached.add(callback);
        for (const target of ownTargets()) callback(target);
      },
      onDetached(callback) {
        ensureActive();
        state.detached.add(callback);
      },
      onTargetInfoChanged(callback) {
        ensureActive();
        state.metadata.add(callback);
        for (const info of infos.values()) if (ownsTarget(info.targetId)) callback(info);
      },
      onSessionEvent<K extends keyof FlatSessionEventMap>(
        method: K,
        callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
      ) {
        ensureActive();
        return track(
          browser.onSessionEvent(method, (sessionId, event) => {
            const targetId = sessions.get(sessionId);
            if (!state.disposed && targetId !== undefined && ownsTarget(targetId))
              callback(sessionId, event);
          }),
        );
      },
      onBrowserEvent<K extends keyof BrowserSessionEventMap>(
        method: K,
        callback: (event: BrowserSessionEventMap[K]) => void,
      ) {
        ensureActive();
        if (method !== "Target.targetCrashed")
          throw new Error("Download events must be routed by the shared browser download manager");
        return track(
          browser.onBrowserEvent?.(method, (event) => {
            const targetId = (event as BrowserSessionEventMap["Target.targetCrashed"]).targetId;
            if (!state.disposed && ownsTarget(targetId)) callback(event);
          }) ?? (() => {}),
        );
      },
      isAlive: () =>
        !disposed && !state.disposed && !state.closing && browser.isAlive?.() !== false,
      close: closeOwned,
      kill: closeOwned,
      dispose() {
        if (state.disposed) return;
        state.disposed = true;
        for (const pending of [...state.pendingCreates.values()])
          pending.reject(new Error("Client scope closed while creating a page"));
        for (const off of [...state.unsubscribe]) off();
        state.attached.clear();
        state.detached.clear();
        state.metadata.clear();
      },
    };
    const state: ScopeState = {
      sid,
      facade,
      disposed: false,
      closing: false,
      attached: new Set(),
      detached: new Set(),
      metadata: new Set(),
      unsubscribe: new Set(),
      pendingCreates: new Map(),
      creates: new Set(),
    };
    scopes.set(sid, state);
    return facade;
  }

  return {
    scope,
    adopt(sid, targetId) {
      const state = liveScope(sid);
      if (disposed || !state || state.closing)
        throw new Error("Create an active client scope before adoption");
      if (targets.get(targetId)?.type !== "page" || retiredTargets.has(targetId))
        throw new Error("Only an attached root page can be adopted");
      claim(sid, targetId);
    },
    ownerOf: (targetId) => (retiredTargets.has(targetId) ? undefined : owners.get(targetId)),
    unownedPages: () =>
      [...targets.values()].filter(
        (target) =>
          target.type === "page" &&
          !owners.has(target.targetId) &&
          !retiredTargets.has(target.targetId),
      ),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (loginTimer) clearInterval(loginTimer);
      for (const state of scopes.values()) state.facade.dispose();
      scopes.clear();
      owners.clear();
      targets.clear();
      sessions.clear();
      infos.clear();
      createdRoots.clear();
      retiredTargets.clear();
    },
  };
}

function isSiteCookie(cookie: Record<string, unknown>): boolean {
  return typeof cookie.domain === "string" && /(^|\.)claude\.ai$/i.test(cookie.domain);
}

/** The site's login token; a forced logout clears it. Undefined means signed out. */
function loginValue(cookies: Record<string, unknown>[] = []): string | undefined {
  const cookie = cookies.find((item) => item.name === "sessionKey" && isSiteCookie(item));
  return typeof cookie?.value === "string" && cookie.value !== "" ? cookie.value : undefined;
}

export function isClaudeUrl(url: string | undefined): boolean {
  try {
    return /(^|\.)claude\.ai$/i.test(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}

/** Where a page on Claude's sign-in screens should go once signed in; null for any other page. */
export function afterSignInUrl(url: string | undefined): string | null {
  if (!isClaudeUrl(url)) return null;
  const page = new URL(url!);
  if (!/^\/(login|logout|oauth|auth|magic-link)(\/|$)/i.test(page.pathname)) return null;
  const back = page.searchParams.get("returnTo") ?? "";
  const safe =
    back.startsWith("/") && !back.startsWith("//") && !/^\/(login|logout)(\/|\?|$)/i.test(back);
  return `${page.origin}${safe ? back : "/new"}`;
}
