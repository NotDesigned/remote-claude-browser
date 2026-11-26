/**
 * One workspace's browser: its scope of windows on the account's Chrome, and everything that keeps
 * its viewers' copies of those windows in step (page sync, geometry, input, picture, navigation,
 * renderer recovery, uploads, media). Started by the session registry; it reaches viewers only
 * through the publish and viewer callbacks it is given.
 */
import type { Down } from "@mirror/protocol";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Account } from "../browser/account-pool";
import { agentBridgeChannel, callAgentBridge, callFrameAgent } from "../browser/bridge";
import { createBrowserZoom } from "../browser/browser-zoom";
import type { ClientBrowserScope } from "../browser/client-scope";
import type { BrowserTargetInfo } from "../browser/launch";
import { createNavigationController } from "../browser/nav";
import { createGrabSlots, createPixelWindow } from "../browser/pixel-window";
import { createRendererRecovery } from "../browser/recovery";
import { createClaudeTheme } from "../claude/theme";
import { createViewportAgreement } from "../hub/viewport";
import { createInputRelay } from "../input/relay";
import { createScreencast } from "../px";
import type { createPixelCapacity } from "../px-capacity";
import { grabEncoderForDisplay, jpegGrabForDisplay } from "../px-video";
import { createRtcSignalRelay } from "../rtcsig";
import type { AgentLink, TargetRef } from "../types";
import { createUploadManager } from "../uploads";
import { ClientSessionError, type ClientRecord } from "./clients";
import type { ClientSessions, RuntimeStart } from "./runtime-registry";
import { createTabLifecycle } from "./tabs";

export interface ClientRuntime {
  sid: string;
  /** Changes whenever a workspace is recreated, including slot reuse and profile switches. */
  assetKey: Buffer;
  account: Account;
  theme: ReturnType<typeof createClaudeTheme>;
  browser: ClientBrowserScope;
  targets: Map<string, TargetRef>;
  metadata: Map<string, BrowserTargetInfo>;
  tabs: ReturnType<typeof createTabLifecycle>;
  viewport: ReturnType<typeof createViewportAgreement>;
  input: ReturnType<typeof createInputRelay>;
  pixels: ReturnType<typeof createScreencast>;
  navigation: ReturnType<typeof createNavigationController>;
  recovery: ReturnType<typeof createRendererRecovery>;
  uploads: Awaited<ReturnType<typeof createUploadManager>>;
  rtc?: ReturnType<typeof createRtcSignalRelay>;
  stop(): Promise<void>;
}

export interface ClientRuntimeDeps {
  e2e: boolean;
  sessions: Pick<ClientSessions, "get" | "profileOf" | "setSleeping">;
  memoryShort(): Promise<boolean>;
  openAccount(profileId: string): Promise<Account>;
  publish(sid: string, message: Down): void;
  /** Whether this viewer is the session's driver. */
  isDriver(viewerId: string, sid: string): boolean;
  /** Whether a viewer of the session has too much video waiting to take another frame. */
  backlogged(sid: string): boolean;
  /** Sends to one viewer of the session; false when it is not (or no longer) one. */
  sendViewer(viewerId: string, sid: string, message: Down): boolean;
  pixelCapacity: ReturnType<typeof createPixelCapacity>;
  grabSlots: ReturnType<typeof createGrabSlots>;
  /** Whether the picture may come from the account's own X display. */
  displayGrabbable: boolean;
  /** A top-level page of the workspace committed a navigation. */
  onNavigated(account: Account, sid: string, message: { tab: string; url: string }): void;
  /** A tab of the workspace went away (closed, or its target detached). */
  onTabClosed?(sid: string, tab: string): void;
  report(message: string, error: unknown): void;
}

