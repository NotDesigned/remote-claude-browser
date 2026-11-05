/** Two independent workspaces over one authoritative Chrome and persistent login profile. */
import { encodeMsg, type Down, type Up, type ServerStatusMsg } from "@mirror/protocol";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessGate, ACCESS_MAX_AGE_SECONDS } from "./auth/access-gate";
import { createSessionGuard, SESSION_COOKIE } from "./auth/middleware";
import { mintInvite } from "./auth/invite";
import { createAssetCache } from "./assets/cache";
import { createAssetFetcher } from "./assets/fetch";
import { registerAssetRoutes } from "./assets/route";
import { createAgentLink } from "./browser/agentlink";
import { agentBridgeChannel, callAgentBridge } from "./browser/bridge";
import {
  afterSignInUrl,
  createClientBrowserPool,
  isClaudeUrl,
  type ClientBrowserScope,
} from "./browser/client-scope";
import { launchBrowser, type BrowserTargetInfo } from "./browser/launch";
import { connectRemoteBrowser } from "./browser/remote";
import { createNavigationController } from "./browser/nav";
import { createRendererRecovery } from "./browser/recovery";
import { createDownloadManager, registerDownloadRoutes } from "./downloads";
import { createUploadManager, registerUploadRoutes } from "./uploads";
import { createBrowserZoom } from "./browser/browser-zoom";
import { createGrabSlots, createPixelWindow } from "./browser/pixel-window";
import { createViewportAgreement } from "./hub/viewport";
import { createInputRelay, type InputMsg } from "./input/relay";
import { createScreencast } from "./px";
import { createPixelCapacity } from "./px-capacity";
import { ANY_SESSION_TAB } from "./assets/token";
import { createRtcSignalRelay } from "./rtcsig";
import { createClaudeTheme, isClaudeTheme } from "./claude/theme";
import { registerSecurityHeaders } from "./security-headers";
import { gatewayHost, LOOPBACK_PROXIES, registerViewerStatic } from "./serving";
import { createTabLifecycle } from "./session/tabs";
import { CLIENT_SLOTS, ClientSessionError, createClientSessions } from "./session/clients";
import { createIdleReaper } from "./session/idle-reaper";
import { createResourceSampler } from "./monitor/resources";
import type { TargetRef, AgentLink } from "./types";
import { createRoleManager } from "./ws/roles";
import { createWsServer, resumeCursorsFor } from "./ws/server";
import type { ViewerConn } from "./ws/viewerconn";

