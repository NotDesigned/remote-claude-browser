/**
 * Independent workspaces over one Chrome per account. Sessions on one account share its login
 * profile. Profiles separate site storage; shared infrastructure is not an unlinkability guarantee.
 */
import {
  encodeMsg,
  LOCAL_RESYNC_REASON,
  type Down,
  type Up,
  type ServerStatusMsg,
} from "@mirror/protocol";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createUserGate } from "./auth/user-gate";
import {
  createUserStore,
  USER_SESSION_TTL_MS,
  UserStoreError,
  type FrontendUser,
} from "./auth/users";
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
import { separateDefaultProfile } from "./browser/profile-directory";
import { createProxyCatalog, ProxyCatalogError } from "./egress/catalog";
import { registerProxyRoutes } from "./egress/routes";
import { createRuntimeClient } from "./egress/runtime-client";
import type { ExitMetadata } from "./egress/timezone";
import { CpaError, createCpaStore } from "./cpa/store";
import { createCpaRuntime } from "./cpa/runtime";
import { registerCpaManagementRoutes } from "./cpa/management";
import { createCpaBrokerDriver } from "./cpa/broker-client";
import { registerCpaRoutes, registerCpaInferenceRoutes } from "./cpa/routes";
import { createRemoteCcStore, RemoteCcError } from "./remote-cc/store";
import {
  accountChangeRevokesRemoteCc,
  registerRemoteCcRoutes,
  REMOTE_CC_TOKEN_PATH,
} from "./remote-cc/routes";
import { createAccountDisplay, type AccountDisplay } from "./browser/display";
import { createClaudeLoginTracker, profileSignedIn } from "./claude/signed-in";
import {
  BROWSER_PLATFORMS,
  identityEnvironment,
  type BrowserIdentity,
  type BrowserPlatform,
} from "./browser/identity";
import { configuredBrowserEngine, profileBrowserOptions } from "./browser/engine";
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
import { grabEncoderForDisplay, jpegGrabForDisplay } from "./px-video";
import { ANY_SESSION_TAB } from "./assets/token";
import { createRtcSignalRelay } from "./rtcsig";
import { createClaudeTheme, createThemeCopies, isClaudeTheme } from "./claude/theme";
import { registerSecurityHeaders } from "./security-headers";
import { gatewayHost, registerViewerStatic, trustedProxies, viewerBuildId } from "./serving";
import { createTabLifecycle } from "./session/tabs";
import {
  isClientSlot,
  ClientSessionError,
  createClientSessions,
  type ClientRecord,
} from "./session/clients";
import { createLifecycleLock } from "./session/lifecycle-lock";
import { registerAccountRoutes } from "./auth/account-routes";
import { createOidc, oidcSettingsFromEnv } from "./auth/oidc";
import { createMailboxService, registerMailboxRoutes, RESEND_WEBHOOK_PATH } from "./mail/mailboxes";
import { createIdleReaper, PAGE_GENERATING_EXPRESSION } from "./session/idle-reaper";
import { ACCOUNT_IDLE_CLOSE_MS, sessionIdleGraceMs } from "./session/resource-policy";
import { createProfileStore, DEFAULT_PROFILE, MAX_PROFILES } from "./session/profiles";
import { createResourceSampler } from "./monitor/resources";
import type { TargetRef, AgentLink } from "./types";
import { createRoleManager } from "./ws/roles";
import { createWsServer } from "./ws/server";
import type { ViewerConn } from "./ws/viewerconn";

