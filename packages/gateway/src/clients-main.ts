/**
 * Independent workspaces over one Chrome per account. Sessions on one account share its login
 * profile. Profiles separate site storage; shared infrastructure is not an unlinkability guarantee.
 */
import { encodeMsg, type Down, type Up, type ServerStatusMsg } from "@mirror/protocol";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_MAX_AGE_SECONDS } from "./auth/access-gate";
import { createUserGate } from "./auth/user-gate";
import { createUserStore, UserStoreError, type FrontendUser } from "./auth/users";
import { createSessionGuard, SESSION_COOKIE } from "./auth/middleware";
import { mintInvite } from "./auth/invite";
import { createAssetCache } from "./assets/cache";
import { createAssetFetcher } from "./assets/fetch";
import { registerAssetRoutes } from "./assets/route";
import { createAgentLink } from "./browser/agentlink";
import { createPhoneTargetPreparer, isPhoneRequest, waitForOwner } from "./browser/phone-identity";
import { agentBridgeChannel, callAgentBridge, callFrameAgent } from "./browser/bridge";
import {
  afterSignInUrl,
  createClientBrowserPool,
  type ClientBrowserScope,
} from "./browser/client-scope";
import { launchBrowser, type BrowserHandle, type BrowserTargetInfo } from "./browser/launch";
import { launchBrokerBrowser } from "./browser/broker";
import { createProxyCatalog, ProxyCatalogError } from "./egress/catalog";
import { registerProxyRoutes } from "./egress/routes";
import { createRuntimeClient } from "./egress/runtime-client";
import { createCpaStore } from "./cpa/store";
import { createCpaRuntime } from "./cpa/runtime";
import { createCpaBrokerDriver } from "./cpa/broker-client";
import { registerCpaRoutes, registerCpaInferenceRoutes } from "./cpa/routes";
import { createAccountDisplay, type AccountDisplay } from "./browser/display";
import { createClaudeLoginTracker, profileSignedIn } from "./claude/signed-in";
import { browserIdentity, identityEnvironment, type BrowserIdentity } from "./browser/identity";
import { connectRemoteBrowser } from "./browser/remote";
import { createNavigationController } from "./browser/nav";
import { createRendererRecovery } from "./browser/recovery";
import { createDownloadManager, registerDownloadRoutes } from "./downloads";
import { createUploadManager, registerUploadRoutes } from "./uploads";
import { createBrowserZoom, installZoomExtension } from "./browser/browser-zoom";
import { createGrabSlots, createPixelWindow } from "./browser/pixel-window";
import { createViewportAgreement } from "./hub/viewport";
import { createInputRelay, type InputMsg } from "./input/relay";
import { createScreencast } from "./px";
import { createPixelCapacity } from "./px-capacity";
import { grabEncoderForDisplay } from "./px-video";
import { ANY_SESSION_TAB } from "./assets/token";
import { createRtcSignalRelay } from "./rtcsig";
import { createClaudeTheme, createThemeCopies, isClaudeTheme } from "./claude/theme";
import { registerSecurityHeaders } from "./security-headers";
import { gatewayHost, registerViewerStatic, trustedProxies } from "./serving";
import { createTabLifecycle } from "./session/tabs";
import { isClientSlot, ClientSessionError, createClientSessions } from "./session/clients";
import { createLifecycleLock } from "./session/lifecycle-lock";
import { createIdleReaper, PAGE_GENERATING_EXPRESSION } from "./session/idle-reaper";
import {
  createPageSleep,
  PAGE_PLAYING_EXPRESSION,
  pageSleepAfterMs,
  sleepPlaceholderUrl,
} from "./session/page-sleep";
import { createProfileStore, DEFAULT_PROFILE, MAX_PROFILES } from "./session/profiles";
import { createResourceSampler } from "./monitor/resources";
import type { TargetRef, AgentLink } from "./types";
import { createRoleManager } from "./ws/roles";
import { createWsServer, resumeCursorsFor } from "./ws/server";
import type { ViewerConn } from "./ws/viewerconn";

/** One account: its Chrome, and what the gateway keeps for that Chrome. */
interface Account {
  id: string;
  dir: string;
  browser: BrowserHandle;
  proxyUrl?: string;
  display?: AccountDisplay;
  identity: BrowserIdentity;
  pool: ReturnType<typeof createClientBrowserPool>;
  login: ReturnType<typeof createClaudeLoginTracker>;
  agent: ReturnType<typeof createAgentLink>;
  themeCopies: ReturnType<typeof createThemeCopies>;
  downloads: Awaited<ReturnType<typeof createDownloadManager>>;
  zoomReady: boolean;
  frameOwners: Map<string, string>;
  sessionTargets: Map<string, string>;
  /** Since when no session has used it. */
  unusedSince: number | null;
}