interface ClientRuntime {
  sid: string;
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

/** Frames wait before encoding beyond this, since a viewer cannot skip one once it is encoded. */
const VIDEO_BACKLOG_BYTES = 512 * 1024;
const PAGE_IDLE_RELEASE_MS = 60_000;

/** Kept across restarts, so that a restart does not invalidate what viewers have cached. */
async function loadAssetKey(file: string): Promise<Buffer> {
  try {
    const stored = await readFile(file);
    if (stored.length === 32) return stored;
  } catch {
    // Not there yet.
  }
  const key = randomBytes(32);
  await writeFile(file, key, { mode: 0o600 });
  return key;
}

export async function startClientGateway(): Promise<void> {
  const e2e = process.env.MIRROR_E2E === "1";
  const managedProfile = !process.env.CHROME_USER_DATA_DIR;
  const profile =
    process.env.CHROME_USER_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "mirror-clients-")));
  const browser = process.env.BROWSER_CDP_URL
    ? await connectRemoteBrowser(process.env.BROWSER_CDP_URL)
    : await launchBrowser({
        userDataDir: profile,
        executablePath: process.env.CHROME_PATH,
        headful: process.env.CHROME_HEADFUL === "1",
        // Sets the first window. On this display's wide screen it would otherwise be huge.
        // Nobody is at this browser to click: Claude's sound starts without a gesture here, and the
        // viewer's own browser applies its own rule.
        args: [
          "--disable-dev-shm-usage",
          "--window-size=1050,980",
          "--autoplay-policy=no-user-gesture-required",
          // This host is short of memory rather than of JavaScript speed, and new windows are rare
          // enough not to need a renderer waiting for them.
          "--js-flags=--optimize-for-size",
          "--disable-features=SpareRendererForSitePerProcess",
        ],
      });
  const pool = createClientBrowserPool(browser, {
    isolatedStorage: true,
    downloadDir: join(profile, "downloads"),
    // A shared login reached this session: leave any sign-in page it is stuck on.
    onLoginShared: (sid) => {
      const runtime = runtimes.get(sid);
      for (const target of runtime?.targets.values() ?? []) {
        if (target.type !== "page") continue;
        const destination = afterSignInUrl(runtime!.metadata.get(target.targetId)?.url);
        if (destination === null) continue;
        void runtime!.browser
          .send(target.sessionId, "Page.navigate", { url: destination })
          .catch((error) => report("shared login navigation failed", error));
      }
    },
    // Only a session that is visibly signed in may refresh everyone's shared login cookies.
    canPersistCookies: (sid) => {
      const urls = [...(runtimes.get(sid)?.metadata.values() ?? [])].map((info) => info.url);
      return urls.some(isClaudeUrl) && !urls.some((url) => afterSignInUrl(url) !== null);
    },
  });
  const app = Fastify({ logger: false, trustProxy: LOOPBACK_PROXIES });
  registerSecurityHeaders(app);
  const key = process.env.MIRROR_AUTH_SECRET
    ? Buffer.from(process.env.MIRROR_AUTH_SECRET)
    : randomBytes(32);
  const sessionGuard = createSessionGuard({ key });
  const clientSessions = await createClientSessions({
    file: join(profile, "client-sessions.json"),
  });
  const resourceSampler = createResourceSampler();
  let resources = await resourceSampler.sample();
  const currentOwner = (request: IncomingMessage): string | undefined => {
    if (e2e) {
      const value =
        request.headers["x-mirror-e2e-owner"] ??
        new URL(request.url ?? "/", "http://local").searchParams.get("e2e-owner");
      return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value)
        ? `test-${value}`
        : undefined;
    }
    const invite = sessionGuard.session(request);
    return invite?.role === "driver" && invite.sid.startsWith("device-") ? invite.sid : undefined;
  };
  const deviceCookie = (request: IncomingMessage) => {
    const previous = sessionGuard.session(request);
    const owner =
      previous?.role === "driver" && previous.sid.startsWith("device-")
        ? previous.sid
        : `device-${randomUUID()}`;
    const exp = Math.floor(Date.now() / 1000) + ACCESS_MAX_AGE_SECONDS;
    return `${SESSION_COOKIE}=${mintInvite({ sid: owner, role: "driver", exp }, key)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ACCESS_MAX_AGE_SECONDS}`;
  };
  const gate = createAccessGate({
    ...(e2e ? { password: "e2e-test-only" } : {}),
    cookiesOnSuccess: (request) => [deviceCookie(request)],
  });
  app.addHook("preHandler", async (request, reply) => {
    if (e2e) return;
    await gate.preHandler.call(app, request, reply);
    if (reply.sent) return;
    // Upgrade old single-workspace cookies to a stable authenticated device identity.
    if (gate.hasValidDevice(request.raw) && !currentOwner(request.raw))
      reply.header("set-cookie", deviceCookie(request.raw));
  });
  gate.registerRoutes(app);
  await registerViewerStatic(app);
  const requireSession = (sid?: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const requested = sid ?? (request.params as { sid?: string })?.sid;
    if (
      !requested ||
      closing.has(requested) ||
      !clientSessions.owns(currentOwner(request.raw), requested)
    )
      await reply.code(403).send({ error: "这个独立会话不属于当前客户端" });
  };
  const runtimePromises = new Map<string, Promise<ClientRuntime>>();
  const runtimes = new Map<string, ClientRuntime>();
  const closing = new Set<string>();
  const viewerIds = new WeakMap<ViewerConn, string>();
  const viewers = new Map<string, { viewer: ViewerConn; sid: string; owner: string }>();
  const frameOwners = new Map<string, string>();
  const sessionTargets = new Map<string, string>();
  browser.onAttached((target) => sessionTargets.set(target.sessionId, target.targetId));
  browser.onDetached((target) => {
    if (sessionTargets.get(target.sessionId) === target.targetId)
      sessionTargets.delete(target.sessionId);
  });
  browser.onSessionEvent("Page.frameNavigated", (session, event) => {
    const target = sessionTargets.get(session),
      owner = target ? pool.ownerOf(target) : undefined;
    if (owner) frameOwners.set(event.frame.id, owner);
  });
  /** Tabs whose page is using its microphone, for a viewer that connects while it does. */
  const micTabs = new Set<string>();
  const hasViewer = (sid: string) =>
    [...viewers.values()].some((connection) => connection.sid === sid);
  const agent = createAgentLink(browser, {
    publishClipboard(message, target) {
      const sid = pool.ownerOf(target);
      if (sid) publish(sid, message);
    },
    publishVoice(message, target) {
      const sid = pool.ownerOf(target);
      if (!sid) return;
      if ("audio" in message) {
        publish(sid, { t: "audio", tab: target, pcm: message.audio });
        return;
      }
      if (message.mic) micTabs.add(target);
      else micTabs.delete(target);
      publish(sid, { t: "mic", tab: target, on: message.mic });
      // With nobody connected there is no device to ask, so the page should not wait for one.
      if (message.mic && !hasViewer(sid)) sendVoice(target, { state: false });
    },
  });
  const sendVoice = (tab: string, value: { state: boolean } | { pcm: string }) => {
    const session = [...sessionTargets].find(([, target]) => target === tab)?.[0];
    if (session)
      void callAgentBridge(browser, session, "voice", [value]).catch(() => {
        // The page navigated away, which ends its use of the microphone as well.
      });
  };
  let stopping = false,
    nextViewer = 1;
  const report = (message: string, error: unknown) => {
    if (!stopping) console.error(message, error);
  };
  const roles = createRoleManager({
    onDriverChange(change) {
      const runtime = runtimes.get(change.sessionId);
      if (runtime && change.viewport) runtime.viewport.handle(change.to, change.viewport);
    },
  });
  const sidFromRequest = (request: IncomingMessage) =>
    new URL(request.url ?? "/", "http://local").searchParams.get("sid") ?? undefined;
  const ws = createWsServer({
    server: app.server,
    replaceSessionOnConnect: true,
    requireConnectionKey: true,
    hubs: () => [],
    hubsForSession: (sid) => runtimes.get(sid)?.tabs.hubs() ?? [],
    sessionForRequest: (request) => {
      const sid = sidFromRequest(request);
      return sid &&
        !closing.has(sid) &&
        clientSessions.owns(currentOwner(request), sid) &&
        runtimes.has(sid)
        ? sid
        : undefined;
    },
    authorizeUpgrade: async (request) => {
      if (!e2e && (!gate.authorizeUpgrade(request) || !sessionGuard.authorizeUpgrade(request)))
        return false;
      if (
        process.env.MIRROR_PUBLIC_ORIGIN &&
        request.headers.origin !== process.env.MIRROR_PUBLIC_ORIGIN
      )
        return false;
      const sid = sidFromRequest(request);
      if (!sid || !clientSessions.owns(currentOwner(request), sid) || closing.has(sid))
        return false;
      try {
        await ensureRuntime(sid);
        return !closing.has(sid) && clientSessions.owns(currentOwner(request), sid);
      } catch (error) {
        report("client websocket unavailable", error);
        return false;
      }
    },
    onConnection(viewer, request, sid) {
      if (!sid) return;
      const id = `viewer-${nextViewer++}`;
      viewerIds.set(viewer, id);
      viewers.set(id, { viewer, sid, owner: currentOwner(request)! });
      idleReaper.touch(sid);
      const runtime = runtimes.get(sid)!;
      // A reconnect whose replay position is still buffered keeps its geometry agreement: the
      // epoch did not change, so this viewer identity inherits the acknowledgement directly.
      const resumed = resumeCursorsFor(request)
        .filter((cursor) =>
          runtime.tabs.hubFor(cursor.tab)?.canResume(cursor.epoch, cursor.nextSeq),
        )
        .filter((cursor) => runtime.viewport.gate.inheritAgreement(id, cursor.tab))
        .map((cursor) => cursor.tab);
      roles.connect({
        sessionId: sid,
        inviteRole: "driver",
        viewerId: id,
        send: (message, serialized) => viewer.send(message, serialized),
        resumed,
      });
      viewer.send(
        {
          t: "mode",
          tab: runtime.tabs.activeTabId ?? "",
          mode: runtime.pixels.modeFor(runtime.tabs.activeTabId ?? "") ?? "dom",
        },
        encodeMsg({
          t: "mode",
          tab: runtime.tabs.activeTabId ?? "",
          mode: runtime.pixels.modeFor(runtime.tabs.activeTabId ?? "") ?? "dom",
        }),
      );
      for (const message of runtime.recovery.status()) viewer.send(message, encodeMsg(message));
      const capacity = { t: "px-capacity", available: pixelCapacity.available() } as const;
      viewer.send(capacity, encodeMsg(capacity));
      const currentStatus = status();
      viewer.send(currentStatus, encodeMsg(currentStatus));
      broadcastStatus();
      void runtime.tabs
        .tabsMessage()
        .then((message) => viewer.send(message, encodeMsg(message)))
        .catch((error) => report("client tabs unavailable", error));
    },
    onDisconnection(viewer, sid) {
      const id = viewerIds.get(viewer);
      if (!id) return;
      roles.disconnect(id);
      viewers.delete(id);
      runtimes.get(sid ?? "")?.viewport.removeViewer(id);
      runtimes.get(sid ?? "")?.rtc?.removeViewer(id);
      const runtime = runtimes.get(sid ?? "");
      if (runtime && ![...viewers.values()].some((connection) => connection.sid === sid)) {
        for (const hub of runtime.tabs.hubs()) runtime.input.resetTab(hub.tabId);
        void stopPixels(runtime).catch((error) => report("disconnected pixel cleanup", error));
      }
      broadcastStatus();
    },
    async onUp(viewer, message, sid) {
      const id = viewerIds.get(viewer),
        connection = id ? viewers.get(id) : undefined;
      if (
        !id ||
        !sid ||
        !connection ||
        !clientSessions.owns(connection.owner, sid) ||
        closing.has(sid)
      )
        return;
      const runtime = runtimes.get(sid);
      if (!runtime) return;
      // A valid driver is still forbidden from naming another client's CDP target.
      if ("tab" in message && message.tab !== "" && !runtime.browser.ownsTarget(message.tab))
        return;
      await roles.routeUp(id, message, (forwarded) => handle(runtime, id, forwarded));
    },
  });
  function publish(sid: string, message: Down) {
    if (stopping || closing.has(sid)) return;
    if (message.t === "snapshot") runtimes.get(sid)?.viewport.noteSnapshot(message);
    ws.fanout.publishToSession(sid, message);
  }
  const grabSlots = createGrabSlots();
  const displayGrabbable =
    process.env.CHROME_HEADFUL === "1" &&
    !!process.env.DISPLAY &&
    !process.env.BROWSER_CDP_URL &&
    process.env.MIRROR_SCREEN_GRAB !== "0";
  const pixelCapacity = createPixelCapacity({
    maxActive: Infinity,
    onChange() {
      for (const sid of runtimes.keys())
        publish(sid, { t: "px-capacity", available: pixelCapacity.available() });
      broadcastStatus();
    },
  });
  const onlineSessions = () => new Set([...viewers.values()].map((connection) => connection.sid));
  const onlineOwnerCount = () => {
    const owners = new Set<string>();
    for (const sid of onlineSessions()) {
      const owner = clientSessions.get(sid)?.owner;
      if (owner !== undefined) owners.add(owner);
    }
    return owners.size;
  };
  let lastStatusAt = 0;
  function status(): ServerStatusMsg {
    lastStatusAt = Math.max(Date.now(), lastStatusAt + 1);
    const stale = Date.now() - resources.sampledAt > 10000;
    return {
      ...resources,
      sampledAt: lastStatusAt,
      ...(stale
        ? {
            cpuPercent: null,
            memoryUsedBytes: null,
            memoryTotalBytes: null,
            browserMemoryBytes: null,
          }
        : {}),
      t: "server-status",
      clientsOnline: onlineOwnerCount(),
      clientsAllocated: CLIENT_SLOTS.length - clientSessions.available(),
      clientsMax: CLIENT_SLOTS.length,
      pixelsActive: pixelCapacity.count(),
      pixelsMax: null,
    };
  }
  function broadcastStatus() {
    if (stopping) return;
    const message = status();
    for (const sid of runtimes.keys()) publish(sid, message);
  }
  let e2eIdleOffset = 0;
  const idleReaper = createIdleReaper({
    sessions: () => clientSessions.all().map((record) => ({ sid: record.sid, token: record })),
    isOnline: (sid) => onlineSessions().has(sid),
    isBusy: async (sid) => {
      const runtime = runtimes.get(sid);
      if (!runtime) return false;
      for (const target of runtime.targets.values()) {
        if (target.type !== "page") continue;
        if (runtime.recovery.isBlocked(target.targetId)) continue;
        const response = (await Promise.race([
          runtime.browser.send(target.sessionId, "Runtime.evaluate", {
            expression: `(() => [...document.querySelectorAll('button')].some(e => e.getClientRects().length > 0 && /stop|停止/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('data-testid') || ''))))()`,
            returnByValue: true,
          }),
          new Promise<never>((_resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Idle page inspection timed out")),
              1500,
            );
            timeout.unref?.();
          }),
        ])) as { result?: { value?: unknown } };
        if (response.result?.value === true) return true;
      }
      return false;
    },
    release: async (sid, token) => {
      const current = clientSessions.get(sid);
      if (current && current === token && !onlineSessions().has(sid))
        await releaseClient(current.owner, sid);
    },
    graceMs: e2e ? Number(process.env.MIRROR_IDLE_GRACE_MS ?? 60000) : 60000,
    now: () => Date.now() + e2eIdleOffset,
    onError: (error) => report("idle client cleanup", error),
  });
  app.get("/api/status", async (request, reply) => {
    if (!currentOwner(request.raw)) return reply.code(401).send({ error: "请重新输入访问密码" });
    return reply.header("cache-control", "no-store").send(status());
  });
  const assetKey = await loadAssetKey(join(profile, "asset-token.key"));
  registerAssetRoutes(app, {
    serverKey: assetKey,
    cache: createAssetCache(join(profile, "asset-cache")),
    fetcher: createAssetFetcher({
      send: browser.send,
      sessionFor: (ref) => {
        const targets = runtimes.get(ref.sessionId)?.targets;
        if (ref.tabId === ANY_SESSION_TAB)
          return [...(targets?.values() ?? [])].find((target) => target.type === "page")?.sessionId;
        return pool.ownerOf(ref.tabId) === ref.sessionId
          ? targets?.get(ref.tabId)?.sessionId
          : undefined;
      },
    }),
    preHandler: requireSession(),
  });
  const downloadDir = join(profile, "downloads");
  await mkdir(downloadDir, { recursive: true });
  const downloads = await createDownloadManager({
    sessionId: "shared-account",
    browser,
    downloadDir,
    sessionForFrame: (frame) => {
      const sid = frameOwners.get(frame) ?? pool.ownerOf(frame);
      return sid && !closing.has(sid) ? sid : undefined;
    },
    publish: (message, sid) => publish(sid, message),
    onError: (error) => report("client download failed", error),
  });
  registerDownloadRoutes(app, {
    preHandler: requireSession(),
    managerFor: (sid) => (CLIENT_SLOTS.includes(sid as never) ? downloads : undefined),
  });
  registerUploadRoutes(app, {
    preHandler: requireSession(),
    managerFor: (sid) => runtimes.get(sid)?.uploads,
  });

  async function createRuntime(sid: string): Promise<ClientRuntime> {
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
      sendCmd: (target, command) => {
        if (!scoped.ownsTarget(target)) return Promise.reject(new Error("Foreign recorder target"));
        return agent.sendCmd(target, command);
      },
    };
    let recovery: ReturnType<typeof createRendererRecovery> | undefined;
    const tabs = createTabLifecycle({
      browser: scoped,
      agentLink: ownAgent,
      sessionId: sid,
      assetTokenKey: assetKey,
      publish: (message) => publish(sid, message),
      onSnapshot: (snapshot) => recovery?.noteSnapshot(snapshot.tab),
      onError: (error) => report("client tab failed", error),
    });
    const viewport = createViewportAgreement({
      send: scoped.send,
      sessionFor: (tab) => targets.get(tab)?.sessionId,
      hubFor: (tab) => tabs.hubFor(tab),
      isDriver: (id) => roles.isDriver(id) && viewers.get(id)?.sid === sid,
      confirmViewport: (_viewer, tab, { w, h }) => publish(sid, { t: "view-ok", tab, w, h }),
    });
    const input = createInputRelay({
      onValueStatus: (tab, failed) => publish(sid, { t: "input-status", tab, failed }),
      agentLink: ownAgent,
      send: scoped.send,
      callBridge: (session, method, args) => callAgentBridge(browser, session, method, args),
      sessionFor: (tab) => targets.get(tab)?.sessionId,
      isDriver: (id) => roles.isDriver(id) && viewers.get(id)?.sid === sid,
      allowsInput: (id, tab) => viewport.gate.allowsInput(id, tab),
      noteInput: (tab) => tabs.hubFor(tab)?.noteInput(),
      wheelScale: (tab) => tabs.hubFor(tab)?.pixelZoom ?? 1,
      viewportFor: (tab) => viewport.viewportFor(tab),
    });
    scoped.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
      if (event.frame.parentId !== undefined) return;
      const page = [...targets.values()].find(
        (target) => target.type === "page" && target.sessionId === sessionId,
      );
      if (page) input.resetTab(page.targetId);
    });
    const navigation = createNavigationController(scoped, (message) => publish(sid, message));
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
      send: scoped.send,
      pages: () => [...targets.values()].filter((target) => target.type === "page"),
    });
    scoped.onAttached((target) => {
      if (target.type === "page")
        void theme.applyMedia(target).catch((error) => report("client theme failed", error));
    });
    const pixels = createScreencast({
      browser: scoped,
      hubFor: (tab) => tabs.hubFor(tab),
      publish: (message) => publish(sid, message),
      acquirePixel: (tab) => pixelCapacity.acquire(sid, tab),
      releasePixel: (tab) => pixelCapacity.release(sid, tab),
      backlogged: () =>
        [...viewers.values()].some(
          (connection) =>
            connection.sid === sid && connection.viewer.socket.bufferedAmount > VIDEO_BACKLOG_BYTES,
        ),
      browserZoom,
      ...(displayGrabbable && scoped.sendBrowser
        ? {
            grab: {
              window: createPixelWindow({ sendBrowser: scoped.sendBrowser }),
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
      publish: (message) => publish(sid, message),
      onCrash(tab) {
        viewport.resetTab(tab);
        input.resetTab(tab);
        publish(sid, { t: "resync", tab });
        pixels.reset(tab);
      },
      onError: (error) => report("client recovery", error),
    });
    const uploadDir = join(profile, "uploads", sid);
    let uploads: ClientRuntime["uploads"];
    try {
      await mkdir(uploadDir, { recursive: true });
      uploads = await createUploadManager({
        sessionId: sid,
        browser: scoped,
        uploadDir,
        publish: (message) => publish(sid, message),
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
        await scoped.close();
        await rm(uploadDir, { recursive: true, force: true });
      },
    };
    if (process.env.MIRROR_DISABLE_RTC !== "1")
      runtime.rtc = createRtcSignalRelay({
        send: scoped.send,
        callBridge: (session, method, args) => callAgentBridge(browser, session, method, args),
        bindingNameFor: (session) => agentBridgeChannel(browser, session)?.rtcBindingName,
        targets: scoped,
        onBindingCalled: (callback) => scoped.onSessionEvent("Runtime.bindingCalled", callback),
        sendViewer(id, message) {
          const connection = viewers.get(id);
          return connection?.sid === sid
            ? (connection.viewer.send(message, encodeMsg(message)) ?? false)
            : false;
        },
        onError: (error) => report("client media failed", error),
      });
    runtimes.set(sid, runtime);
    try {
      if (tabs.size === 0)
        await tabs.handle({
          t: "nav",
          tab: "",
          action: "newtab",
          url: process.env.MIRROR_START_URL ?? "https://claude.ai/new",
        });
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
      return runtime;
    } catch (error) {
      runtimes.delete(sid);
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
  async function ensureRuntime(sid: string): Promise<ClientRuntime> {
    if (closing.has(sid))
      throw new ClientSessionError(503, "CLIENT_CLOSING", "会话正在结束，请稍后重试");
    let pending = runtimePromises.get(sid);
    if (!pending) {
      pending = createRuntime(sid);
      runtimePromises.set(sid, pending);
      void pending.catch(() => {
        if (runtimePromises.get(sid) === pending) runtimePromises.delete(sid);
      });
    }
    return pending;
  }
  async function handle(runtime: ClientRuntime, id: string, message: Up) {
    if ("tab" in message && message.tab && !runtime.browser.ownsTarget(message.tab)) return;
    if ((isInput(message) || message.t === "mode") && runtime.recovery.isBlocked(message.tab))
      return;
    if (message.t === "view" || message.t === "view-ack") {
      runtime.viewport.handle(id, message);
      // A viewer that has just come back needs to know the page is still listening.
      if (message.t === "view" && micTabs.has(message.tab))
        publish(runtime.sid, { t: "mic", tab: message.tab, on: true });
      return;
    }
    if (message.t === "mic-pcm") {
      sendVoice(message.tab, { pcm: message.pcm });
      return;
    }
    if (message.t === "mic-state") {
      if (!message.ok) micTabs.delete(message.tab);
      sendVoice(message.tab, { state: message.ok });
      return;
    }
    if (message.t === "resync-req") {
      ws.fanout.flushSession(runtime.sid);
      runtime.tabs.hubFor(message.tab)?.requestSnapshot("resync");
      return;
    }
    if (message.t === "vid-key") {
      runtime.pixels.requestKeyframe(message.tab);
      return;
    }
    if (message.t === "mode") {
      await runtime.pixels.handle(message);
      publish(runtime.sid, { t: "px-capacity", available: pixelCapacity.available() });
      return;
    }
    if (message.t === "rtc-sig") {
      await runtime.rtc?.handleViewer(id, message);
      return;
    }
    if (message.t === "nav") {
      if (message.action === "newtab" || message.action === "activate")
        await stopPixels(runtime, message.action === "activate" ? message.tab : undefined);
      if (["newtab", "close", "activate"].includes(message.action))
        await runtime.tabs.handle(message);
      else await runtime.navigation.handle(message);
      return;
    }
    if (isInput(message)) await runtime.input(id, message);
  }
  async function stopPixels(runtime: ClientRuntime, exceptTab?: string) {
    const holder = pixelCapacity.holder(runtime.sid);
    if (holder?.sid === runtime.sid && holder.tab !== exceptTab)
      await runtime.pixels.handle({ t: "mode", tab: holder.tab, mode: "dom" });
  }
  const clientError = (reply: FastifyReply, error: unknown, owner?: string) => {
    if (error instanceof ClientSessionError)
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
        ownedSessions: owner ? clientSessions.owned(owner) : [],
      });
    report("client session failed", error);
    return reply
      .code(503)
      .send({ error: "远程会话暂不可用，请稍后重试", code: "CLIENT_UNAVAILABLE" });
  };
  app.post<{ Body: { clientKey?: unknown; sid?: unknown } }>(
    "/api/client/session",
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      if (!owner) return reply.code(401).send({ error: "请重新输入访问密码" });
      try {
        const existing = clientSessions
          .all()
          .some(
            (record) =>
              record.owner === owner &&
              (record.clientKey === request.body?.clientKey || record.sid === request.body?.sid),
          );
        if (!e2e && !existing) {
          resources = await resourceSampler.sample();
          const available =
            resources.memoryTotalBytes === null || resources.memoryUsedBytes === null
              ? null
              : resources.memoryTotalBytes - resources.memoryUsedBytes;
          const memoryBudget =
            resources.browserMemoryLimitBytes ??
            (resources.memoryTotalBytes === null
              ? 1600 * 1048576
              : resources.memoryTotalBytes * 0.8);
          const workspaceHeadroom = Math.max(300 * 1048576, memoryBudget * 0.1);
          if (
            (resources.browserMemoryBytes !== null &&
              resources.browserMemoryBytes > memoryBudget - workspaceHeadroom) ||
            (available !== null && available < 256 * 1048576)
          )
            throw new ClientSessionError(
              503,
              "CLIENT_RESOURCES",
              "B 的内存较紧张，请等待离线会话自动回收后重试",
            );
        }
        const record = await clientSessions.acquire(
          owner,
          request.body?.clientKey,
          request.body?.sid,
        );
        idleReaper.touch(record.sid);
        broadcastStatus();
        await ensureRuntime(record.sid);
        return {
          ...clientSessions.describe(record.sid),
          maxClients: CLIENT_SLOTS.length,
          available: clientSessions.available(),
          sharedAccount: true,
        };
      } catch (error) {
        return clientError(reply, error, owner);
      }
    },
  );
  async function releaseClient(owner: string, sid: string) {
    if (!clientSessions.owns(owner, sid))
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话已结束");
    if (closing.has(sid)) throw new ClientSessionError(409, "CLIENT_CLOSING", "会话正在结束");
    closing.add(sid);
    try {
      ws.closeSession(sid);
      downloads.revokeSession(sid);
      for (const [id, connection] of viewers)
        if (connection.sid === sid) {
          roles.disconnect(id);
          viewers.delete(id);
        }
      const runtime = await runtimePromises.get(sid);
      if (runtime) await runtime.stop();
      else await pool.scope(sid).close();
      const deadline = Date.now() + 2000;
      while (
        pool
          .scope(sid)
          .targets()
          .some((target) => target.type === "page") &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (
        pool
          .scope(sid)
          .targets()
          .some((target) => target.type === "page")
      )
        throw new Error("Client window did not close");
      await clientSessions.release(owner, sid);
      for (const [frame, session] of frameOwners) if (session === sid) frameOwners.delete(frame);
    } finally {
      runtimes.delete(sid);
      runtimePromises.delete(sid);
      closing.delete(sid);
      broadcastStatus();
    }
  }
  app.delete<{ Params: { sid: string } }>("/api/client/session/:sid", async (request, reply) => {
    const owner = currentOwner(request.raw);
    if (!owner) return reply.code(403).send({ error: "这个会话不属于当前客户端" });
    try {
      await releaseClient(owner, request.params.sid);
      return reply.code(204).send();
    } catch (error) {
      return clientError(reply, error, owner);
    }
  });
  for (const sid of CLIENT_SLOTS) {
    app.get(`/s/${sid}/theme`, { preHandler: requireSession(sid) }, async () => ({
      theme:
        (await runtimes
          .get(sid)
          ?.theme.read()
          .catch(() => null)) ?? null,
    }));
    app.post<{ Body: { theme?: unknown; systemDark?: unknown } }>(
      `/s/${sid}/theme`,
      { preHandler: requireSession(sid), bodyLimit: 1024 },
      async (request, reply) => {
        const { theme, systemDark } = request.body ?? {};
        if (!isClaudeTheme(theme)) return reply.code(400).send({ error: "未知的外观" });
        const applied = (await runtimes.get(sid)?.theme.set(theme, systemDark === true)) ?? false;
        return { applied };
      },
    );
  }
  app.get("/healthz", async (_request, reply) => {
    const alive = browser.isAlive?.() !== false,
      pages = [...runtimes.values()].flatMap((runtime) =>
        runtime.recovery.status().map(({ state }) => state),
      );
    const ok = alive && pages.length === 0;
    return reply
      .code(ok ? 200 : 503)
      .send({ ok, browser: alive, pages, clients: runtimes.size, maxClients: CLIENT_SLOTS.length });
  });
  if (e2e) {
    app.post<{ Body: { milliseconds?: number } }>("/__e2e/advance-idle", async (request, reply) => {
      if (!currentOwner(request.raw)) return reply.code(401).send({ error: "Forbidden" });
      const amount = request.body?.milliseconds;
      if (!Number.isSafeInteger(amount) || amount! < 0 || amount! > 1000000)
        return reply.code(400).send({ error: "Invalid test time" });
      await idleReaper.sweep();
      e2eIdleOffset += amount!;
      await idleReaper.sweep();
      return status();
    });
    app.get("/__e2e/probe", async () => ({ serverTs: Date.now() }));
    app.get<{ Querystring: { sid?: string } }>("/__e2e/state", async (request, reply) => {
      const sid = request.query.sid;
      if (!sid || !clientSessions.owns(currentOwner(request.raw), sid))
        return reply.code(403).send({ error: "Forbidden" });
      const runtime = await ensureRuntime(sid);
      return {
        sid,
        tabs: [...runtime.tabs.hubs()].map((hub) => ({
          tab: hub.tabId,
          epoch: hub.epoch,
          docId: hub.docId,
          seq: hub.seq,
          url: runtime.metadata.get(hub.tabId)?.url ?? "",
        })),
      };
    });
    app.post<{ Body: { sid?: string; tab?: string; expression?: string } }>(
      "/__e2e/evaluate",
      async (request, reply) => {
        const { sid, tab, expression } = request.body;
        if (!sid || !clientSessions.owns(currentOwner(request.raw), sid))
          return reply.code(403).send({ error: "Forbidden" });
        const runtime = await ensureRuntime(sid),
          target = tab
            ? runtime.targets.get(tab)
            : [...runtime.targets.values()].find((item) => item.type === "page");
        if (
          !target ||
          !runtime.browser.ownsTarget(target.targetId) ||
          typeof expression !== "string"
        )
          return reply.code(403).send({ error: "Forbidden" });
        const result = (await runtime.browser.send(target.sessionId, "Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
        if (result.exceptionDetails)
          return reply.code(500).send({ error: "Fixture expression failed" });
        return { value: result.result?.value };
      },
    );
  }
  const healthTimer = setInterval(() => {
    if (browser.isAlive?.() === false) {
      console.error("Chrome process died; restarting client gateway");
      process.exit(1);
    }
  }, 2000);
  healthTimer.unref?.();
  const statusTimer = setInterval(() => {
    void resourceSampler
      .sample()
      .then((sample) => {
        resources = sample;
        broadcastStatus();
      })
      .catch((error) => report("resource sampling", error));
  }, 3000);
  statusTimer.unref?.();
  /** A page nothing is happening on gives back its caches, which its renderer holds on to. */
  const releasedAt = new WeakMap<object, number>();
  const releaseIdlePageMemory = () => {
    const now = Date.now();
    for (const runtime of runtimes.values())
      for (const hub of runtime.tabs.hubs()) {
        if (now - hub.lastActivityAt < PAGE_IDLE_RELEASE_MS) continue;
        if ((releasedAt.get(hub) ?? 0) >= hub.lastActivityAt) continue;
        const session = runtime.targets.get(hub.tabId)?.sessionId;
        if (!session) continue;
        releasedAt.set(hub, now);
        void browser
          .send(session, "Memory.simulatePressureNotification", { level: "critical" })
          .catch((error) => report("page memory release failed", error));
      }
  };
  const idleTimer = setInterval(
    () => {
      void idleReaper.sweep();
      releaseIdlePageMemory();
    },
    e2e ? 200 : 3000,
  );
  idleTimer.unref?.();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(healthTimer);
    clearInterval(statusTimer);
    clearInterval(idleTimer);
    idleReaper.dispose();
    downloads.close();
    await ws.close().catch(() => {});
    for (const runtime of runtimes.values()) {
      await runtime.stop().catch((error) => report("client shutdown failed", error));
    }
    pool.dispose();
    await app.close().catch(() => {});
    await browser.close().catch(() => {});
    if (managedProfile) await rm(profile, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void stop().finally(() => process.exit(0)));
  const port = Number(process.env.GATEWAY_PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid GATEWAY_PORT");
  try {
    await app.listen({ host: gatewayHost(), port });
    console.log(`multi-client gateway listening at http://${gatewayHost()}:${port}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
function isInput(message: Up): message is InputMsg {
  return ["ptr", "key", "text", "value", "ime", "scroll"].includes(message.t);
}