/** One account: its Chrome, and what the gateway keeps for that Chrome. */
interface Account extends ExitMetadata {
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
/** An account's Chrome nobody has used for this long is closed. It starts again when needed. */
const SESSION_SLEEP_LIMIT_MS = 24 * 60 * 60 * 1000;
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
  const defaultBrowserDirectory = await separateDefaultProfile(profile);
  const browserEngine = configuredBrowserEngine(process.env.MIRROR_BROWSER_ENGINE);
  const platforms: readonly BrowserPlatform[] =
    browserEngine === "aliasmode" && process.env.MIRROR_RUNTIME_SOCKET
      ? BROWSER_PLATFORMS
      : ["windows"];
  const defaultPlatform = platforms[0]!;
  const requirePlatform = (value: unknown): BrowserPlatform => {
    if (!platforms.includes(value as BrowserPlatform))
      throw new ClientSessionError(400, "PROFILE_PLATFORM", "请选择可用的系统身份");
    return value as BrowserPlatform;
  };
  const accountStore = await createProfileStore({
    file: join(profile, "accounts.json"),
    maxProfiles: Infinity,
    legacyIdentitySecret: process.env.MIRROR_AUTH_SECRET ?? "",
    browserEngine,
    fingerprintPlatform: defaultPlatform,
  });
  const profileSystem = (id: string) => {
    const fingerprint = accountStore.identity(id).fingerprint;
    return {
      platform: fingerprint?.platform ?? "windows",
      browserEngine: fingerprint?.engine ?? "chromium",
    };
  };
  const usersDb = process.env.MIRROR_USERS_DB ?? join(profile, "users.sqlite");
  const userStore = await createUserStore({
    file: usersDb,
    bootstrapUsername: process.env.MIRROR_ADMIN_USERNAME ?? "admin",
    bootstrapPassword: process.env.MIRROR_ACCESS_PASSWORD ?? (e2e ? "e2e-test-only" : undefined),
  });
  const mailbox = await createMailboxService({
    file: usersDb === ":memory:" ? usersDb : join(dirname(usersDb), "mailboxes.sqlite"),
    apiKey: process.env.RESEND_API_KEY,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    domain: process.env.RESEND_RECEIVING_DOMAIN,
    verificationFrom: process.env.RESEND_VERIFICATION_FROM,
  });
  userStore.claimLegacyProfiles(
    accountStore.all().map((record) => record.id),
    userStore.bootstrapAdmin.id,
  );
  const accountLifecycle = createLifecycleLock();
  const networkRuntime = createRuntimeClient({ socketPath: process.env.MIRROR_RUNTIME_SOCKET });
  const scopedExits = new Map<string, Set<string>>();
  const egressScope = (userId: string, nodeId: string) =>
    `scope-${createHash("sha256").update(`${userId}/${nodeId}`).digest("hex").slice(0, 32)}`;
  const resetProfileRuntime = async (id: string) => {
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
    await accountLifecycle.run(async () => {
      for (const record of accountStore.all())
        if (record.proxyId && ids.includes(record.proxyId)) {
          await resetProfileRuntime(record.id);
          await accountStore.setTimeZone(record.id, undefined);
        }
      for (const id of ids) {
        if (process.env.MIRROR_RUNTIME_SOCKET)
          for (const scope of scopedExits.get(id) ?? []) await networkRuntime.stopEgress(scope);
        scopedExits.delete(id);
      }
    });
  };
  const proxyCatalog = await createProxyCatalog({
    file: join(profile, "proxy-sources.json"),
    usernameFor: (id) => userStore.getUser(id)?.username,
    usageForNodes: (ids) => ({
      profiles: accountStore
        .all()
        .filter((record) => record.proxyId && ids.includes(record.proxyId)).length,
      credentials: cpaStore?.countCredentialBindings(ids) ?? 0,
    }),
    endpointForNode: async (id, node, user) => {
      if (!process.env.MIRROR_RUNTIME_SOCKET)
        throw new ProxyCatalogError(503, "PROXY_RUNTIME_DISABLED", "请在部署中启用独立出口运行时");
      const scope = egressScope(user.id, id);
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
  const checkProxy = async (user: FrontendUser, id: string) => {
    const node = proxyCatalog.getNodeConfig(user, id);
    const probeId = `probe-${randomBytes(16).toString("hex")}`;
    try {
      try {
        await networkRuntime.startEgress(probeId, node);
        return await networkRuntime.checkEgress(probeId);
      } finally {
        await networkRuntime.stopEgress(probeId);
      }
    } catch {
      return {
        status: "error" as const,
        checkedAt: Date.now(),
        error: "出口检测失败，请检查节点后重试",
      };
    }
  };
  const cpaStore = process.env.CPA_BROKER_SOCKET
    ? await createCpaStore({
        file: join(profile, "cpa.sqlite"),
        legacySharedKeyOwnerId: userStore.bootstrapAdmin.id,
      })
    : undefined;
  const cpaRuntime = cpaStore
    ? createCpaRuntime({
        store: cpaStore,
        driver: createCpaBrokerDriver(process.env.CPA_BROKER_SOCKET!),
        resolveProxyForUser: async (user, proxyId, instance) => {
          if (instance.scope === "shared") user = userStore.bootstrapAdmin;
          if (!proxyId) throw new CpaError(409, "CPA_PROXY_REQUIRED", "请为授权选择出口节点");
          const proxy = await proxyCatalog.resolveProxyForUser(user, proxyId);
          const scope = egressScope(user.id, proxyId);
          const metadata = await networkRuntime.timeZoneForEgress(scope);
          return {
            ...proxy,
            timeZone: metadata.timeZone,
            health: await networkRuntime.egressStatus(scope),
          };
        },
        checkProxyForUser: async (user, proxyId, instance) => {
          if (instance.scope === "shared") user = userStore.bootstrapAdmin;
          const proxy = await proxyCatalog.resolveProxyForUser(user, proxyId);
          const health = await networkRuntime.checkEgress(egressScope(user.id, proxyId));
          if (health.status !== "healthy" || !health.timeZone)
            throw new CpaError(
              503,
              "CPA_EXIT_UNAVAILABLE",
              health.error ?? "出口检测失败，请检查节点后重试",
            );
          return { ...proxy, timeZone: health.timeZone, health };
        },
        proxyStatusForInstance: async (instance, proxyId) => {
          const ownerId = instance.ownerId ?? userStore.bootstrapAdmin.id;
          return networkRuntime.egressStatus(egressScope(ownerId, proxyId));
        },
        userEnabled: (id) => userStore.getUser(id)?.enabled === true,
        userName: (id) => userStore.getUser(id)?.username,
      })
    : undefined;
  if (cpaRuntime) {
    const restored = await cpaRuntime.restore((instance) =>
      instance.ownerId ? userStore.getUser(instance.ownerId) : userStore.bootstrapAdmin,
    );
    if (restored.failures.length)
      console.error("Some CPA exits could not be restored:", restored.failures);
  }
  const remoteCcStore = await createRemoteCcStore({ file: join(profile, "remote-cc.sqlite") });
  const app = Fastify({ logger: false, trustProxy: trustedProxies() });
  registerSecurityHeaders(app);
  const key = process.env.MIRROR_AUTH_SECRET
    ? Buffer.from(process.env.MIRROR_AUTH_SECRET)
    : randomBytes(32);
  const sessionGuard = createSessionGuard({ key });
  let e2eIdleOffset = 0;
  const sessionNow = () => Date.now() + e2eIdleOffset;
  const clientSessions = await createClientSessions({
    file: join(profile, "client-sessions.json"),
    now: sessionNow,
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
    const maxAge = USER_SESSION_TTL_MS / 1000;
    const exp = Math.floor(Date.now() / 1000) + maxAge;
    return `${SESSION_COOKIE}=${mintInvite({ sid: owner, role: "driver", exp }, key)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  };
  const oidcSettings = oidcSettingsFromEnv(process.env, process.env.MIRROR_PUBLIC_ORIGIN);
  const oidc = oidcSettings && createOidc(oidcSettings, { store: userStore });
  const gate = createUserGate({
    store: userStore,
    publicOrigin: process.env.MIRROR_PUBLIC_ORIGIN,
    oidc,
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
    // Bearer-token API for remote-cc; the routes authenticate every request themselves.
    if (request.url.startsWith(REMOTE_CC_TOKEN_PATH)) return;
    if (
      mailbox.enabled &&
      request.method === "POST" &&
      request.routeOptions.url === RESEND_WEBHOOK_PATH
    )
      return;
    await gate.preHandler.call(app, request, reply);
    if (reply.sent) return;
    // Upgrade old single-workspace cookies to a stable authenticated device identity.
    if (gate.hasValidDevice(request.raw) && !currentOwner(request.raw))
      reply.header("set-cookie", deviceCookie(request.raw));
  });
  gate.registerRoutes(app);
  const currentUserId = (request: IncomingMessage) => currentUser(request)?.id;
  registerMailboxRoutes(app, mailbox, currentUserId);
  registerProxyRoutes(app, {
    catalog: proxyCatalog,
    currentUser: (request) => currentUser(request) ?? null,
    checkProxy,
  });
  if (cpaRuntime) {
    registerCpaRoutes(app, { runtime: cpaRuntime, currentUser });
    registerCpaManagementRoutes(app, { runtime: cpaRuntime, currentUser });
    registerCpaInferenceRoutes(app, cpaRuntime);
  }
  /** The profile's live browsers, by session. */
  const profileRuntimes = (profileId: string) =>
    [...runtimes].filter(([sid, runtime]) => runtime.account.id === profileId && !closing.has(sid));
  const remoteCc = registerRemoteCcRoutes(app, {
    store: remoteCcStore,
    secret: createHmac("sha256", key).update("remote-cc").digest(),
    // Users who only sign in through OIDC keep remote-cc only while they keep signing in there.
    userActive: (user) => !oidc || oidc.recentlySignedIn(user.id),
    publicOrigin: (request) =>
      process.env.MIRROR_PUBLIC_ORIGIN?.replace(/\/+$/, "") ||
      `${request.headers["x-forwarded-proto"] === "http" ? "http" : "https"}://${request.headers.host}`,
    checkExit: (user, nodeId) => checkProxy(user, nodeId),
    saveExit: (profileId, metadata) => accountStore.setExitMetadata(profileId, metadata),
    browser: {
      // Prefer a session someone is viewing, so the user sees the sign-in tab.
      async open(profileId, url) {
        const live = profileRuntimes(profileId);
        const online = onlineSessions();
        const [sid, runtime] = live.find(([sid]) => online.has(sid)) ?? live[0] ?? [];
        if (!sid || !runtime) return undefined;
        await runtime.tabs.handle({
          t: "nav",
          tab: runtime.tabs.activeTabId ?? "",
          action: "newtab",
          url,
        });
        return sid;
      },
      // The user may finish the sign-in in any of the profile's sessions.
      pageUrls(profileId) {
        return profileRuntimes(profileId).flatMap(([, runtime]) =>
          [...runtime.targets.values()]
            .filter((target) => target.type === "page")
            .map((target) => runtime.metadata.get(target.targetId)?.url)
            .filter((url): url is string => typeof url === "string"),
        );
      },
      // Callback pages strip the code from their address but show it as text.
      async pageTexts(profileId, origin) {
        const texts: string[] = [];
        for (const [, runtime] of profileRuntimes(profileId))
          for (const target of runtime.targets.values()) {
            const url = runtime.metadata.get(target.targetId)?.url;
            if (target.type !== "page" || !url || !url.startsWith(origin + "/")) continue;
            const response = (await Promise.race([
              runtime.browser.send(target.sessionId, "Runtime.evaluate", {
                expression: "document.body ? document.body.innerText : ''",
                returnByValue: true,
              }),
              new Promise<never>((_resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("page text timed out")), 1500);
                timeout.unref?.();
              }),
            ]).catch(() => undefined)) as { result?: { value?: unknown } } | undefined;
            const value = response?.result?.value;
            if (typeof value === "string") texts.push(value.slice(0, 20_000));
          }
        return texts;
      },
      isLive: (sid) => runtimes.has(sid) && !closing.has(sid),
    },
    currentUser,
    getUser: (id) => userStore.getUser(id),
    profilesFor: (user) =>
      userStore
        .listOwnedProfiles(user.id)
        .map((id) => accountStore.get(id))
        .filter((record) => record !== undefined),
    nodesFor: (user) =>
      proxyCatalog.listNodes(user).map((node) => ({
        id: node.id,
        name: node.name,
        proxy: proxyCatalog.getNodeConfig(user, node.id),
      })),
  });
  await registerViewerStatic(app);
  const requireSession = (sid?: string) => async (request: FastifyRequest, reply: FastifyReply) => {
    const requested = sid ?? (request.params as { sid?: string })?.sid;
    if (!requested || closing.has(requested) || !ownsSession(request.raw, requested))
      await reply.code(403).send({ error: "这个独立会话不属于当前客户端" });
  };
  const runtimePromises = new Map<string, Promise<ClientRuntime>>();
  const runtimes = new Map<string, ClientRuntime>();
  const closing = new Set<string>();
  const sleepingWindows = new Map<
    string,
    { token: unknown; profile: string; urls: string[]; active: number }
  >();
  const viewerIds = new WeakMap<ViewerConn, string>();
  const viewers = new Map<
    string,
    {
      viewer: ViewerConn;
      sid: string;
      owner: string;
      userId: string;
      authorized(): boolean;
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
    // Read for each connection: deploy-viewer.sh publishes a viewer without restarting this.
    build: () => viewerBuildId(),
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
    onConnection(viewer, request, sid, resumable) {
      if (!sid) return [];
      const id = `viewer-${nextViewer++}`;
      viewerIds.set(viewer, id);
      viewers.set(id, {
        viewer,
        sid,
        owner: currentOwner(request)!,
        userId: currentUser(request)!.id,
        authorized: () => ownsSession(request, sid),
      });
      idleReaper.touch(sid);
      const runtime = runtimes.get(sid)!;
      // A reconnect whose replay position is still buffered keeps its geometry agreement: the
      // epoch did not change, so this viewer identity inherits the acknowledgement directly. One
      // that cannot inherit it is not resumed at all: its join payload then carries a snapshot,
      // as its `hello` says, rather than deltas the viewer would wait in vain to see completed.
      const accepted = resumable.filter((cursor) =>
        runtime.viewport.gate.inheritAgreement(id, cursor.tab),
      );
      const resumed = accepted.map((cursor) => cursor.tab);
      roles.connect({
        sessionId: sid,
        inviteRole: "driver",
        viewerId: id,
        send: (message, serialized) => viewer.send(message, serialized),
        viewportLimit: clientSessions.get(sid)?.phone ? undefined : runtime.account.identity.screen,
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
      // After `hello`, which resets the viewer's idea of every tab's field sync.
      for (const message of runtime.input.valueStatusMessages())
        viewer.send(message, encodeMsg(message));
      const capacity = { t: "px-capacity", available: pixelCapacity.available() } as const;
      viewer.send(capacity, encodeMsg(capacity));
      const currentStatus = status(sid);
      viewer.send(currentStatus, encodeMsg(currentStatus));
      broadcastStatus();
      void runtime.tabs
        .tabsMessage()
        .then((message) => viewer.send(message, encodeMsg(message)))
        .catch((error) => report("client tabs unavailable", error));
      return accepted;
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
  function status(sid?: string): ServerStatusMsg {
    lastStatusAt = Math.max(Date.now(), lastStatusAt + 1);
    const stale = Date.now() - resources.sampledAt > 10000;
    const exit = sid
      ? (runtimes.get(sid)?.account ?? accountStore.get(clientSessions.profileOf(sid)))
      : undefined;
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
      pixelsActive: pixelCapacity.count(),
      pixelsMax: null,
      ...(exit
        ? { timeZone: exit.timeZone, exitCity: exit.exitCity, exitCountry: exit.exitCountry }
        : {}),
    };
  }
  function broadcastStatus() {
    if (stopping) return;
    for (const sid of runtimes.keys()) publish(sid, status(sid));
  }
  /** Whether a page is writing a reply, which closing or reloading it would cut short. */
  async function pageGenerating(runtime: ClientRuntime, target: TargetRef): Promise<boolean> {
    const response = (await Promise.race([
      runtime.browser.send(target.sessionId, "Runtime.evaluate", {
        expression: PAGE_GENERATING_EXPRESSION,
        returnByValue: true,
      }),
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Idle page inspection timed out")), 1500);
        timeout.unref?.();
      }),
    ])) as { result?: { value?: unknown } };
    return response.result?.value === true;
  }
  const idleReaper = createIdleReaper({
    sessions: () =>
      clientSessions
        .all()
        .filter((record) => runtimePromises.has(record.sid))
        .map((record) => ({
          sid: record.sid,
          token: record,
        })),
    isOnline: (sid) => onlineSessions().has(sid),
    isBusy: async (sid) => {
      const runtime = runtimes.get(sid);
      if (!runtime) return false;
      for (const target of runtime.targets.values()) {
        if (target.type !== "page") continue;
        const user = userStore.getUser(userStore.profileOwner(runtime.account.id)!);
        const address = runtime.metadata.get(target.targetId)?.url;
        if (
          user &&
          address &&
          cpaRuntime?.browserAuthorizing(
            user,
            accountStore.get(runtime.account.id)?.proxyId,
            address,
          )
        )
          return true;
        if (runtime.recovery.isBlocked(target.targetId)) continue;
        if (await pageGenerating(runtime, target)) return true;
      }
      return false;
    },
    release: (sid, token) =>
      accountLifecycle.run(async () => {
        const current = clientSessions.get(sid);
        if (!current || current !== token || onlineSessions().has(sid)) return;
        closing.add(sid);
        try {
          const runtime = runtimes.get(sid);
          const tabs = runtime && runtime.tabs.size > 0 ? await runtime.tabs.tabsMessage() : null;
          // An offline viewer can reconnect to this identity after its windows are released.
          await stopRuntime(sid);
          if (tabs)
            sleepingWindows.set(sid, {
              token,
              profile: clientSessions.profileOf(sid),
              urls: tabs.tabs.map((tab) => tab.url),
              active: tabs.tabs.findIndex((tab) => tab.active),
            });
          await clientSessions.setSleeping(current, true);
        } finally {
          runtimes.delete(sid);
          runtimePromises.delete(sid);
          closing.delete(sid);
          broadcastStatus();
        }
      }),
    graceMs: sessionIdleGraceMs(process.env.MIRROR_IDLE_GRACE_MS, e2e),
    now: sessionNow,
    onError: (error) => report("idle client cleanup", error),
  });
  app.get<{ Querystring: { sid?: string } }>("/api/status", async (request, reply) => {
    if (!currentOwner(request.raw)) return reply.code(401).send({ error: "请重新输入访问密码" });
    const sid = request.query.sid;
    if (sid && !ownsSession(request.raw, sid))
      return reply.code(403).send({ error: "这个会话不属于当前客户端" });
    return reply.header("cache-control", "no-store").send(status(sid));
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
    lookup: process.env.MIRROR_RUNTIME_SOCKET
      ? (hostname, ref) =>
          networkRuntime.resolveBrowser(clientSessions.profileOf(ref.sessionId), hostname)
      : undefined,
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
  const accountDir = (id: string) =>
    id === DEFAULT_PROFILE ? defaultBrowserDirectory : join(accountsDir, id);
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
    exit: ExitMetadata,
    display?: AccountDisplay,
  ): Promise<Account> {
    const zoomReady = await installZoomExtension(
      browser,
      join(dir, "zoom-extension"),
      identity.fingerprint?.platform === "windows" ? "/C:/zoom-extension" : undefined,
    ).then(
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
      ...exit,
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
  function requireBrowserExit(id: string): void {
    if (!e2e && !accountStore.get(id)?.proxyId)
      throw new ClientSessionError(409, "EXIT_REQUIRED", "请先为浏览器配置选择出口节点");
  }

  async function openAccount(id: string): Promise<Account> {
    requireBrowserExit(id);
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
        const identity = accountStore.identity(id);
        const display =
          !external && process.env.CHROME_HEADFUL === "1"
            ? await createAccountDisplay()
            : undefined;
        let browser: BrowserHandle | undefined;
        let proxyUrl: string | undefined;
        let exit: ExitMetadata;
        try {
          const proxyId = accountStore.get(id)!.proxyId;
          const engine = profileBrowserOptions(identity);
          const launchOptions = {
            userDataDir: dir,
            engine: engine.engine,
            executablePath: engine.executablePath,
            headful: process.env.CHROME_HEADFUL === "1",
            enableExtensions: true,
            args: [
              ...CHROME_ARGS,
              ...engine.args,
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
            const {
              browser: opened,
              proxyUrl: endpoint,
              ...metadata
            } = await launchBrokerBrowser(id, node, launchOptions);
            browser = opened;
            proxyUrl = endpoint;
            exit = metadata;
          } else {
            // Local replay fixtures explicitly opt into MIRROR_E2E; production requires a node.
            exit = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
            browser = external
              ? await connectRemoteBrowser(process.env.BROWSER_CDP_URL!)
              : await launchBrowser({
                  ...launchOptions,
                  env: { ...launchOptions.env, TZ: exit.timeZone },
                });
          }
          const account = await buildAccount(id, dir, browser, identity, exit, display);
          account.proxyUrl = proxyUrl;
          await accountStore.setExitMetadata(id, exit);
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

  async function createRuntime(record: ClientRecord): Promise<ClientRuntime> {
    const { sid } = record;
    if (!e2e && (await memoryShort()))
      throw new ClientSessionError(
        503,
        "CLIENT_RESOURCES",
        "内存较紧张，请等待离线会话自动回收后重试",
      );
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
    const pixelWindow =
      displayGrabbable && scoped.sendBrowser
        ? createPixelWindow({ sendBrowser: scoped.sendBrowser, display: account.display?.env })
        : undefined;
    const input = createInputRelay({
      onValueStatus: (tab, failed, reason) =>
        publish(sid, { t: "input-status", tab, failed, ...(reason ? { reason } : {}) }),
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
      nativePointer: async (message, { x, y }) => {
        const zoom = tabs.hubFor(message.tab)?.pixelZoom ?? 1;
        return (await pixelWindow?.pointer({ ...message, vx: x * zoom, vy: y * zoom })) ?? false;
      },
      viewportFor: (tab) => viewport.viewportFor(tab),
    });
    scoped.onSessionEvent("Page.frameNavigated", (sessionId, event) => {
      if (event.frame.parentId !== undefined) return;
      const page = [...targets.values()].find(
        (target) => target.type === "page" && target.sessionId === sessionId,
      );
      if (page) input.resetTab(page.targetId);
    });
    const navigation = createNavigationController(scoped, (message) => {
      publish(sid, message);
      const user = userStore.getUser(userStore.profileOwner(account.id)!);
      if (user)
        void cpaRuntime
          ?.captureBrowserCallback(user, accountStore.get(account.id)?.proxyId, message.url)
          .then((captured) => {
            if (captured) publish(sid, { t: "cpa-oauth", tab: message.tab, status: "submitted" });
          })
          .catch(() => {
            publish(sid, { t: "cpa-oauth", tab: message.tab, status: "error" });
            console.error("CPA automatic callback failed; manual submission remains available");
          });
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
      publish: (message) => publish(sid, message),
      onCrash(tab) {
        viewport.resetTab(tab);
        input.resetTab(tab);
        publish(sid, { t: "resync", tab });
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
      if (tabs.size === 0) {
        const sleeping = sleepingWindows.get(sid);
        const urls =
          sleeping && sleeping.token === clientSessions.get(sid) && sleeping.profile === account.id
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
      await clientSessions.setSleeping(record, false);
      sleepingWindows.delete(sid);
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
      userStore.profileOwner(clientSessions.profileOf(sid)) !== userId ||
      (await expireSleepingSessionLocked(record))
    )
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前用户");
    let pending = runtimePromises.get(sid);
    if (!pending) {
      pending = createRuntime(record);
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
      const hub = runtime.tabs.hubFor(message.tab);
      const viewer = viewers.get(id)?.viewer;
      // This viewer's typing echo went its own way; the stream itself is fine, so the cached
      // state answers it without making every viewer rebuild from a new page snapshot.
      if (message.reason === LOCAL_RESYNC_REASON && hub !== undefined && viewer !== undefined) {
        viewer.sendCatchUp(hub.joinPayload());
        return;
      }
      hub?.requestSnapshot("resync");
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
          let previous = clientSessions.findExisting(
            owner,
            request.body?.clientKey,
            request.body?.sid,
          );
          if (previous && (await expireSleepingSessionLocked(previous))) previous = undefined;
          const existing = previous !== undefined;
          if (
            !existing &&
            user.maxSessions != null &&
            clientSessions.all().filter((record) => userIdForOwner(record.owner) === user.id)
              .length >= user.maxSessions
          )
            throw new ClientSessionError(
              409,
              "USER_SESSION_LIMIT",
              `已达到会话上限（${user.maxSessions} 个），请先结束不再使用的会话`,
            );
          const profileId =
            previous && userStore.profileOwner(previous.profile ?? DEFAULT_PROFILE) === user.id
              ? (previous.profile ?? DEFAULT_PROFILE)
              : typeof chosen === "string"
                ? chosen
                : await defaultProfileFor(user);
          requireBrowserExit(profileId);
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
              await clientSessions.setProfile(owner, record.sid, profileId);
            }
            idleReaper.touch(record.sid);
            broadcastStatus();
            await ensureRuntimeLocked(record.sid);
            return {
              ...clientSessions.describe(record.sid),
              account: clientSessions.profileOf(record.sid),
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
  async function stopRuntime(sid: string, ended = false): Promise<void> {
    sleepingWindows.delete(sid);
    ws.closeSession(sid, ended ? 4010 : undefined);
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
  async function expireSleepingSessionLocked(record: ClientRecord): Promise<boolean> {
    if (
      record.sleepingSince === undefined ||
      sessionNow() - record.sleepingSince < SESSION_SLEEP_LIMIT_MS
    )
      return false;
    await releaseClientLocked(record.owner, record.sid);
    return true;
  }
  async function releaseClientLocked(owner: string, sid: string) {
    if (!clientSessions.owns(owner, sid))
      throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话已结束");
    if (closing.has(sid)) throw new ClientSessionError(409, "CLIENT_CLOSING", "会话正在结束");
    closing.add(sid);
    try {
      await stopRuntime(sid, true);
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
    requireBrowserExit(id);
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
  const describeAccounts = (user: FrontendUser) => {
    const nodes = new Map(proxyCatalog.listNodes(user).map((node) => [node.id, node]));
    return accountStore
      .all()
      .filter((record) => userStore.profileOwner(record.id) === user.id)
      .map((record) => {
        const account = accounts.get(record.id);
        const node = record.proxyId ? nodes.get(record.proxyId) : undefined;
        const live = account?.login.current();
        const exit = account ?? record;
        const hasCookie = live ? live.signedIn : profileSignedIn(accountDir(record.id));
        const unavailable = live ? !!live.unavailable : hasCookie && !!record.unavailable;
        const signedIn =
          hasCookie && !unavailable && (live ? live.signedIn : record.signedIn !== false);
        const sessions = clientSessions
          .all()
          .filter((session) => (session.profile ?? DEFAULT_PROFILE) === record.id);
        const online = onlineSessions();
        return {
          id: record.id,
          name: record.name,
          ...profileSystem(record.id),
          proxyId: record.proxyId ?? null,
          proxyName: node?.name ?? null,
          proxyVisibility: node?.visibility,
          timeZone: exit.timeZone,
          exitCity: exit.exitCity,
          exitCountry: exit.exitCountry,
          exitIp: exit.exitIp,
          checkedAt: exit.checkedAt,
          running: accounts.has(record.id),
          signedIn,
          unavailable,
          email: signedIn ? (live ? live.email : (record.email ?? null)) : null,
          sessions: sessions.length,
          onlineSessions: sessions.filter((session) => online.has(session.sid)).length,
        };
      });
  };
  app.get<{ Querystring: { sid?: string } }>("/api/accounts", async (request, reply) => {
    const owner = currentOwner(request.raw);
    const user = currentUser(request.raw);
    if (!owner || !user) return reply.code(401).send({ error: "请重新登录" });
    const sid = request.query.sid;
    return reply.header("cache-control", "no-store").send({
      accounts: describeAccounts(user),
      platforms,
      defaultPlatform,
      default: userStore.defaultProfile(user.id),
      current: sid && clientSessions.owns(owner, sid) ? clientSessions.profileOf(sid) : null,
    });
  });
  app.post<{ Body: { name?: unknown; proxyId?: unknown; platform?: unknown } }>(
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
          const platform =
            request.body?.platform === undefined
              ? defaultPlatform
              : requirePlatform(request.body.platform);
          const proxyId = request.body?.proxyId;
          if (proxyId !== undefined) {
            if (typeof proxyId !== "string" || !proxyId)
              throw new ClientSessionError(400, "PROXY_REQUIRED", "请选择出口节点");
            if (!process.env.MIRROR_RUNTIME_SOCKET)
              throw new ClientSessionError(
                503,
                "PROXY_RUNTIME_DISABLED",
                "请在部署中启用独立出口运行时",
              );
            proxyCatalog.getNodeConfig(user, proxyId);
          }
          const created = await accountStore.create(request.body?.name, platform);
          try {
            if (typeof proxyId === "string") await accountStore.setProxy(created.id, proxyId);
            userStore.assignProfile(created.id, user.id);
          } catch (error) {
            await accountStore.remove(created.id);
            throw error;
          }
          return { ...created, ...profileSystem(created.id) };
        });
      } catch (error) {
        if (error instanceof ProxyCatalogError)
          return reply.code(error.statusCode).send({ error: error.message });
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
  app.post<{ Params: { id: string } }>("/api/accounts/:id/exit/check", async (request, reply) => {
    const owner = currentOwner(request.raw);
    if (!owner) return reply.code(401).send({ error: "请重新登录" });
    try {
      const snapshot = await accountLifecycle.run(() => {
        const user = requireLiveOwner(request.raw, owner);
        const id = request.params.id;
        if (userStore.profileOwner(id) !== user.id)
          throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
        const record = accountStore.get(id)!;
        if (!record.proxyId)
          throw new ClientSessionError(409, "PROXY_REQUIRED", "请先为浏览器配置选择出口");
        proxyCatalog.getNodeConfig(user, record.proxyId);
        return { user, id, proxyId: record.proxyId, account: accounts.get(id) };
      });
      const health = snapshot.account
        ? await networkRuntime.checkBrowser(snapshot.id)
        : await checkProxy(snapshot.user, snapshot.proxyId);
      return await accountLifecycle.run(() => {
        requireLiveOwner(request.raw, owner);
        if (
          accountStore.get(snapshot.id)?.proxyId !== snapshot.proxyId ||
          accounts.get(snapshot.id) !== snapshot.account
        )
          throw new ClientSessionError(409, "EXIT_CHANGED", "配置在检测期间已变化，请重新检查");
        return reply.header("cache-control", "no-store").send({
          scope: snapshot.account ? "browser" : "node",
          health,
        });
      });
    } catch (error) {
      if (error instanceof ProxyCatalogError)
        return reply.code(error.statusCode).send({ error: error.message });
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
            await resetProfileRuntime(id);
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
  app.patch<{ Params: { id: string }; Body: { platform?: unknown } }>(
    "/api/accounts/:id/platform",
    { bodyLimit: 1024 },
    async (request, reply) => {
      const owner = currentOwner(request.raw);
      if (!owner) return reply.code(401).send({ error: "请重新登录" });
      try {
        return await accountLifecycle.run(async () => {
          const user = requireLiveOwner(request.raw, owner);
          const id = request.params.id;
          if (userStore.profileOwner(id) !== user.id)
            throw new ClientSessionError(403, "PROFILE_FORBIDDEN", "这个浏览器不属于当前用户");
          const platform = requirePlatform(request.body?.platform);
          if (profileSystem(id).platform !== platform) {
            await resetProfileRuntime(id);
            await accountStore.setPlatform(id, platform);
          }
          return { platform };
        });
      } catch (error) {
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
        await rm(accountDir(id), { recursive: true, force: true });
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
  app.post<{ Params: { sid: string }; Body: { instanceId: string; state: string } }>(
    "/api/client/session/:sid/cpa/oauth",
    {
      preHandler: requireSession(),
      bodyLimit: 4096,
      schema: {
        body: {
          type: "object",
          required: ["instanceId", "state"],
          additionalProperties: false,
          properties: {
            instanceId: { type: "string", minLength: 1 },
            state: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return await accountLifecycle.run(async () => {
          const owner = currentOwner(request.raw);
          if (!owner || !ownsSession(request.raw, request.params.sid))
            throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前客户端");
          const user = requireLiveOwner(request.raw, owner);
          if (!cpaRuntime) throw new CpaError(503, "CPA_DISABLED", "CPA 未启用");
          const oauth = cpaRuntime.oauthPage(user, request.body.instanceId, request.body.state);
          const profileId = clientSessions.profileOf(request.params.sid);
          requireBrowserExit(profileId);
          if (accountStore.get(profileId)?.proxyId !== oauth.proxyId)
            throw new CpaError(
              409,
              "CPA_BROWSER_EXIT",
              "当前浏览器出口与授权节点不同，请选择出口一致的浏览器配置",
            );
          const runtime = await ensureRuntimeLocked(request.params.sid);
          requireLiveOwner(request.raw, owner);
          await runtime.tabs.handle({
            t: "nav",
            tab: runtime.tabs.activeTabId ?? "",
            action: "newtab",
            url: oauth.url,
          });
          return { ok: true };
        });
      } catch (error) {
        if (error instanceof CpaError)
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        return clientError(reply, error);
      }
    },
  );
  app.post<{ Params: { sid: string; id: string } }>(
    "/api/client/session/:sid/remote-cc/logins/:id/open",
    { preHandler: requireSession(), bodyLimit: 1024 },
    async (request, reply) => {
      try {
        return await accountLifecycle.run(async () => {
          const owner = currentOwner(request.raw);
          if (!owner || !ownsSession(request.raw, request.params.sid))
            throw new ClientSessionError(403, "CLIENT_FORBIDDEN", "这个会话不属于当前客户端");
          const user = requireLiveOwner(request.raw, owner);
          const sid = request.params.sid;
          const runtime = await ensureRuntimeLocked(sid);
          requireLiveOwner(request.raw, owner);
          await remoteCc.openLoginIn(
            user.id,
            request.params.id,
            clientSessions.profileOf(sid),
            sid,
            async (login) => {
              await runtime.tabs.handle({
                t: "nav",
                tab: runtime.tabs.activeTabId ?? "",
                action: "newtab",
                url: login.url,
              });
            },
          );
          return { ok: true };
        });
      } catch (error) {
        if (error instanceof RemoteCcError)
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        return clientError(reply, error);
      }
    },
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
    try {
      await cpaRuntime?.suspendUser(userId);
    } catch (error) {
      failures.push(error);
    }
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
    for (const [nodeId, scopes] of scopedExits) {
      const scope = egressScope(userId, nodeId);
      if (!scopes.has(scope)) continue;
      const sharedUsesNode = cpaStore
        ?.runningInstances()
        .some(
          (instance) =>
            instance.scope === "shared" &&
            [
              ...cpaStore.credentialBindings(instance.id),
              ...cpaStore.pendingOAuth(instance.id),
            ].some((binding) => binding.proxyId === nodeId),
        );
      if (sharedUsesNode) continue;
      try {
        await networkRuntime.stopEgress(scope);
        scopes.delete(scope);
        if (!scopes.size) scopedExits.delete(nodeId);
      } catch (error) {
        failures.push(error);
      }
    }
    broadcastStatus();
    if (failures.length) throw new AggregateError(failures, "Could not persist revoked workspaces");
  }
  registerAccountRoutes(app, {
    store: userStore,
    sessions: clientSessions,
    lifecycle: accountLifecycle,
    currentUser,
    currentOwner,
    userIdForOwner,
    profileName: (id) => accountStore.all().find((record) => record.id === id)?.name ?? id,
    onlineSessions,
    stopSession: releaseClientLocked,
    oidc: oidc ? { label: oidc.settings.label, issuer: oidc.settings.issuer } : undefined,
    onPasswordChanged: (userId) => {
      for (const connection of viewers.values())
        if (connection.userId === userId) ws.closeSession(connection.sid);
      // A new password also cuts off every computer and egress host connected as this user.
      remoteCcStore.removeUser(userId);
    },
  });
  app.get("/api/users", async (request, reply) => {
    try {
      requireAdmin(request.raw);
      return reply.header("cache-control", "no-store").send({ users: userStore.listUsers() });
    } catch (error) {
      return clientError(reply, error);
    }
  });
  const mailboxUser = (request: FastifyRequest<{ Params: { id: string } }>) => {
    requireAdmin(request.raw);
    const user = userStore.getUser(request.params.id);
    if (!user) throw new UserStoreError(404, "USER_UNKNOWN", "没有这个用户");
    return user;
  };
  app.get<{ Params: { id: string } }>("/api/users/:id/mailboxes", async (request, reply) => {
    const user = mailboxUser(request);
    return reply.header("cache-control", "no-store").send({
      enabled: mailbox.enabled,
      domain: mailbox.domain,
      domains: mailbox.domains,
      addresses: mailbox.listAddresses(user.id),
    });
  });
  app.post<{ Params: { id: string }; Body: { address?: unknown; label?: unknown } }>(
    "/api/users/:id/mailboxes",
    { bodyLimit: 4096 },
    async (request, reply) => {
      const user = mailboxUser(request);
      if (!user.enabled) throw new UserStoreError(409, "USER_DISABLED", "请先启用这个用户");
      const address = mailbox.assignAddress(user.id, request.body?.address, request.body?.label);
      return reply.code(201).header("cache-control", "no-store").send({ address });
    },
  );
  app.get("/api/admin/overview", async (request, reply) => {
    try {
      requireAdmin(request.raw);
      const online = onlineSessions();
      const users = userStore.listUsers();
      const sessions = clientSessions.all().map((record) => {
        const userId = userIdForOwner(record.owner);
        const profileId = clientSessions.profileOf(record.sid);
        return {
          ...clientSessions.describe(record.sid),
          userId,
          username: users.find((user) => user.id === userId)?.username ?? "已删除用户",
          profileId,
          profileName: accountStore.get(profileId)?.name ?? profileId,
          online: online.has(record.sid),
          running: runtimes.has(record.sid),
          currentDevice: record.owner === currentOwner(request.raw),
          createdAt: record.createdAt,
        };
      });
      return reply.header("cache-control", "no-store").send({
        users: users.map((user) => ({
          ...user,
          profileCount: userStore.listOwnedProfiles(user.id).length,
          sso: userStore.identities(user.id).map((identity) => identity.email ?? "")[0] ?? null,
          sessionCount: sessions.filter((session) => session.userId === user.id).length,
          onlineSessions: sessions.filter((session) => session.userId === user.id && session.online)
            .length,
        })),
        sessions,
        resources: status(),
        runningProfiles: accounts.size,
      });
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.delete<{ Params: { sid: string } }>("/api/admin/sessions/:sid", async (request, reply) => {
    try {
      await accountLifecycle.run(async () => {
        requireAdmin(request.raw);
        const record = clientSessions.get(request.params.sid);
        if (!record) throw new ClientSessionError(404, "CLIENT_UNKNOWN", "这个会话已结束");
        await releaseClientLocked(record.owner, record.sid);
      });
      return reply.code(204).send();
    } catch (error) {
      return clientError(reply, error);
    }
  });
  app.post<{
    Body: { username?: unknown; password?: unknown; role?: unknown; maxSessions?: unknown };
  }>("/api/users", { bodyLimit: 4096 }, async (request, reply) => {
    try {
      return await accountLifecycle.run(async () => {
        requireAdmin(request.raw);
        const user = await userStore.createUser({
          username: request.body?.username,
          password: request.body?.password,
          role: request.body?.role,
          maxSessions: request.body?.maxSessions,
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
  });
  app.patch<{
    Params: { id: string };
    Body: {
      username?: unknown;
      password?: unknown;
      role?: unknown;
      enabled?: unknown;
      maxSessions?: unknown;
    };
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
        if (accountChangeRevokesRemoteCc(previous, user, request.body?.password !== undefined))
          remoteCcStore.removeUser(user.id);
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
      const id = request.params.id;
      await accountLifecycle.run(async () => {
        const admin = requireAdmin(request.raw);
        if (admin.id === id)
          throw new UserStoreError(409, "USER_SELF_DELETE", "请使用另一个管理员账户删除此用户");
        await userStore.updateUser(id, { enabled: false });
        await closeUserWorkspacesLocked(id, userStore.listOwnedProfiles(id));
      });
      // Catalog invalidation owns the same lifecycle lock; run its cleanup between sections.
      await cpaRuntime?.removeUser(id);
      remoteCcStore.removeUser(id);
      await proxyCatalog.removePrivateSources(id);
      await accountLifecycle.run(async () => {
        for (const profileId of userStore.listOwnedProfiles(id)) {
          await rm(accountDir(profileId), { recursive: true, force: true });
          await accountStore.remove(profileId);
          userStore.unassignProfile(profileId);
        }
        mailbox.deleteUser(id);
        userStore.deleteUser(id);
      });
      return reply.code(204).send();
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
    });
  });
  if (e2e) {
    app.post<{ Body: { milliseconds?: number } }>("/__e2e/advance-idle", async (request, reply) => {
      if (!currentOwner(request.raw)) return reply.code(401).send({ error: "Forbidden" });
      const amount = request.body?.milliseconds;
      if (!Number.isSafeInteger(amount) || amount! < 0 || amount! > SESSION_SLEEP_LIMIT_MS)
        return reply.code(400).send({ error: "Invalid test time" });
      await idleReaper.sweep();
      e2eIdleOffset += amount!;
      await idleReaper.sweep();
      await reapIdleResources();
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
  const reapIdleResources = () =>
    accountLifecycle.run(async () => {
      if (stopping) return;
      for (const record of clientSessions.all()) {
        if (runtimePromises.has(record.sid)) continue;
        try {
          if (record.sleepingSince === undefined) await clientSessions.setSleeping(record, true);
          else await expireSleepingSessionLocked(record);
        } catch (error) {
          report("sleeping client cleanup", error);
        }
      }
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
      void reapIdleResources().catch((error) => report("idle resource cleanup failed", error));
    },
    e2e ? 200 : 3000,
  );
  idleTimer.unref?.();
  let oauthSync: Promise<unknown> | undefined;
  const oauthTimer = cpaRuntime
    ? setInterval(() => {
        if (oauthSync) return;
        oauthSync = cpaRuntime
          .reconcileOAuth((instance) =>
            instance.ownerId ? userStore.getUser(instance.ownerId) : userStore.bootstrapAdmin,
          )
          .catch((error) => report("CPA authorization sync failed", error))
          .finally(() => {
            oauthSync = undefined;
          });
      }, 3000)
    : undefined;
  oauthTimer?.unref();
  let stopPromise: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(healthTimer);
    clearInterval(statusTimer);
    clearInterval(idleTimer);
    clearInterval(oauthTimer);
    idleReaper.dispose();
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    stopPromise = (async () => {
      await ws.close().catch(() => {});
      await assetFetcher.close().catch((error) => report("asset shutdown failed", error));
      await app.close().catch(() => {});
      await oauthSync;
      await cpaRuntime?.drain();
      await accountLifecycle.run(async () => {
        for (const runtime of runtimes.values()) {
          await runtime.stop().catch((error) => report("client shutdown failed", error));
        }
        runtimes.clear();
        runtimePromises.clear();
        for (const account of [...accounts.values()]) await closeAccount(account);
        userStore.close();
        cpaStore?.close();
        remoteCc.close();
        remoteCcStore.close();
        mailbox.close();
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
