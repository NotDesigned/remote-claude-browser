/**
 * Local Chromium launcher for development mode.
 *
 * Invariants:
 * - puppeteer-core as launcher/CDP transport ONLY (never its Page API for input/eval);
 *   `--remote-debugging-pipe`, `--no-first-run`, dedicated --user-data-dir, headful under Xvfb.
 * - Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:true,
 *   filter:[{type:"page"},{type:"iframe"}]}).
 * - Workers/service-workers: resume immediately, never inject.
 * - Expose the raw flat session BEFORE resume — injection (P0-INJECT) must run its sequence
 *   first, or every new target hangs paused.
 *
 * The same BrowserHandle adapter also supports broker transports and remote CDP endpoints.
 */
import {
  connect,
  launch,
  type Browser,
  type CDPSession,
  type ConnectionTransport,
  type Protocol,
} from "puppeteer-core";
import type { CdpSend, TargetEvents, TargetRef } from "../types";
import { TargetRegistry } from "./targets";
import type { BrowserEngine } from "./identity";

export interface LaunchOpts {
  userDataDir: string;
  engine?: BrowserEngine;
  executablePath?: string;
  headful?: boolean;
  /** Additional Chromium flags for development fixtures and diagnostics. */
  args?: readonly string[];
  /** Leaves Chromium able to load an extension, which it otherwise refuses by default. */
  enableExtensions?: boolean;
  /** Extra environment for this browser only: its X display, its fontconfig. */
  env?: Record<string, string>;
}

interface ChromiumLaunchArgOptions {
  headful?: boolean;
  userDataDir?: string;
  enableExtensions?: boolean;
}

export interface BrowserTargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerTabId?: string;
  parentTargetId?: string;
}

/** Typed CDP notifications emitted by an attached flat session. Extend this browser-owned
 * surface as browser features need more events; the stable gateway contracts stay unchanged. */
export interface FlatSessionEventMap {
  "Runtime.bindingCalled": Protocol.Runtime.BindingCalledEvent;
  "Page.frameNavigated": Protocol.Page.FrameNavigatedEvent;
  "Page.frameStartedNavigating": Protocol.Page.FrameStartedNavigatingEvent;
  "Page.navigatedWithinDocument": Protocol.Page.NavigatedWithinDocumentEvent;
  "Page.lifecycleEvent": Protocol.Page.LifecycleEventEvent;
  "Page.screencastFrame": Protocol.Page.ScreencastFrameEvent;
  "Page.fileChooserOpened": Protocol.Page.FileChooserOpenedEvent;
}

/** Browser-domain notifications are deliberately separate from flat target-session events.
 * In particular, OOPIF-initiated downloads are reported only by the browser/root session. */
export interface BrowserSessionEventMap {
  "Browser.downloadWillBegin": Protocol.Browser.DownloadWillBeginEvent;
  "Browser.downloadProgress": Protocol.Browser.DownloadProgressEvent;
  "Target.targetCrashed": Protocol.Target.TargetCrashedEvent;
}

export interface BrowserHandle extends TargetEvents {
  send: CdpSend;
  /** Send a command on the browser/root CDP session (Target.* lifecycle commands). */
  sendBrowser?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Subscribe to a protocol event together with the flat session that emitted it. */
  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    cb: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void;
  /** Subscribe on the browser/root CDP session, never on a page or OOPIF session. */
  onBrowserEvent?<K extends keyof BrowserSessionEventMap>(
    method: K,
    cb: (event: BrowserSessionEventMap[K]) => void,
  ): () => void;
  /** Metadata changes used by navigation chrome and tab lifecycle. */
  onTargetInfoChanged(cb: (info: BrowserTargetInfo) => void): void;
  /** Browser liveness and process lifecycle. */
  isAlive?(): boolean;
  kill?(): Promise<void>;
  close(): Promise<void>;
}

type TargetCallback = (target: TargetRef) => void;
type TargetInfoCallback = (info: BrowserTargetInfo) => void;
type BindingCalledCallback = (
  sessionId: string,
  event: Protocol.Runtime.BindingCalledEvent,
) => void;
type FrameNavigatedCallback = (sessionId: string, event: Protocol.Page.FrameNavigatedEvent) => void;
type NavigatedWithinDocumentCallback = (
  sessionId: string,
  event: Protocol.Page.NavigatedWithinDocumentEvent,
) => void;
type LifecycleEventCallback = (sessionId: string, event: Protocol.Page.LifecycleEventEvent) => void;
type ScreencastFrameCallback = (
  sessionId: string,
  event: Protocol.Page.ScreencastFrameEvent,
) => void;
type FileChooserOpenedCallback = (
  sessionId: string,
  event: Protocol.Page.FileChooserOpenedEvent,
) => void;