interface ClientRuntime {
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

/** Frames wait before encoding beyond this, since a viewer cannot skip one once it is encoded. */
const VIDEO_BACKLOG_BYTES = 512 * 1024;
const PAGE_IDLE_RELEASE_MS = 60_000;
/** An account's Chrome nobody has used for this long is closed. It starts again when needed. */
const ACCOUNT_IDLE_CLOSE_MS = 120_000;
/** Headroom for another Chrome plus its private Xvfb display before the first page. */
const ACCOUNT_MEMORY_BYTES = 560 * 1048576;

const CHROME_ARGS = [
  "--disable-dev-shm-usage",
  // Nobody is at this browser to click: Claude's sound starts without a gesture here, and the
  // viewer's own browser applies its own rule.
  "--autoplay-policy=no-user-gesture-required",
  // This host is short of memory rather than of JavaScript speed, and new windows are rare
  // enough not to need a renderer waiting for them.
  "--js-flags=--optimize-for-size",
  "--disable-features=SpareRendererForSitePerProcess",
  // Sessions share the profile now, so a restart would otherwise offer to restore them.
  "--hide-crash-restore-bubble",
  // Only over this private pipe: it lets the picture's zoom extension be loaded below.
  "--enable-unsafe-extension-debugging",
];

export async function startClientGateway(
  options: {
    listen?: boolean;
    signals?: boolean;
    resourceSampler?: ReturnType<typeof createResourceSampler>;
  } = {},
) {
  const e2e = process.env.MIRROR_E2E === "1";
  const managedProfile = !process.env.CHROME_USER_DATA_DIR;
  const profile =
    process.env.CHROME_USER_DATA_DIR ?? (await mkdtemp(join(tmpdir(), "mirror-clients-")));
  // Other accounts keep their profiles beside the default one.
  const accountsDir = process.env.MIRROR_ACCOUNTS_DIR ?? `${profile}-accounts`;
  const accountStore = await createProfileStore({
    file: join(profile, "accounts.json"),
    maxProfiles: Infinity,
  });
  const userStore = await createUserStore({
    file: process.env.MIRROR_USERS_DB ?? join(profile, "users.sqlite"),
    bootstrapUsername: process.env.MIRROR_ADMIN_USERNAME ?? "admin",
    bootstrapPassword: process.env.MIRROR_ACCESS_PASSWORD ?? (e2e ? "e2e-test-only" : undefined),
  });
  userStore.claimLegacyProfiles(
    accountStore.all().map((record) => record.id),
    userStore.bootstrapAdmin.id,
  );
  const accountLifecycle = createLifecycleLock();
  const networkRuntime = createRuntimeClient({ socketPath: process.env.MIRROR_RUNTIME_SOCKET });
  const scopedExits = new Map<string, Set<string>>();
  const resetProfileNetwork = async (id: string) => {
    const sessions = clientSessions
      .all()
      .filter((record) => (record.profile ?? DEFAULT_PROFILE) === id);
    for (const record of sessions) closing.add(record.sid);
    try {
      for (const record of sessions) await stopRuntime(record.sid);
      const account = accounts.get(id) ?? (await openingAccounts.get(id));
      if (account) await closeAccount(account);
    } finally {
      for (const record of sessions) {
        runtimes.delete(record.sid);
        runtimePromises.delete(record.sid);
        closing.delete(record.sid);
      }
      broadcastStatus();
    }
  };
  const invalidateNodes = async (ids: string[]) => {
    if (!process.env.MIRROR_RUNTIME_SOCKET) return;
    await accountLifecycle.run(async () => {
      for (const record of accountStore.all())
        if (record.proxyId && ids.includes(record.proxyId)) await resetProfileNetwork(record.id);
      for (const id of ids) {
        for (const scope of scopedExits.get(id) ?? []) await networkRuntime.stopEgress(scope);
        scopedExits.delete(id);
      }
    });
  };
  const proxyCatalog = await createProxyCatalog({
    file: join(profile, "proxy-sources.json"),
    endpointForNode: async (id, node, user) => {
      if (!process.env.MIRROR_RUNTIME_SOCKET)
        throw new ProxyCatalogError(503, "PROXY_RUNTIME_DISABLED", "请在部署中启用独立出口运行时");
      const scope = `scope-${createHash("sha256").update(`${user.id}/${id}`).digest("hex").slice(0, 32)}`;
      const scopes = scopedExits.get(id) ?? new Set<string>();
      scopes.add(scope);
      scopedExits.set(id, scopes);
      return (await networkRuntime.startEgress(scope, node)).externalProxyUrl;
    },
    onRemovedNodes: invalidateNodes,
    onChangedNodes: async (ids) => {
      await invalidateNodes(ids);
      await cpaRuntime?.restoreBindings(ids, (instance) =>
        instance.ownerId ? userStore.getUser(instance.ownerId) : userStore.bootstrapAdmin,
      );
    },
  });
  const cpaStore = process.env.CPA_BROKER_SOCKET
    ? await createCpaStore({ file: join(profile, "cpa.sqlite") })
    : undefined;
  const cpaRuntime = cpaStore
    ? createCpaRuntime({
        store: cpaStore,
        driver: createCpaBrokerDriver(process.env.CPA_BROKER_SOCKET!),
        resolveProxyForUser: async (user, proxyId) =>
          proxyId
            ? proxyCatalog.resolveProxyForUser(user, proxyId)
            : {
                id: "deployment-default",
                name: "部署默认出口",
                url: (await networkRuntime.startEgress("deployment-default")).externalProxyUrl,
              },
        userEnabled: (id) => userStore.getUser(id)?.enabled === true,
      })
    : undefined;
  if (cpaRuntime) {
    const restored = await cpaRuntime.restore((instance) =>
      instance.ownerId ? userStore.getUser(instance.ownerId) : userStore.bootstrapAdmin,
    );
    if (restored.failures.length)
      console.error("Some CPA exits could not be restored:", restored.failures);
  }
  const app = Fastify({ logger: false, trustProxy: trustedProxies() });
  registerSecurityHeaders(app);
  const key = process.env.MIRROR_AUTH_SECRET
    ? Buffer.from(process.env.MIRROR_AUTH_SECRET)
    : randomBytes(32);
  const sessionGuard = createSessionGuard({ key });
  const clientSessions = await createClientSessions({
    file: join(profile, "client-sessions.json"),
  });
  if (!e2e)
    await clientSessions.migrateOwners((owner) =>
      owner.startsWith("device-") ? `${userStore.bootstrapAdmin.id}/${owner}` : owner,
    );
  const resourceSampler = options.resourceSampler ?? createResourceSampler();
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
    const user = gate.currentUser(request);
    return user ? ownerForUser(request, user) : undefined;
  };
  const ownerForUser = (request: IncomingMessage, user: FrontendUser): string | undefined => {
    const invite = sessionGuard.session(request);
    return invite?.role === "driver" && invite.sid.startsWith("device-")
      ? `${user.id}/${invite.sid}`
      : undefined;
  };
  const currentUser = (request: IncomingMessage) =>
    e2e ? userStore.bootstrapAdmin : gate.currentUser(request);
  const requireLiveOwner = (request: IncomingMessage, owner: string) => {
    const user = currentUser(request);
    if (stopping || !user || currentOwner(request) !== owner)
      throw new UserStoreError(401, "LOGIN_REQUIRED", "请重新登录");
    return user;
  };
  const ownsSession = (request: IncomingMessage, sid: string) => {
    const user = currentUser(request);
    return (
      !!user &&
      clientSessions.owns(currentOwner(request), sid) &&
      userStore.profileOwner(clientSessions.profileOf(sid)) === user.id
    );
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
  const gate = createUserGate({
    store: userStore,
    publicOrigin: process.env.MIRROR_PUBLIC_ORIGIN,
    cookiesOnSuccess: (request) => [deviceCookie(request)],
    async onLogout(request, user) {
      const owner = user && ownerForUser(request, user);
      if (owner)
        for (const record of clientSessions.all())
          if (record.owner === owner) await releaseClient(owner, record.sid);
    },
  });
  app.addHook("preHandler", async (request, reply) => {
    if (stopping) return reply.code(503).send({ error: "服务正在重启，请稍后重试" });
    if (e2e) return;
    if (cpaRuntime && request.url.startsWith("/v1/")) return;
    await gate.preHandler.call(app, request, reply);
    if (reply.sent) return;
    // Upgrade old single-workspace cookies to a stable authenticated device identity.
    if (gate.hasValidDevice(request.raw) && !currentOwner(request.raw))
      reply.header("set-cookie", deviceCookie(request.raw));
  });
  gate.registerRoutes(app);
  registerProxyRoutes(app, {
    catalog: proxyCatalog,
    currentUser: (request) => currentUser(request) ?? null,
  });
  if (cpaRuntime) {
    registerCpaRoutes(app, { runtime: cpaRuntime, currentUser });
    registerCpaInferenceRoutes(app, cpaRuntime);
  }
  await registerViewerStatic(app);
  const requireSession = (sid?: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const requested = sid ?? (request.params as { sid?: string })?.sid;
    if (!requested || closing.has(requested) || !ownsSession(request.raw, requested))
      await reply.code(403).send({ error: "这个独立会话不属于当前客户端" });
  };
  const runtimePromises = new Map<string, Promise<ClientRuntime>>();
  const runtimes = new Map<string, ClientRuntime>();
  const closing = new Set<string>();
  const viewerIds = new WeakMap<ViewerConn, string>();
  const viewers = new Map<
    string,
    {
      viewer: ViewerConn;
      sid: string;
      owner: string;
      userId: string;
      authorized(): boolean;
      /** Whether it is on screen. Viewers that never say count as looking. */
      visible: boolean;
    }
  >();
  /** Tabs whose page is using its microphone, for a viewer that connects while it does. */
  const micTabs = new Set<string>();
  const hasViewer = (sid: string) =>
    [...viewers.values()].some((connection) => connection.sid === sid);
  const sendVoice = (
    account: Pick<Account, "browser" | "sessionTargets">,
    tab: string,
    value: { state: boolean } | { pcm: string },
  ) => {
    const session = [...account.sessionTargets].find(([, target]) => target === tab)?.[0];
    if (session)
      void callAgentBridge(account.browser, session, "voice", [value]).catch(() => {
        // The page navigated away, which ends its use of the microphone as well.
      });
  };
  let stopping = false,
    nextViewer = 1;
  const report = (message: string, error: unknown) => {
    // A window that only starts a download closes itself while its setup is still being answered.
    if (error instanceof Error && error.name === "TargetCloseError") return;
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
      return sid && !closing.has(sid) && ownsSession(request, sid) && runtimes.has(sid)
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
      if (!sid || !ownsSession(request, sid) || closing.has(sid)) return false;
      try {
        await ensureRuntime(sid);
        return !closing.has(sid) && ownsSession(request, sid);
      } catch (error) {
        report("client websocket unavailable", error);
        return false;
      }
    },
    onConnection(viewer, request, sid) {
      if (!sid) return;
      const id = `viewer-${nextViewer++}`;
      viewerIds.set(viewer, id);
      viewers.set(id, {
        viewer,
        sid,
        owner: currentOwner(request)!,
        userId: currentUser(request)!.id,
        authorized: () => ownsSession(request, sid),
        visible: true,
      });
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
        !connection.authorized() ||
        !clientSessions.owns(connection.owner, sid) ||
        closing.has(sid)
      )
        return;
      const runtime = runtimes.get(sid);
      if (!runtime) return;
      // A valid driver is still forbidden from naming another client's CDP target.
      if ("tab" in message && message.tab !== "" && !runtime.browser.ownsTarget(message.tab))
        return;
      // Any viewer, driver or not, says whether it is on screen.
      if (message.t === "visibility") {
        connection.visible = message.visible === true;
        if (connection.visible) await pageSleep.look(sid);
        return;
      }
      await roles.routeUp(id, message, (forwarded) => handle(runtime, id, forwarded));
    },
  });
  // Full snapshots are the heavy part of page sync: how often, why, how big and how slow.
  ws.fanout.onSnapshot = (sid, message, bytes) => {
    if (sid === undefined) return;
    const ms = runtimes.get(sid)?.tabs.hubFor(message.tab)?.lastSnapshotMs;
    console.log(
      `snapshot: ${sid} ${message.reason ?? "page"} ${(bytes / 1048576).toFixed(1)} MB` +
        (ms === null || ms === undefined ? "" : ` in ${ms} ms`),
    );
  };
  function publish(sid: string, message: Down) {
    if (stopping || closing.has(sid)) return;
    if (message.t === "snapshot") {
      const reason = runtimes.get(sid)?.viewport.noteSnapshot(message);
      if (reason !== undefined) message.reason = reason;
    }
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
  // Chrome runs in this process's zone: TZ, or the system's.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
      clientsAllocated: clientSessions.all().length,
      clientsMax: clientSessions.capacity(),
      pixelsActive: pixelCapacity.count(),
      pixelsMax: null,
      timeZone,
    };
  }
  function broadcastStatus() {
    if (stopping) return;
    const message = status();
    for (const sid of runtimes.keys()) publish(sid, message);
  }
  let e2eIdleOffset = 0;
  /** Whether a page is writing a reply, which closing or reloading it would cut short. */
  function pageGenerating(runtime: ClientRuntime, target: TargetRef): Promise<boolean> {
    return pageAsks(runtime, target, PAGE_GENERATING_EXPRESSION);
  }
  async function pageAsks(
    runtime: ClientRuntime,
    target: TargetRef,
    expression: string,
  ): Promise<boolean> {
    const response = (await Promise.race([
      runtime.browser.send(target.sessionId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
      }),
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Idle page inspection timed out")), 1500);
        timeout.unref?.();
      }),
    ])) as { result?: { value?: unknown } };
    return response.result?.value === true;
  }
  /** Pages of sessions whose viewers have all been hidden or gone for a long time. */
  const pageSleepMs = pageSleepAfterMs(process.env.MIRROR_PAGE_SLEEP_MS);
  const pageSleep = createPageSleep({
    afterMs: pageSleepMs,
    watched: (sid) =>
      [...viewers.values()].some((connection) => connection.sid === sid && connection.visible),
    activeTab: (sid) => runtimes.get(sid)?.tabs.activeTabId,
    pages: (sid) =>
      [...(runtimes.get(sid)?.targets.values() ?? [])]
        .filter((target) => target.type === "page")
        .map((target) => target.targetId),
    async canSleep(sid, tab) {
      const runtime = runtimes.get(sid);
      const target = runtime?.targets.get(tab);
      if (!runtime || !target || closing.has(sid)) return false;
      if (runtime.recovery.isBlocked(tab) || micTabs.has(tab)) return false;
      if (runtime.pixels.modeFor(tab) === "px") return false;
      // A page that cannot be asked counts as busy.
      if (await pageGenerating(runtime, target).catch(() => true)) return false;
      return !(await pageAsks(runtime, target, PAGE_PLAYING_EXPRESSION).catch(() => true));
    },
    async sleep(sid, tab) {
      const runtime = runtimes.get(sid);
      const target = runtime?.targets.get(tab);
      if (!runtime || !target) return null;
      const history = (await runtime.browser.send(
        target.sessionId,
        "Page.getNavigationHistory",
      )) as {
        currentIndex: number;
        entries: { id: number; url: string; title: string }[];
      };
      const entry = history.entries[history.currentIndex];
      if (!entry || !/^https?:/.test(entry.url)) return null;
      await runtime.browser.send(target.sessionId, "Page.navigate", {
        url: sleepPlaceholderUrl(entry.title),
      });
      console.log(`page asleep: ${sid}`);
      return { entryId: entry.id, url: entry.url };
    },
    async wake(sid, tab, page) {
      const runtime = runtimes.get(sid);
      const target = runtime?.targets.get(tab);
      if (!runtime || !target) return;
      // Back to the page's own entry keeps its history as it was; a lost entry loads the address.
      await runtime.browser
        .send(target.sessionId, "Page.navigateToHistoryEntry", { entryId: page.entryId })
        .catch(() => runtime.browser.send(target.sessionId, "Page.navigate", { url: page.url }));
      console.log(`page awake: ${sid}`);
    },
    onError: (error) => report("page sleep", error),
  });
  const idleReaper = createIdleReaper({
    sessions: () => clientSessions.all().map((record) => ({ sid: record.sid, token: record })),
    isOnline: (sid) => onlineSessions().has(sid),
    isBusy: async (sid) => {
      const runtime = runtimes.get(sid);
      if (!runtime) return false;
      for (const target of runtime.targets.values()) {
        if (target.type !== "page") continue;
        if (runtime.recovery.isBlocked(target.targetId)) continue;
        if (await pageGenerating(runtime, target)) return true;
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
  const assetFetcher = createAssetFetcher({
    proxyFor: (ref) => runtimes.get(ref.sessionId)?.account.proxyUrl,
    // A CDP session belongs to one Chrome, and so to one account.
    send: (sessionId, method, params) => {
      const owner = [...accounts.values()].find((account) => account.sessionTargets.has(sessionId));
      return owner
        ? owner.browser.send(sessionId, method, params)
        : Promise.reject(new Error("Unknown browser session"));
    },
    sessionFor: (ref) => {
      const runtime = runtimes.get(ref.sessionId);
      const targets = runtime?.targets;
      if (ref.tabId === ANY_SESSION_TAB)
        return [...(targets?.values() ?? [])].find((target) => target.type === "page")?.sessionId;
      return runtime?.account.pool.ownerOf(ref.tabId) === ref.sessionId
        ? targets?.get(ref.tabId)?.sessionId
        : undefined;
    },
  });
  registerAssetRoutes(app, {
    serverKey: randomBytes(32),
    serverKeyForSession: (sid) => (closing.has(sid) ? undefined : runtimes.get(sid)?.assetKey),
    cache: createAssetCache(join(profile, "asset-cache")),
    fetcher: assetFetcher,
    preHandler: requireSession(),
  });
  registerDownloadRoutes(app, {
    preHandler: requireSession(),
    managerFor: (sid) =>
      isClientSlot(sid) ? accounts.get(clientSessions.profileOf(sid))?.downloads : undefined,
  });
  registerUploadRoutes(app, {
    preHandler: requireSession(),
    managerFor: (sid) => runtimes.get(sid)?.uploads,
  });

  const accounts = new Map<string, Account>();
  const openingAccounts = new Map<string, Promise<Account>>();
  const accountDir = (id: string) => (id === DEFAULT_PROFILE ? profile : join(accountsDir, id));
  const memoryShort = async (extraBytes = 0): Promise<boolean> => {
    resources = await resourceSampler.sample();
    const available =
      resources.memoryTotalBytes === null || resources.memoryUsedBytes === null
        ? null
        : resources.memoryTotalBytes - resources.memoryUsedBytes;
    const memoryBudget =
      resources.browserMemoryLimitBytes ??
      (resources.memoryTotalBytes === null ? 1600 * 1048576 : resources.memoryTotalBytes * 0.8);
    const workspaceHeadroom = Math.max(300 * 1048576, memoryBudget * 0.1) + extraBytes;
    return (
      (resources.browserMemoryBytes !== null &&
        resources.browserMemoryBytes > memoryBudget - workspaceHeadroom) ||
      (available !== null && available < 256 * 1048576 + extraBytes)
    );
  };

  async function buildAccount(
    id: string,
    dir: string,
    browser: BrowserHandle,
    identity: BrowserIdentity,
    display?: AccountDisplay,
  ): Promise<Account> {
    const zoomReady = await installZoomExtension(browser, join(dir, "zoom-extension")).then(
      () => true,
      (error: unknown) => {
        console.warn("The picture will stop at CSS pixels:", (error as Error).message);
        return false;
      },
    );
    const frameOwners = new Map<string, string>();
    const sessionTargets = new Map<string, string>();
    const login = createClaudeLoginTracker(browser, sessionTargets, {
      email: accountStore.get(id)?.email,
      signedIn: accountStore.get(id)?.signedIn,
      unavailable: accountStore.get(id)?.unavailable,
      save: (login) => accountStore.setLogin(id, login),
    });
    const pool = createClientBrowserPool(browser, {
      windowSize: identity.screen,
      onSignedIn: () => {
        for (const runtime of runtimes.values()) {
          if (runtime.account.id !== id) continue;
          for (const target of runtime.targets.values()) {
            if (target.type !== "page") continue;
            const destination = afterSignInUrl(runtime.metadata.get(target.targetId)?.url);
            if (destination === null) continue;
            void runtime.browser
              .send(target.sessionId, "Page.navigate", { url: destination })
              .catch((error) => report("shared login navigation failed", error));
          }
        }
      },
      onLoginState: login.observe,
    });
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
    const preparePhoneTarget = createPhoneTargetPreparer({
      send: browser.send,
      ownerOf: (targetId) => pool.ownerOf(targetId),
      isPhoneSession: (sid) => clientSessions.get(sid)?.phone === true,
      screen: identity.screen,
      onError: (error) => report("phone identity failed", error),
    });
    const themeCopies = createThemeCopies(browser.send);
    browser.onDetached((target) => themeCopies.forget(target.sessionId));
    const prepareThemeCopy = async (target: TargetRef): Promise<void> => {
      if (target.type !== "page") return;
      const owner = await waitForOwner(target, { ownerOf: (targetId) => pool.ownerOf(targetId) });
      if (owner === undefined) return;
      void themeCopies
        .install(target.sessionId, runtimes.get(owner)?.theme.current() ?? "auto", true)
        .catch((error) => report("client theme failed", error));
    };
    const agent = createAgentLink(browser, {
      prepareTarget: async (target) => {
        await Promise.all([preparePhoneTarget(target), prepareThemeCopy(target)]);
      },
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
        if (message.mic && !hasViewer(sid))
          sendVoice({ browser, sessionTargets }, target, { state: false });
      },
    });
    const downloadDir = join(dir, "downloads");
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
    return {
      id,
      dir,
      browser,
      identity,
      display,
      pool,
      login,
      agent,
      themeCopies,
      downloads,
      zoomReady,
      frameOwners,
      sessionTargets,
      unusedSince: null,
    };
  }

  /** The account's Chrome, started if it is not running. */
  async function openAccount(id: string): Promise<Account> {
    const open = accounts.get(id);
    if (open) return open;
    let pending = openingAccounts.get(id);
    if (!pending) {
      pending = (async () => {
        if (!accountStore.has(id))
          throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
        if (id !== DEFAULT_PROFILE) {
          if (process.env.BROWSER_CDP_URL)
            throw new ClientSessionError(
              503,
              "PROFILE_UNSUPPORTED",
              "连接外部浏览器时只能用一个账号",
            );
        }
        if (!e2e && (await memoryShort(ACCOUNT_MEMORY_BYTES)))
          throw new ClientSessionError(
            503,
            "PROFILE_RESOURCES",
            "内存不足以启动另一个浏览器，请等待空闲会话自动回收",
          );
        const dir = accountDir(id);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const external = id === DEFAULT_PROFILE && !!process.env.BROWSER_CDP_URL;
        const identity = browserIdentity(process.env.MIRROR_AUTH_SECRET ?? "", id);
        const display =
          !external && process.env.CHROME_HEADFUL === "1"
            ? await createAccountDisplay()
            : undefined;
        let browser: BrowserHandle | undefined;
        let proxyUrl: string | undefined;
        try {
          const proxyId = accountStore.get(id)!.proxyId;
          const launchOptions = {
            userDataDir: dir,
            executablePath: process.env.CHROME_PATH,
            headful: process.env.CHROME_HEADFUL === "1",
            enableExtensions: true,
            args: [
              ...CHROME_ARGS,
              `--window-size=${identity.screen.width},${identity.screen.height}`,
            ],
            env: { ...display?.env, ...(await identityEnvironment(dir, identity)) },
          };
          if (proxyId) {
            if (!process.env.MIRROR_RUNTIME_SOCKET || external)
              throw new ClientSessionError(
                503,
                "PROXY_RUNTIME_DISABLED",
                "当前部署未启用独立浏览器出口",
              );
            const owner = userStore.getUser(userStore.profileOwner(id)!);
            if (!owner?.enabled)
              throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器所属用户已停用");
            const node = proxyCatalog.getNodeConfig(owner, proxyId);
            ({ browser, proxyUrl } = await launchBrokerBrowser(id, node, launchOptions));
          } else
            browser = external
              ? await connectRemoteBrowser(process.env.BROWSER_CDP_URL!)
              : await launchBrowser(launchOptions);
          const account = await buildAccount(id, dir, browser, identity, display);
          account.proxyUrl = proxyUrl;
          accounts.set(id, account);
          return account;
        } catch (error) {
          await browser?.close().catch(() => {});
          await display?.close();
          throw error;
        }
      })();
      openingAccounts.set(id, pending);
      void pending
        .finally(() => {
          if (openingAccounts.get(id) === pending) openingAccounts.delete(id);
        })
        .catch(() => {});
    }
    return pending;
  }

  async function closeAccount(account: Account): Promise<void> {
    if (accounts.get(account.id) === account) accounts.delete(account.id);
    account.login.dispose();
    account.downloads.close();
    account.pool.dispose();
    await account.browser.close().catch(() => {});
    await account.display?.close();
  }

  // Every user's Chrome, including the migrated administrator profile, starts on demand.

  /** Whether any session is using the account, or about to. */
  const accountInUse = (id: string) =>
    [...runtimes.values()].some((runtime) => runtime.account.id === id) ||
    [...runtimePromises.keys()].some((sid) => clientSessions.profileOf(sid) === id);

  async function createRuntime(sid: string): Promise<ClientRuntime> {
    const account = await openAccount(clientSessions.profileOf(sid));
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
      publish: (message) => publish(sid, message),
      onSnapshot: (snapshot) => recovery?.noteSnapshot(snapshot.tab),
      onError: (error) => report("client tab failed", error),
    });
    const viewport = createViewportAgreement({
      send: scoped.send,
      sessionFor: (tab) => targets.get(tab)?.sessionId,
      hubFor: (tab) => tabs.hubFor(tab),
      isDriver: (id) => roles.isDriver(id) && viewers.get(id)?.sid === sid,
      mobile: clientSessions.get(sid)?.phone === true,
      screen: account.identity.screen,
      confirmViewport: (_viewer, tab, { w, h }) => publish(sid, { t: "view-ok", tab, w, h }),
    });
    const input = createInputRelay({
      onValueStatus: (tab, failed) => publish(sid, { t: "input-status", tab, failed }),
      agentLink: ownAgent,
      send: scoped.send,
      callBridge: (session, method, args) => callAgentBridge(browser, session, method, args),
      callFrame: (session, frame, method, args) =>
        callFrameAgent(browser, session, frame, method, args),
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
      copies: themeCopies,
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
      ...(account.zoomReady ? { browserZoom } : {}),
      mobile: clientSessions.get(sid)?.phone === true,
      screen: account.identity.screen,
      ...(displayGrabbable && scoped.sendBrowser
        ? {
            grab: {
              window: createPixelWindow({
                sendBrowser: scoped.sendBrowser,
                display: account.display?.env,
              }),
              ...(account.display
                ? { createEncoder: grabEncoderForDisplay(account.display.env) }
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
    return accountLifecycle.run(() => ensureRuntimeLocked(sid));
  }
  async function ensureRuntimeLocked(sid: string): Promise<ClientRuntime> {
    if (stopping) throw new ClientSessionError(503, "SERVICE_STOPPING", "服务正在重启");
    if (closing.has(sid))
      throw new ClientSessionError(503, "CLIENT_CLOSING", "会话正在结束，请稍后重试");
    const record = clientSessions.get(sid);
    const userId = record && userIdForOwner(record.owner);
    if (
      !record ||
      !userId ||
      userStore.getUser(userId)?.enabled !== true ||
      userStore.profileOwner(clientSessions.profileOf(sid)) !== userId
    )
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前用户");
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
      sendVoice(runtime.account, message.tab, { pcm: message.pcm });
      return;
    }
    if (message.t === "mic-state") {
      if (!message.ok) micTabs.delete(message.tab);
      sendVoice(runtime.account, message.tab, { state: message.ok });
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
      if (["newtab", "close", "activate"].includes(message.action)) {
        await runtime.tabs.handle(message);
        if (message.action === "activate") await pageSleep.look(runtime.sid);
      } else {
        // An address that does not load is an ordinary outcome, shown as a failed page. Letting this
        // propagate would close the viewer's connection, which is how it would hear about that page.
        await runtime.navigation
          .handle(message)
          .catch((error) => report("client navigation failed", error));
      }
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
    if (error instanceof ClientSessionError || error instanceof UserStoreError)
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
  app.post<{ Body: { clientKey?: unknown; sid?: unknown; account?: unknown } }>(
    "/api/client/session",
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      if (!owner) return reply.code(401).send({ error: "请重新输入访问密码" });
      try {
        return await accountLifecycle.run(async () => {
          const user = requireLiveOwner(request.raw, owner);
          const chosen = request.body?.account;
          if (
            chosen !== undefined &&
            (typeof chosen !== "string" ||
              !accountStore.has(chosen) ||
              userStore.profileOwner(chosen) !== user.id)
          )
            throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
          const existing = clientSessions
            .all()
            .some(
              (record) =>
                record.owner === owner &&
                (record.clientKey === request.body?.clientKey || record.sid === request.body?.sid),
            );
          if (!e2e && !existing && (await memoryShort()))
            throw new ClientSessionError(
              503,
              "CLIENT_RESOURCES",
              "内存较紧张，请等待离线会话自动回收后重试",
            );
          const record = await clientSessions.acquire(
            owner,
            request.body?.clientKey,
            request.body?.sid,
            isPhoneRequest(request.headers["user-agent"]),
          );
          try {
            if (
              !existing ||
              userStore.profileOwner(clientSessions.profileOf(record.sid)) !== user.id
            ) {
              if (runtimes.has(record.sid))
                throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "浏览器不属于当前用户");
              await clientSessions.setProfile(
                owner,
                record.sid,
                typeof chosen === "string" ? chosen : await defaultProfileFor(user),
              );
            }
            idleReaper.touch(record.sid);
            broadcastStatus();
            await ensureRuntimeLocked(record.sid);
            return {
              ...clientSessions.describe(record.sid),
              account: clientSessions.profileOf(record.sid),
              maxClients: clientSessions.capacity(),
              available: clientSessions.available(),
              sharedAccount: true,
            };
          } catch (error) {
            if (!existing)
              await releaseClientLocked(owner, record.sid).catch((cleanupError) =>
                report("new workspace rollback failed", cleanupError),
              );
            throw error;
          }
        });
      } catch (error) {
        return clientError(reply, error, owner);
      }
    },
  );
  /** Closes a session's windows and forgets its runtime. The caller marks it closing. */
  async function stopRuntime(sid: string): Promise<void> {
    ws.closeSession(sid);
    await assetFetcher.closeSession(sid);
    for (const [id, connection] of viewers)
      if (connection.sid === sid) {
        roles.disconnect(id);
        viewers.delete(id);
      }
    const runtime = await runtimePromises.get(sid)?.catch(() => undefined);
    const account = runtime?.account ?? accounts.get(clientSessions.profileOf(sid));
    account?.downloads.revokeSession(sid);
    if (!account) return;
    if (runtime) await runtime.stop();
    else await account.pool.scope(sid).close();
    const pages = () =>
      account.pool
        .scope(sid)
        .targets()
        .some((target) => target.type === "page");
    const deadline = Date.now() + 2000;
    while (pages() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if (pages()) throw new Error("Client window did not close");
    for (const [frame, session] of account.frameOwners)
      if (session === sid) account.frameOwners.delete(frame);
  }
  async function releaseClient(owner: string, sid: string) {
    return accountLifecycle.run(() => releaseClientLocked(owner, sid));
  }
  async function releaseClientLocked(owner: string, sid: string) {
    if (!clientSessions.owns(owner, sid))
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话已结束");
    if (closing.has(sid)) throw new ClientSessionError(409, "CLIENT_CLOSING", "会话正在结束");
    closing.add(sid);
    try {
      await stopRuntime(sid);
      await clientSessions.release(owner, sid);
    } finally {
      runtimes.delete(sid);
      runtimePromises.delete(sid);
      closing.delete(sid);
      broadcastStatus();
    }
  }
  /** Moves a session to another account. Its windows close; the viewer reconnects to new ones. */
  async function switchAccount(request: IncomingMessage, owner: string, sid: string, id: string) {
    return accountLifecycle.run(() => {
      requireLiveOwner(request, owner);
      return switchAccountLocked(owner, sid, id);
    });
  }
  async function switchAccountLocked(owner: string, sid: string, id: string) {
    if (!clientSessions.owns(owner, sid))
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话已结束");
    if (!accountStore.has(id)) throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
    if (userStore.profileOwner(id) !== userIdForOwner(owner))
      throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
    if (closing.has(sid)) throw new ClientSessionError(409, "CLIENT_CLOSING", "会话正在结束");
    if (clientSessions.profileOf(sid) === id) return;
    closing.add(sid);
    try {
      await stopRuntime(sid);
      await clientSessions.setProfile(owner, sid, id);
    } finally {
      runtimes.delete(sid);
      runtimePromises.delete(sid);
      closing.delete(sid);
      broadcastStatus();
    }
  }
  function userIdForOwner(owner: string): string | undefined {
    return e2e && owner.startsWith("test-")
      ? userStore.bootstrapAdmin.id
      : owner.includes("/")
        ? owner.slice(0, owner.indexOf("/"))
        : undefined;
  }
  async function defaultProfileFor(user: FrontendUser): Promise<string> {
    const preferred = userStore.defaultProfile(user.id);
    if (preferred) return preferred;
    const owned = accountStore
      .all()
      .filter((record) => userStore.profileOwner(record.id) === user.id);
    if (owned[0]) {
      userStore.setDefaultProfile(user.id, owned[0].id);
      return owned[0].id;
    }
    const created = await accountStore.create("默认浏览器");
    try {
      userStore.assignProfile(created.id, user.id);
    } catch (error) {
      await accountStore.remove(created.id);
      throw error;
    }
    return created.id;
  }
  const describeAccounts = (user: FrontendUser) =>
    accountStore
      .all()
      .filter((record) => userStore.profileOwner(record.id) === user.id)
      .map((record) => {
        const live = accounts.get(record.id)?.login.current();
        const hasCookie = live ? live.signedIn : profileSignedIn(accountDir(record.id));
        const unavailable = live ? !!live.unavailable : hasCookie && !!record.unavailable;
        const signedIn =
          hasCookie && !unavailable && (live ? live.signedIn : record.signedIn !== false);
        return {
          id: record.id,
          name: record.name,
          proxyId: record.proxyId ?? null,
          proxyName: record.proxyId
            ? (proxyCatalog.listNodes(user).find((node) => node.id === record.proxyId)?.name ??
              null)
            : null,
          running: accounts.has(record.id),
          signedIn,
          unavailable,
          email: signedIn ? (live ? live.email : (record.email ?? null)) : null,
          sessions: clientSessions
            .all()
            .filter((session) => (session.profile ?? DEFAULT_PROFILE) === record.id).length,
        };
      });
  app.get<{ Querystring: { sid?: string } }>("/api/accounts", async (request, reply) => {
    const owner = currentOwner(request.raw);
    const user = currentUser(request.raw);
    if (!owner || !user) return reply.code(401).send({ error: "请重新登录" });
    const sid = request.query.sid;
    return reply.header("cache-control", "no-store").send({
      accounts: describeAccounts(user),
      default: userStore.defaultProfile(user.id),
      current: sid && clientSessions.owns(owner, sid) ? clientSessions.profileOf(sid) : null,
    });
  });
  app.post<{ Body: { name?: unknown } }>(
    "/api/accounts",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      const user = currentUser(request.raw);
      if (!owner || !user) return reply.code(401).send({ error: "请重新登录" });
      try {
        return await accountLifecycle.run(async () => {
          requireLiveOwner(request.raw, owner);
          if (userStore.listOwnedProfiles(user.id).length >= MAX_PROFILES)
            throw new ClientSessionError(
              409,
              "PROFILE_LIMIT",
              `每个用户最多 ${MAX_PROFILES} 个浏览器配置`,
            );
          const created = await accountStore.create(request.body?.name);
          try {
            userStore.assignProfile(created.id, user.id);
          } catch (error) {
            await accountStore.remove(created.id);
            throw error;
          }
          return created;
        });
      } catch (error) {
        return clientError(reply, error, owner);
      }
    },
  );
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/api/accounts/:id",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      if (!owner) return reply.code(401).send({ error: "请重新输入访问密码" });
      try {
        return await accountLifecycle.run(async () => {
          const user = requireLiveOwner(request.raw, owner);
          if (userStore.profileOwner(request.params.id) !== user.id)
            throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
          return accountStore.rename(request.params.id, request.body?.name);
        });
      } catch (error) {
        return clientError(reply, error, owner);
      }
    },
  );
  app.post<{ Params: { id: string } }>("/api/accounts/:id/default", async (request, reply) => {
    const owner = currentOwner(request.raw);
    if (!owner) return reply.code(401).send({ error: "请重新登录" });
    try {
      return await accountLifecycle.run(() => {
        const user = requireLiveOwner(request.raw, owner);
        userStore.setDefaultProfile(user.id, request.params.id);
        return { account: request.params.id };
      });
    } catch (error) {
      return clientError(reply, error, owner);
    }
  });
  app.patch<{ Params: { id: string }; Body: { proxyId: string | null } }>(
    "/api/accounts/:id/proxy",
    {
      schema: {
        body: {
          type: "object",
          required: ["proxyId"],
          additionalProperties: false,
          properties: {
            proxyId: {
              anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 128 }],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      if (!owner) return reply.code(401).send({ error: "请重新登录" });
      try {
        return await accountLifecycle.run(async () => {
          const user = requireLiveOwner(request.raw, owner);
          const id = request.params.id;
          if (userStore.profileOwner(id) !== user.id)
            throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
          const proxyId = request.body.proxyId;
          if (proxyId !== null) {
            if (!process.env.MIRROR_RUNTIME_SOCKET)
              throw new ClientSessionError(
                503,
                "PROXY_RUNTIME_DISABLED",
                "请在部署中启用独立出口运行时",
              );
            proxyCatalog.getNodeConfig(user, proxyId);
          }
          if ((accountStore.get(id)!.proxyId ?? null) !== proxyId) {
            await resetProfileNetwork(id);
            await accountStore.setProxy(id, proxyId);
          }
          return { proxyId };
        });
      } catch (error) {
        if (error instanceof ProxyCatalogError)
          return reply.code(error.statusCode).send({ error: error.message });
        return clientError(reply, error, owner);
      }
    },
  );
  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    const owner = currentOwner(request.raw);
    if (!owner) return reply.code(401).send({ error: "请重新输入访问密码" });
    const id = request.params.id;
    try {
      return await accountLifecycle.run(async () => {
        const user = requireLiveOwner(request.raw, owner);
        if (userStore.profileOwner(id) !== user.id)
          throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
        if (!accountStore.has(id))
          throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
        if (userStore.listOwnedProfiles(user.id).length === 1)
          throw new ClientSessionError(409, "PROFILE_LAST", "需要保留至少一个浏览器配置");
        if (id === userStore.defaultProfile(user.id))
          throw new ClientSessionError(409, "PROFILE_DEFAULT", "默认账号不能删除");
        const using = clientSessions
          .all()
          .filter((record) => (record.profile ?? DEFAULT_PROFILE) === id);
        if (using.some((record) => record.owner !== owner))
          throw new ClientSessionError(
            409,
            "PROFILE_IN_USE",
            "别的设备正在用这个账号，请先在那边切换或结束",
          );
        const fallback = userStore.defaultProfile(user.id)!;
        for (const record of using) await switchAccountLocked(owner, record.sid, fallback);
        const account = accounts.get(id) ?? (await openingAccounts.get(id)?.catch(() => undefined));
        if (account) await closeAccount(account);
        await accountStore.remove(id);
        userStore.unassignProfile(id);
        if (id === DEFAULT_PROFILE) {
          // The legacy Chrome shares its parent with users.sqlite and the service indexes.
          for (const entry of ["Default", "Local State"])
            await rm(join(profile, entry), { recursive: true, force: true });
        } else await rm(accountDir(id), { recursive: true, force: true });
        return reply.code(204).send();
      });
    } catch (error) {
      return clientError(reply, error, owner);
    }
  });
  app.post<{ Params: { sid: string }; Body: { account?: unknown } }>(
    "/api/client/session/:sid/account",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      if (!owner) return reply.code(403).send({ error: "这个会话不属于当前客户端" });
      const id = request.body?.account;
      try {
        if (typeof id !== "string")
          throw new ClientSessionError(404, "PROFILE_UNKNOWN", "没有这个账号");
        await switchAccount(request.raw, owner, request.params.sid, id);
        return { account: clientSessions.profileOf(request.params.sid) };
      } catch (error) {
        return clientError(reply, error, owner);
      }
    },
  );
  app.delete<{ Params: { sid: string } }>("/api/client/session/:sid", async (request, reply) => {
    const owner = currentOwner(request.raw);
    if (!owner) return reply.code(403).send({ error: "这个会话不属于当前客户端" });
    try {
      await accountLifecycle.run(() => {
        requireLiveOwner(request.raw, owner);
        return releaseClientLocked(owner, request.params.sid);
      });
      return reply.code(204).send();
    } catch (error) {
      return clientError(reply, error, owner);
    }
  });
  app.get<{ Params: { sid: string } }>(
    "/s/:sid/theme",
    { preHandler: requireSession() },
    async (request) => ({
      theme:
        (await runtimes
          .get(request.params.sid)
          ?.theme.read()
          .catch(() => null)) ?? null,
    }),
  );
  app.post<{ Params: { sid: string }; Body: { theme?: unknown; systemDark?: unknown } }>(
    "/s/:sid/theme",
    { preHandler: requireSession(), bodyLimit: 1024 },
    async (request, reply) => {
      const { theme, systemDark } = request.body ?? {};
      if (!isClaudeTheme(theme)) return reply.code(400).send({ error: "未知的外观" });
      const applied =
        (await runtimes.get(request.params.sid)?.theme.set(theme, systemDark === true)) ?? false;
      return { applied };
    },
  );
  const requireAdmin = (request: IncomingMessage) => {
    if (stopping) throw new UserStoreError(503, "SERVICE_STOPPING", "服务正在重启");
    const user = currentUser(request);
    if (!user) throw new UserStoreError(401, "LOGIN_REQUIRED", "请重新登录");
    if (user.role !== "admin") throw new UserStoreError(403, "ADMIN_REQUIRED", "需要管理员权限");
    return user;
  };
  /** Revocation must finish cleaning every Chrome even if one renderer refuses to close. */
  async function closeUserWorkspacesLocked(userId: string, profiles: string[]) {
    const failures: unknown[] = [];
    for (const record of clientSessions.all()) {
      if (userIdForOwner(record.owner) !== userId) continue;
      closing.add(record.sid);
      try {
        await stopRuntime(record.sid);
      } catch (error) {
        report("revoked workspace cleanup failed", error);
      } finally {
        runtimes.delete(record.sid);
        runtimePromises.delete(record.sid);
        try {
          await clientSessions.release(record.owner, record.sid);
        } catch (error) {
          failures.push(error);
        }
        closing.delete(record.sid);
      }
    }
    for (const id of profiles) {
      const account = accounts.get(id);
      if (account) await closeAccount(account);
    }
    broadcastStatus();
    if (failures.length) throw new AggregateError(failures, "Could not persist revoked workspaces");
  }
  app.get("/api/me", async (request, reply) => {
    const user = currentUser(request.raw);
    return user
      ? reply.header("cache-control", "no-store").send({ user })
      : reply.code(401).send({ error: "请重新登录" });
  });
  app.get("/api/users", async (request, reply) => {
    try {
      requireAdmin(request.raw);
      return reply.header("cache-control", "no-store").send({ users: userStore.listUsers() });
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.post<{ Body: { username?: unknown; password?: unknown; role?: unknown } }>(
    "/api/users",
    { bodyLimit: 4096 },
    async (request, reply) => {
      try {
        return await accountLifecycle.run(async () => {
          requireAdmin(request.raw);
          const user = await userStore.createUser({
            username: request.body?.username,
            password: request.body?.password,
            role: request.body?.role,
          });
          try {
            await defaultProfileFor(user);
          } catch (error) {
            userStore.deleteUser(user.id);
            throw error;
          }
          return reply.code(201).send(user);
        });
      } catch (error) {
        return clientError(reply, error);
      }
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { username?: unknown; password?: unknown; role?: unknown; enabled?: unknown };
  }>("/api/users/:id", { bodyLimit: 4096 }, async (request, reply) => {
    try {
      return await accountLifecycle.run(async () => {
        requireAdmin(request.raw);
        const previous = userStore.getUser(request.params.id);
        const user = await userStore.updateUser(request.params.id, request.body ?? {});
        if (
          request.body?.password !== undefined ||
          previous?.role !== user.role ||
          previous?.enabled !== user.enabled
        ) {
          for (const connection of viewers.values())
            if (connection.userId === user.id) ws.closeSession(connection.sid);
        }
        if (!user.enabled)
          await closeUserWorkspacesLocked(user.id, userStore.listOwnedProfiles(user.id));
        return user;
      });
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    try {
      return await accountLifecycle.run(async () => {
        const admin = requireAdmin(request.raw);
        if (admin.id === request.params.id)
          throw new UserStoreError(409, "USER_SELF_DELETE", "请使用另一个管理员账户删除此用户");
        const profiles = userStore.listOwnedProfiles(request.params.id);
        userStore.deleteUser(request.params.id);
        await closeUserWorkspacesLocked(request.params.id, profiles);
        // Chrome directories are retained for deliberate administrator recovery; no user can claim them.
        return reply.code(204).send();
      });
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.get("/healthz", async (_request, reply) => {
    const alive = [...accounts.values()].every((account) => account.browser.isAlive?.() !== false),
      pages = [...runtimes.values()].flatMap((runtime) =>
        runtime.recovery.status().map(({ state }) => state),
      );
    const ok = alive && pages.length === 0;
    return reply.code(ok ? 200 : 503).send({
      ok,
      browser: alive,
      pages,
      clients: runtimes.size,
      maxClients: clientSessions.capacity(),
    });
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
  let healthPending = false;
  const healthTimer = setInterval(() => {
    if (stopping || healthPending) return;
    healthPending = true;
    void accountLifecycle
      .run(async () => {
        if (stopping) return;
        for (const account of [...accounts.values()]) {
          if (account.browser.isAlive?.() !== false) continue;
          // Wait for old cleanup before another operation can reuse a SID or profile.
          console.error(`Chrome for account ${account.id} died; closing its sessions`);
          for (const runtime of [...runtimes.values()]) {
            if (runtime.account !== account) continue;
            closing.add(runtime.sid);
            try {
              await stopRuntime(runtime.sid);
            } catch (error) {
              report("crashed workspace cleanup", error);
            } finally {
              runtimes.delete(runtime.sid);
              runtimePromises.delete(runtime.sid);
              closing.delete(runtime.sid);
            }
          }
          await closeAccount(account);
        }
      })
      .catch((error) => report("browser health recovery", error))
      .finally(() => {
        healthPending = false;
      });
  }, 2000);
  healthTimer.unref?.();
  const statusTimer = setInterval(() => {
    for (const connection of viewers.values())
      if (!connection.authorized()) ws.closeSession(connection.sid);
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
        void runtime.account.browser
          .send(session, "Memory.simulatePressureNotification", { level: "critical" })
          .catch((error) => report("page memory release failed", error));
      }
  };
  const closeUnusedAccounts = () =>
    accountLifecycle.run(async () => {
      if (stopping) return;
      const now = Date.now();
      for (const account of [...accounts.values()]) {
        if (accountInUse(account.id)) {
          account.unusedSince = null;
          continue;
        }
        account.unusedSince ??= now;
        if (now - account.unusedSince >= ACCOUNT_IDLE_CLOSE_MS)
          await closeAccount(account).catch((error) => report("account close failed", error));
      }
    });
  const idleTimer = setInterval(
    () => {
      void idleReaper.sweep();
      releaseIdlePageMemory();
      if (pageSleepMs > 0)
        void pageSleep.sweep([...runtimes.keys()]).catch((error) => report("page sleep", error));
      void closeUnusedAccounts().catch((error) => report("account cleanup failed", error));
    },
    e2e ? 200 : 3000,
  );
  idleTimer.unref?.();
  let stopPromise: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(healthTimer);
    clearInterval(statusTimer);
    clearInterval(idleTimer);
    idleReaper.dispose();
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    stopPromise = (async () => {
      await ws.close().catch(() => {});
      await assetFetcher.close().catch((error) => report("asset shutdown failed", error));
      await app.close().catch(() => {});
      await accountLifecycle.run(async () => {
        for (const runtime of runtimes.values()) {
          await runtime.stop().catch((error) => report("client shutdown failed", error));
        }
        runtimes.clear();
        runtimePromises.clear();
        for (const account of [...accounts.values()]) await closeAccount(account);
        userStore.close();
        cpaStore?.close();
        if (managedProfile) {
          await rm(profile, { recursive: true, force: true });
          if (!process.env.MIRROR_ACCOUNTS_DIR)
            await rm(accountsDir, { recursive: true, force: true });
        }
      });
    })();
    return stopPromise;
  };
  if (options.signals !== false)
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => void stop().finally(() => process.exit(0));
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  const port = Number(process.env.GATEWAY_PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid GATEWAY_PORT");
  try {
    if (options.listen !== false) {
      await app.listen({ host: gatewayHost(), port });
      console.log(`multi-client gateway listening at http://${gatewayHost()}:${port}`);
    } else await app.ready();
    return { app, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
function isInput(message: Up): message is InputMsg {
  return ["ptr", "key", "text", "value", "ime", "scroll"].includes(message.t);
}