export async function createClientRuntime(
  deps: ClientRuntimeDeps,
  record: ClientRecord,
  { sleeping, attach, detach }: RuntimeStart<ClientRuntime>,
): Promise<ClientRuntime> {
  const { sid } = record;
  const { report } = deps;
  const publish = (message: Down) => deps.publish(sid, message);
  if (!deps.e2e && (await deps.memoryShort()))
    throw new ClientSessionError(
      503,
      "CLIENT_RESOURCES",
      "内存较紧张，请等待离线会话自动回收后重试",
    );
  const account = await deps.openAccount(deps.sessions.profileOf(sid));
  const assetKey = randomBytes(32);
  const { pool, agent, themeCopies, browser, frameOwners } = account;
  const scoped = pool.scope(sid),
    targets = new Map<string, TargetRef>(),
    metadata = new Map<string, BrowserTargetInfo>();
  scoped.onAttached((target) => {
    targets.set(target.targetId, target);
    if (target.type === "page")
      void scoped
        .send(target.sessionId, "Emulation.setFocusEmulationEnabled", { enabled: true })
        .catch((error) => report("client focus emulation failed", error));
  });
  scoped.onDetached((target) => {
    if (targets.get(target.targetId)?.sessionId === target.sessionId) {
      targets.delete(target.targetId);
      metadata.delete(target.targetId);
    }
  });
  scoped.onTargetInfoChanged((info) => metadata.set(info.targetId, info));
  const ownAgent: AgentLink = {
    msgs: async function* (target) {
      if (!scoped.ownsTarget(target)) throw new Error("Foreign recorder target");
      for await (const message of agent.msgs(target)) {
        yield message;
      }
    },
    sendCmd: (target, command, frameId) => {
      if (!scoped.ownsTarget(target)) return Promise.reject(new Error("Foreign recorder target"));
      return agent.sendCmd(target, command, frameId);
    },
  };
  let recovery: ReturnType<typeof createRendererRecovery> | undefined;
  const tabs = createTabLifecycle({
    browser: scoped,
    agentLink: ownAgent,
    sessionId: sid,
    assetTokenKey: assetKey,
    publish,
    onSnapshot: (snapshot) => recovery?.noteSnapshot(snapshot.tab),
    onError: (error) => report("client tab failed", error),
  });
  const isDriver = (id: string) => deps.isDriver(id, sid);
  const phone = deps.sessions.get(sid)?.phone === true;
  const viewport = createViewportAgreement({
    send: scoped.send,
    sessionFor: (tab) => targets.get(tab)?.sessionId,
    hubFor: (tab) => tabs.hubFor(tab),
    isDriver,
    mobile: phone,
    screen: account.identity.screen,
    confirmViewport: (_viewer, tab, { w, h }) => publish({ t: "view-ok", tab, w, h }),
  });
  const pixelWindow =
    deps.displayGrabbable && scoped.sendBrowser
      ? createPixelWindow({ sendBrowser: scoped.sendBrowser, display: account.display?.env })
      : undefined;
  const input = createInputRelay({
    onValueStatus: (tab, failed, reason) =>
      publish({ t: "input-status", tab, failed, ...(reason ? { reason } : {}) }),
    agentLink: ownAgent,
    send: scoped.send,
    callBridge: (session, method, args) => callAgentBridge(browser, session, method, args),
    callFrame: (session, frame, method, args) =>
      callFrameAgent(browser, session, frame, method, args),
    sessionFor: (tab) => targets.get(tab)?.sessionId,
    isDriver,
    allowsInput: (id, tab) => viewport.gate.allowsInput(id, tab),
    noteInput: (tab) => tabs.hubFor(tab)?.noteInput(),
    wheelScale: (tab) => tabs.hubFor(tab)?.pixelZoom ?? 1,
    nativePointer: async (message, { x, y }) => {
      const zoom = tabs.hubFor(message.tab)?.pixelZoom ?? 1;
      return (await pixelWindow?.pointer({ ...message, vx: x * zoom, vy: y * zoom })) ?? false;
    },
    viewportFor: (tab) => viewport.viewportFor(tab),
  });
  // What the input relay keeps per tab goes with the tab.
  scoped.onDetached((target) => {
    if (target.type !== "page" || targets.has(target.targetId)) return;
    input.forgetTab(target.targetId);
    deps.onTabClosed?.(sid, target.targetId);
  });
  scoped.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
    if (event.frame.parentId !== undefined) return;
    const page = [...targets.values()].find(
      (target) => target.type === "page" && target.sessionId === sessionId,
    );
    if (page) input.resetTab(page.targetId);
  });
  const navigation = createNavigationController(scoped, (message) => {
    publish(message);
    deps.onNavigated(account, sid, message);
  });
  const browserZoom = createBrowserZoom({
    evaluate: async (session, expression) => {
      const result = (await scoped.send(session, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        silent: true,
      })) as { result?: { value?: unknown } };
      return result.result?.value;
    },
  });
  const theme = createClaudeTheme({
    copies: themeCopies,
    send: scoped.send,
    pages: () => [...targets.values()].filter((target) => target.type === "page"),
    report: (message) => report("client theme not shown", new Error(message)),
  });
  scoped.onAttached((target) => {
    if (target.type === "page")
      void theme.applyMedia(target).catch((error) => report("client theme failed", error));
  });
  const { pixelCapacity, grabSlots } = deps;
  const pixels = createScreencast({
    browser: scoped,
    hubFor: (tab) => tabs.hubFor(tab),
    publish,
    acquirePixel: (tab) => pixelCapacity.acquire(sid, tab),
    releasePixel: (tab) => pixelCapacity.release(sid, tab),
    backlogged: () => deps.backlogged(sid),
    ...(account.zoomReady ? { browserZoom } : {}),
    mobile: phone,
    screen: account.identity.screen,
    ...(pixelWindow
      ? {
          grab: {
            window: pixelWindow,
            ...(account.display
              ? {
                  createEncoder: grabEncoderForDisplay(account.display.env),
                  createJpeg: jpegGrabForDisplay(account.display.env),
                }
              : {}),
            acquire: () => grabSlots.acquire(sid),
            release: () => grabSlots.release(sid),
            available: () => grabSlots.available(),
          },
        }
      : {}),
    onError: (error) => report("client picture failed", error),
  });
  recovery = createRendererRecovery({
    browser: scoped,
    sessionFor: (tab) => targets.get(tab)?.sessionId,
    hubFor: (tab) => tabs.hubFor(tab),
    publish,
    onCrash(tab) {
      viewport.resetTab(tab);
      input.resetTab(tab);
      publish({ t: "resync", tab });
      pixels.reset(tab);
    },
    onError: (error) => report("client recovery", error),
  });
  const uploadDir = join(account.dir, "uploads", sid);
  let uploads: ClientRuntime["uploads"];
  try {
    await mkdir(uploadDir, { recursive: true });
    uploads = await createUploadManager({
      sessionId: sid,
      browser: scoped,
      uploadDir,
      publish,
      onError: (error) => report("client upload failed", error),
    });
  } catch (error) {
    recovery.dispose();
    pixels.dispose();
    navigation.dispose();
    viewport.dispose();
    tabs.dispose();
    await scoped.close().catch((closeError) => report("failed client cleanup", closeError));
    throw error;
  }
  const runtime: ClientRuntime = {
    theme,
    sid,
    assetKey,
    account,
    browser: scoped,
    targets,
    metadata,
    tabs,
    viewport,
    input,
    pixels,
    navigation,
    recovery,
    uploads,
    async stop() {
      uploads.close();
      runtime.rtc?.dispose();
      recovery!.dispose();
      pixels.dispose();
      navigation.dispose();
      viewport.dispose();
      tabs.dispose();
      try {
        await scoped.close();
      } finally {
        // Received files go even when a window refused to close.
        await rm(uploadDir, { recursive: true, force: true });
      }
    },
  };
  if (process.env.MIRROR_DISABLE_RTC !== "1")
    runtime.rtc = createRtcSignalRelay({
      send: scoped.send,
      callBridge: (session, method, args) => callAgentBridge(browser, session, method, args),
      bindingNameFor: (session) => agentBridgeChannel(browser, session)?.rtcBindingName,
      targets: scoped,
      onBindingCalled: (callback) => scoped.onSessionEvent("Runtime.bindingCalled", callback),
      sendViewer: (id, message) => deps.sendViewer(id, sid, message),
      onError: (error) => report("client media failed", error),
    });
  attach(runtime);
  try {
    if (tabs.size === 0) {
      const urls =
        sleeping && sleeping.token === deps.sessions.get(sid) && sleeping.profile === account.id
          ? sleeping.urls
          : [];
      const restored: string[] = [];
      for (const url of urls.length
        ? urls
        : [process.env.MIRROR_START_URL ?? "https://claude.ai/"]) {
        await tabs.handle({ t: "nav", tab: "", action: "newtab", url });
        restored.push(tabs.activeTabId!);
      }
      const active = sleeping && restored[sleeping.active];
      if (active) await tabs.handle({ t: "nav", tab: active, action: "activate" });
    }
    // Resolve same-process child frame ownership for the shared download manager too.
    for (const target of targets.values())
      if (target.type === "page") {
        const result = (await scoped.send(target.sessionId, "Page.getFrameTree")) as {
          frameTree?: { frame: { id: string }; childFrames?: unknown[] };
        };
        const visit = (tree: { frame: { id: string }; childFrames?: unknown[] }) => {
          frameOwners.set(tree.frame.id, sid);
          for (const child of tree.childFrames ?? []) visit(child as typeof tree);
        };
        if (result.frameTree) visit(result.frameTree);
      }
    await deps.sessions.setSleeping(record, false);
    return runtime;
  } catch (error) {
    detach();
    uploads.close();
    runtime.rtc?.dispose();
    recovery.dispose();
    pixels.dispose();
    navigation.dispose();
    viewport.dispose();
    tabs.dispose();
    await scoped.close().catch((closeError) => report("failed client cleanup", closeError));
    throw error;
  }
}