/** Adapt Puppeteer's strongly keyed CDP session to the frozen gateway command boundary. */
async function sendOnSession(
  rootSession: CDPSession,
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const session = rootSession.connection()?.session(sessionId);
  if (!session) {
    throw new Error(`CDP session ${sessionId} is not attached`);
  }

  // CdpSend deliberately accepts protocol methods used by higher-level browser features.
  const dynamicSession = session as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  return dynamicSession.send(method, params);
}

function toTargetInfo(targetInfo: Protocol.Target.TargetInfo): BrowserTargetInfo {
  return {
    targetId: targetInfo.targetId,
    type: targetInfo.type,
    url: targetInfo.url,
    title: targetInfo.title,
    ...(targetInfo.openerId === undefined ? {} : { openerTabId: targetInfo.openerId }),
    ...(targetInfo.parentId === undefined ? {} : { parentTargetId: targetInfo.parentId }),
  };
}

function toTargetRef(
  sessionId: string,
  targetInfo: Protocol.Target.TargetInfo,
): TargetRef | undefined {
  if (targetInfo.type !== "page" && targetInfo.type !== "iframe") {
    return undefined;
  }

  return {
    targetId: targetInfo.targetId,
    sessionId,
    type: targetInfo.type,
    ...(targetInfo.openerId === undefined ? {} : { openerTabId: targetInfo.openerId }),
  };
}

async function resumeIgnoredTarget(parentSession: CDPSession, sessionId: string): Promise<void> {
  const session = parentSession.connection()?.session(sessionId);
  if (!session) return;

  try {
    await session.send("Runtime.runIfWaitingForDebugger");
  } finally {
    await parentSession.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

async function browserHandle(browser: Browser): Promise<BrowserHandle> {
  try {
    const rootSession = await browser.target().createCDPSession();
    const registry = new TargetRegistry();
    const sessionTargets = new Map<string, string>();
    const targetInfos = new Map<string, BrowserTargetInfo>();
    const attachedCallbacks = new Set<TargetCallback>();
    const detachedCallbacks = new Set<TargetCallback>();
    const infoCallbacks = new Set<TargetInfoCallback>();
    const bindingCalledCallbacks = new Set<BindingCalledCallback>();
    const frameNavigatedCallbacks = new Set<FrameNavigatedCallback>();
    const frameStartedNavigatingCallbacks = new Set<
      (sessionId: string, event: Protocol.Page.FrameStartedNavigatingEvent) => void
    >();
    const navigatedWithinDocumentCallbacks = new Set<NavigatedWithinDocumentCallback>();
    const lifecycleEventCallbacks = new Set<LifecycleEventCallback>();
    const screencastFrameCallbacks = new Set<ScreencastFrameCallback>();
    const fileChooserOpenedCallbacks = new Set<FileChooserOpenedCallback>();
    const browserEventCallbacks = new Map<
      keyof BrowserSessionEventMap,
      Set<(event: BrowserSessionEventMap[keyof BrowserSessionEventMap]) => void>
    >();
    const watchedSessions = new WeakSet<CDPSession>();
    const autoAttachParams = {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
      filter: [{ type: "page" }, { type: "iframe" }],
    } satisfies Protocol.Target.SetAutoAttachRequest;

    const handleAttached = (
      parentSession: CDPSession,
      event: Protocol.Target.AttachedToTargetEvent,
    ): void => {
      const childSession = parentSession.connection()?.session(event.sessionId);
      if (childSession) {
        watchSession(childSession);
        // Auto-attach is scoped to a target's related-target tree. Queue this before invoking
        // the injector callback so OOPIFs created during initial execution cannot race us.
        void childSession.send("Target.setAutoAttach", autoAttachParams).catch(() => undefined);
      }

      const target = toTargetRef(event.sessionId, event.targetInfo);
      if (!target) {
        void resumeIgnoredTarget(parentSession, event.sessionId).catch(() => undefined);
        return;
      }

      const parentTargetId = event.targetInfo.parentId ?? sessionTargets.get(parentSession.id());
      if (target.type === "iframe" && parentTargetId !== undefined)
        target.parentTargetId = parentTargetId;

      const previous = registry.targets.get(target.targetId);
      if (previous?.sessionId === target.sessionId) return;

      registry.add(target);
      sessionTargets.set(target.sessionId, target.targetId);
      targetInfos.set(target.targetId, toTargetInfo(event.targetInfo));
      for (const callback of attachedCallbacks) callback(target);
    };

    const handleDetached = (event: Protocol.Target.DetachedFromTargetEvent): void => {
      const targetId = sessionTargets.get(event.sessionId) ?? event.targetId;
      if (targetId === undefined) return;

      const target = registry.targets.get(targetId);
      sessionTargets.delete(event.sessionId);
      if (target?.sessionId !== event.sessionId) return;

      targetInfos.delete(targetId);
      registry.remove(targetId);
      if (target) {
        for (const callback of detachedCallbacks) callback(target);
      }
    };

    const handleTargetInfoChanged = (event: Protocol.Target.TargetInfoChangedEvent): void => {
      const info = toTargetInfo(event.targetInfo);
      targetInfos.set(info.targetId, info);
      for (const callback of infoCallbacks) callback(info);
    };

    function watchSession(session: CDPSession): void {
      if (watchedSessions.has(session)) return;
      watchedSessions.add(session);
      session.on("Target.attachedToTarget", (event) => handleAttached(session, event));
      session.on("Target.detachedFromTarget", handleDetached);
      session.on("Target.targetInfoChanged", handleTargetInfoChanged);
      session.on("Runtime.bindingCalled", (event) => {
        for (const callback of bindingCalledCallbacks) callback(session.id(), event);
      });
      session.on("Page.frameNavigated", (event) => {
        for (const callback of frameNavigatedCallbacks) callback(session.id(), event);
      });
      session.on("Page.frameStartedNavigating", (event) => {
        for (const callback of frameStartedNavigatingCallbacks) callback(session.id(), event);
      });
      session.on("Page.navigatedWithinDocument", (event) => {
        for (const callback of navigatedWithinDocumentCallbacks) callback(session.id(), event);
      });
      session.on("Page.lifecycleEvent", (event) => {
        for (const callback of lifecycleEventCallbacks) callback(session.id(), event);
      });
      session.on("Page.screencastFrame", (event) => {
        for (const callback of screencastFrameCallbacks) callback(session.id(), event);
      });
      session.on("Page.fileChooserOpened", (event) => {
        for (const callback of fileChooserOpenedCallbacks) callback(session.id(), event);
      });
    }

    watchSession(rootSession);

    const dynamicRootEvents = rootSession as unknown as {
      on(method: string, callback: (event: unknown) => void): void;
    };
    for (const method of [
      "Browser.downloadWillBegin",
      "Browser.downloadProgress",
      "Target.targetCrashed",
    ] as const satisfies readonly (keyof BrowserSessionEventMap)[]) {
      dynamicRootEvents.on(method, (event) => {
        const callbacks = browserEventCallbacks.get(method);
        if (callbacks === undefined) return;
        for (const callback of callbacks) {
          callback(event as BrowserSessionEventMap[typeof method]);
        }
      });
    }

    await rootSession.send("Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "page" }, { type: "iframe" }],
    });
    await rootSession.send("Target.setAutoAttach", autoAttachParams);

    const launchedBrowser = browser;
    let closePromise: Promise<void> | undefined;
    return {
      send: (sessionId, method, params) => sendOnSession(rootSession, sessionId, method, params),
      sendBrowser: (method, params) => {
        const dynamicRoot = rootSession as unknown as {
          send(method: string, params?: Record<string, unknown>): Promise<unknown>;
        };
        return dynamicRoot.send(method, params);
      },
      onSessionEvent(method, callback) {
        switch (method) {
          case "Runtime.bindingCalled": {
            const bindingCallback = callback as BindingCalledCallback;
            bindingCalledCallbacks.add(bindingCallback);
            return () => bindingCalledCallbacks.delete(bindingCallback);
          }
          case "Page.frameNavigated": {
            const frameCallback = callback as FrameNavigatedCallback;
            frameNavigatedCallbacks.add(frameCallback);
            return () => frameNavigatedCallbacks.delete(frameCallback);
          }
          case "Page.frameStartedNavigating": {
            const startedCallback = callback as (
              sessionId: string,
              event: Protocol.Page.FrameStartedNavigatingEvent,
            ) => void;
            frameStartedNavigatingCallbacks.add(startedCallback);
            return () => frameStartedNavigatingCallbacks.delete(startedCallback);
          }
          case "Page.navigatedWithinDocument": {
            const withinDocumentCallback = callback as NavigatedWithinDocumentCallback;
            navigatedWithinDocumentCallbacks.add(withinDocumentCallback);
            return () => navigatedWithinDocumentCallbacks.delete(withinDocumentCallback);
          }
          case "Page.lifecycleEvent": {
            const lifecycleCallback = callback as LifecycleEventCallback;
            lifecycleEventCallbacks.add(lifecycleCallback);
            return () => lifecycleEventCallbacks.delete(lifecycleCallback);
          }
          case "Page.screencastFrame": {
            const screencastCallback = callback as ScreencastFrameCallback;
            screencastFrameCallbacks.add(screencastCallback);
            return () => screencastFrameCallbacks.delete(screencastCallback);
          }
          case "Page.fileChooserOpened": {
            const chooserCallback = callback as FileChooserOpenedCallback;
            fileChooserOpenedCallbacks.add(chooserCallback);
            return () => fileChooserOpenedCallbacks.delete(chooserCallback);
          }
        }
      },
      onBrowserEvent(method, callback) {
        let callbacks = browserEventCallbacks.get(method);
        if (callbacks === undefined) {
          callbacks = new Set();
          browserEventCallbacks.set(method, callbacks);
        }
        const rootCallback = callback as (
          event: BrowserSessionEventMap[keyof BrowserSessionEventMap],
        ) => void;
        callbacks.add(rootCallback);
        return () => callbacks?.delete(rootCallback);
      },
      onAttached(callback) {
        attachedCallbacks.add(callback);
        // setAutoAttach can synchronously report the initial page before launchBrowser returns.
        // Replay current refs so an injector always gets a chance to resume every target.
        for (const target of registry.targets.values()) callback(target);
      },
      onDetached(callback) {
        detachedCallbacks.add(callback);
      },
      onTargetInfoChanged(callback) {
        infoCallbacks.add(callback);
        for (const info of targetInfos.values()) callback(info);
      },
      isAlive() {
        if (!launchedBrowser.connected) return false;
        const child = launchedBrowser.process();
        return child === null || (child.exitCode === null && child.signalCode === null);
      },
      async kill() {
        launchedBrowser.process()?.kill("SIGKILL");
        await launchedBrowser.disconnect();
      },
      close() {
        closePromise ??= launchedBrowser.close();
        return closePromise;
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** Launch a local browser for development and acceptance fixtures over a private debugging pipe. */
export async function launchBrowser(opts: LaunchOpts): Promise<BrowserHandle> {
  if (opts.userDataDir.trim() === "") {
    throw new Error("launchBrowser requires a dedicated userDataDir");
  }

  const headful = opts.headful ?? true;
  const args = chromiumLaunchArgs(opts.args, {
    headful,
    userDataDir: opts.userDataDir,
    ...(opts.enableExtensions ? { enableExtensions: true } : {}),
  });
  // Local development can run as root; the production broker launches an unprivileged browser.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox");
  }

  const browser = await launch({
    ...(opts.executablePath === undefined ? {} : { executablePath: opts.executablePath }),
    args,
    headless: !headful,
    ignoreDefaultArgs: true,
    pipe: true,
    userDataDir: opts.userDataDir,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  // Retain only Chromium crash diagnostics, never renderer console output or page content.
  let diagnosticTail = "";
  browser.process()?.stderr?.on("data", (chunk: Buffer) => {
    if (process.env.MIRROR_DIAGNOSTIC_STDERR === "1") process.stderr.write(chunk);
    diagnosticTail += chunk.toString();
    const lines = diagnosticTail.split("\n");
    diagnosticTail = (lines.pop() ?? "").slice(-4096);
    for (const line of lines) {
      if (/bad_message|bad[^\n]{0,40}(?:IPC|Mojo|message)|FATAL:/i.test(line))
        console.error("Chromium crash diagnostic:", line.slice(0, 1000));
    }
  });
  return browserHandle(browser);
}

/**
 * The complete Chromium argv. Deliberately not Puppeteer's defaults: those disable features a real
 * Chrome has (MediaRouter alone gets a browser classed as automation) and tune it for test runs.
 */
export function chromiumLaunchArgs(
  additional: readonly string[] = [],
  options: ChromiumLaunchArgOptions = {},
): string[] {
  const disabled = new Set(["BackForwardCache"]);
  const args = [
    "--no-first-run",
    "--password-store=basic",
    // Software WebGL; without it Chromium blocklists WebGL on this GPU-less host.
    "--enable-unsafe-swiftshader",
    // Windows sit unseen on the X display; the mirror still needs their pages to run.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-breakpad",
    // Over a debugging pipe Chromium otherwise reports navigator.webdriver as true.
    "--disable-blink-features=AutomationControlled",
  ];
  for (const arg of additional) {
    if (!arg.startsWith("--disable-features=")) args.push(arg);
    else for (const name of arg.slice("--disable-features=".length).split(",")) disabled.add(name);
  }
  disabled.delete("");
  args.push(`--disable-features=${[...disabled].join(",")}`);
  if (!(options.headful ?? true)) args.push("--headless=new");
  if (!options.enableExtensions) args.push("--disable-extensions");
  if (options.userDataDir !== undefined) args.push(`--user-data-dir=${options.userDataDir}`);
  return args;
}

/** Connect the same raw-CDP BrowserHandle to a remote endpoint. */
export async function connectBrowser(browserWSEndpoint: string): Promise<BrowserHandle> {
  const browser = await connect({ browserWSEndpoint, defaultViewport: null });
  return browserHandle(browser);
}

/** A private pipe relayed by the root network broker; no TCP debugging endpoint exists. */
export async function connectBrowserTransport(
  transport: ConnectionTransport,
): Promise<BrowserHandle> {
  return browserHandle(await connect({ transport, defaultViewport: null }));
}
