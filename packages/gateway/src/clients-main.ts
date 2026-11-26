/**
 * The client gateway's composition root: independent workspaces over one Chrome per account.
 * Sessions on one account share its login profile. Profiles separate site storage; shared
 * infrastructure is not an unlinkability guarantee.
 *
 * This file only builds the parts and wires them together:
 * - auth/session-access.ts: who is asking, and which workspaces and profiles are theirs
 * - session/runtime-registry.ts: starting and ending workspace browsers, and their locking rules
 * - session/client-runtime.ts: one workspace's browser
 * - browser/account-pool.ts: one Chrome per profile
 * - ws/viewer-hub.ts: viewers and their WebSocket messages
 * - routes/*: the workbench HTTP routes; http-errors.ts answers their errors
 */
import Fastify from "fastify";
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerAccountRoutes } from "./auth/account-routes";
import { createSessionGuard } from "./auth/middleware";
import { createOidc, oidcSettingsFromEnv } from "./auth/oidc";
import { createSessionAccess } from "./auth/session-access";
import { createUserGate } from "./auth/user-gate";
import { createUserStore, type FrontendUser } from "./auth/users";
import { createAssetCache } from "./assets/cache";
import { createAssetFetcher } from "./assets/fetch";
import { assetLimitsFromEnv } from "./assets/limits";
import { registerAssetRoutes } from "./assets/route";
import { ANY_SESSION_TAB, sealAssetToken } from "./assets/token";
import { createAccountPool, sendNotify } from "./browser/account-pool";
import { configuredBrowserEngine } from "./browser/engine";
import { evaluateInPage } from "./browser/evaluate";
import { BROWSER_PLATFORMS, type BrowserPlatform } from "./browser/identity";
import { createGrabSlots } from "./browser/pixel-window";
import { separateDefaultProfile } from "./browser/profile-directory";
import { createCpaBrokerDriver } from "./cpa/broker-client";
import { registerCpaManagementRoutes } from "./cpa/management";
import { registerCpaInferenceRoutes, registerCpaRoutes } from "./cpa/routes";
import { createCpaRuntime } from "./cpa/runtime";
import { CpaError, createCpaStore } from "./cpa/store";
import { registerDownloadRoutes } from "./downloads";
import { createProxyCatalog, ProxyCatalogError } from "./egress/catalog";
import { registerProxyRoutes } from "./egress/routes";
import { createRuntimeClient } from "./egress/runtime-client";
import { createExitCheckLimiter } from "./egress/probe-limit";
import { createScopedExits, egressScope } from "./egress/scoped-exits";
import { registerErrorHandler } from "./http-errors";
import { createMailboxService, registerMailboxRoutes, RESEND_WEBHOOK_PATH } from "./mail/mailboxes";
import { createResourceMonitor } from "./monitor/headroom";
import { createResourceSampler } from "./monitor/resources";
import { createServerStatus } from "./monitor/server-status";
import { createPixelCapacity } from "./px-capacity";
import { registerRemoteCcRoutes, REMOTE_CC_TOKEN_PATH } from "./remote-cc/routes";
import { createRemoteCcStore, RemoteCcError } from "./remote-cc/store";
import { createRemoteCcBrowser } from "./remote-cc/workspace-browser";
import { registerAdminRoutes } from "./routes/admin-routes";
import type { GatewayContext } from "./routes/context";
import { registerE2eRoutes } from "./routes/e2e-routes";
import { createProfileActions, registerProfileRoutes } from "./routes/profile-routes";
import { registerSessionRoutes, sessionRouteGuard } from "./routes/session-routes";
import { createWorkspaceErrors } from "./routes/workspace-errors";
import { createNotifyRelay } from "./notify/relay";
import { registerNotifyRoutes } from "./notify/routes";
import { registerUploadRoutes } from "./uploads";
import { registerSecurityHeaders } from "./security-headers";
import { gatewayHost, registerViewerStatic, trustedProxies, viewerBuildId } from "./serving";
import { createClientRuntime, type ClientRuntime } from "./session/client-runtime";
import { ClientSessionError, createClientSessions, isClientSlot } from "./session/clients";
import { createIdleReaper, PAGE_GENERATING_EXPRESSION } from "./session/idle-reaper";
import { createLifecycleLock } from "./session/lifecycle-lock";
import { createProfileStore } from "./session/profiles";
import { ACCOUNT_IDLE_CLOSE_MS, sessionIdleGraceMs } from "./session/resource-policy";
import { createSessionRuntimeRegistry } from "./session/runtime-registry";
import { createViewerHub } from "./ws/viewer-hub";

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
    fingerprintPlatform: platforms[0]!,
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
  const profileUser = (id: string) => userStore.getUser(userStore.profileOwner(id)!);
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
  const lock = createLifecycleLock();
  const networkRuntime = createRuntimeClient({ socketPath: process.env.MIRROR_RUNTIME_SOCKET });
  const exits = createScopedExits(networkRuntime);
  const invalidateNodes = async (ids: string[]) => {
    await lock.run(async () => {
      for (const record of accountStore.all())
        if (record.proxyId && ids.includes(record.proxyId)) {
          await profiles.resetRuntimeLocked(record.id);
          await accountStore.setTimeZone(record.id, undefined);
        }
      for (const id of ids) await exits.stopNode(id, !!process.env.MIRROR_RUNTIME_SOCKET);
    });
  };
  const ownerOfInstance = (instance: { ownerId?: string | null }) =>
    instance.ownerId ? userStore.getUser(instance.ownerId) : userStore.bootstrapAdmin;
  const proxyCatalog = await createProxyCatalog({
    file: join(profile, "proxy-sources.json"),
    allowPrivateSubscriptionTargets: process.env.MIRROR_PROXY_SUBSCRIPTION_ALLOW_PRIVATE === "1",
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
      return exits.start(user.id, id, node);
    },
    onRemovedNodes: invalidateNodes,
    onChangedNodes: async (ids) => {
      await invalidateNodes(ids);
      await cpaRuntime?.restoreBindings(ids, ownerOfInstance);
    },
  });
  /** Each check of a node starts its own probe egress; these are bounded per user and in all. */
  const exitChecks = createExitCheckLimiter();
  const checkProxy = async (user: FrontendUser, id: string) => {
    const node = proxyCatalog.getNodeConfig(user, id);
    return exitChecks.run(user.id, async () => {
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
    });
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
    const restored = await cpaRuntime.restore(ownerOfInstance);
    if (restored.failures.length)
      console.error("Some CPA exits could not be restored:", restored.failures);
  }
  const remoteCcStore = await createRemoteCcStore({ file: join(profile, "remote-cc.sqlite") });
  const app = Fastify({ logger: false, trustProxy: trustedProxies() });
  registerErrorHandler(app);
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
  const resources = createResourceMonitor(resourceSampler, await resourceSampler.sample());
  let stopping = false;
  const isStopping = () => stopping;
  const report = (message: string, error: unknown) => {
    // A window that only starts a download closes itself while its setup is still being answered.
    if (error instanceof Error && error.name === "TargetCloseError") return;
    if (!stopping) console.error(message, error);
  };

  // ---------------------------------------------------------------- who is asking
  const access = createSessionAccess<ClientRuntime>({
    e2e,
    key,
    bootstrapAdmin: () => userStore.bootstrapAdmin,
    signedInUser: (request) => gate.currentUser(request),
    deviceSession: (request) => sessionGuard.session(request),
    sessions: clientSessions,
    profileOwner: (id) => userStore.profileOwner(id),
    isStopping,
    isClosing: (sid): boolean => registry.isClosing(sid),
    runtimeOf: (sid): ClientRuntime | undefined => registry.get(sid),
  });
  const { currentOwner, currentUser } = access;
  const oidcSettings = oidcSettingsFromEnv(process.env, process.env.MIRROR_PUBLIC_ORIGIN);
  const oidc = oidcSettings && createOidc(oidcSettings, { store: userStore });
  const gate = createUserGate({
    store: userStore,
    publicOrigin: process.env.MIRROR_PUBLIC_ORIGIN,
    oidc,
    cookiesOnSuccess: (request) => [access.deviceCookie(request)],
    async onLogout(request, user) {
      const owner = user && access.ownerForUser(request, user);
      if (owner)
        for (const record of clientSessions.all())
          if (record.owner === owner) await registry.release(owner, record.sid);
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
    if (gate.isSignedIn(request.raw) && !currentOwner(request.raw))
      reply.header("set-cookie", access.deviceCookie(request.raw));
  });

  // ---------------------------------------------------------------- workspaces and browsers
  const registry = createSessionRuntimeRegistry<ClientRuntime>({
    lock,
    sessions: clientSessions,
    isStopping,
    isOnline: (sid) => hub.onlineSessions().has(sid),
    mayRun(record): boolean {
      const userId = access.userIdForOwner(record.owner);
      return (
        !!userId &&
        userStore.getUser(userId)?.enabled === true &&
        access.ownsProfile(userId, clientSessions.profileOf(record.sid))
      );
    },
    now: sessionNow,
    start: (record, start) =>
      createClientRuntime(
        {
          e2e,
          sessions: clientSessions,
          memoryShort: () => resources.memoryShort(),
          openAccount: (id) => accounts.open(id),
          publish: (sid, message) => hub.publish(sid, message),
          isDriver: (viewerId, sid) => hub.isDriver(viewerId, sid),
          backlogged: (sid) => hub.backlogged(sid),
          sendViewer: (viewerId, sid, message) => hub.sendViewer(viewerId, sid, message),
          pixelCapacity,
          grabSlots,
          displayGrabbable:
            process.env.CHROME_HEADFUL === "1" &&
            !!process.env.DISPLAY &&
            !process.env.BROWSER_CDP_URL &&
            process.env.MIRROR_SCREEN_GRAB !== "0",
          onNavigated: captureCpaCallback,
          onTabClosed: (sid, tab) => {
            hub.forgetTab(sid, tab);
            notifications.forgetTab(sid, tab);
          },
          report,
        },
        record,
        start,
      ),
    async disconnect(sid, ended) {
      hub.disconnectSession(sid, ended);
      await assetFetcher.closeSession(sid);
    },
    closeWindows: (sid, runtime) =>
      accounts.closeWorkspaceWindows(sid, clientSessions.profileOf(sid), runtime),
    forget: (sid) => {
      hub.forgetSession(sid);
      notifications.forgetSession(sid);
    },
    onChange: () => hub.broadcastStatus(),
  });
  const accounts = createAccountPool({
    e2e,
    defaultBrowserDirectory,
    accountsDir,
    profiles: accountStore,
    profileUser,
    proxyCatalog,
    memoryShort: (extraBytes) => resources.memoryShort(extraBytes),
    isPhoneSession: (sid) => clientSessions.get(sid)?.phone === true,
    isClosing: (sid) => registry.isClosing(sid),
    workspacesOn: (accountId) =>
      [...registry.values()].filter((runtime) => runtime.account.id === accountId),
    themeOf: (sid) => registry.get(sid)?.theme.current() ?? "auto",
    publish: (sid, message) => hub.publish(sid, message),
    onVoice: (sid, tab, message, account) => hub.onVoice(sid, tab, message, account),
    onNotify: (sid, tab, message) => notifications.onAgent(sid, tab, message),
    report,
  });
  /** Website notifications from the session's pages to its viewers' devices (notify/relay.ts). */
  const notifications = createNotifyRelay({
    sendAgent(sid, tab, value) {
      const runtime = registry.get(sid);
      if (runtime && runtime.account.pool.ownerOf(tab) === sid)
        sendNotify(runtime.account, tab, value);
    },
    looking: (sid) => hub.onlineSessions().has(sid),
    iconUrl(sid, url, documentOrigin) {
      const key = registry.isClosing(sid) ? undefined : registry.get(sid)?.assetKey;
      if (key === undefined) return undefined;
      const token = sealAssetToken(
        { url, sessionId: sid, tabId: ANY_SESSION_TAB, documentUrl: `${documentOrigin}/` },
        key,
      );
      return `/s/${encodeURIComponent(sid)}/a/${token}`;
    },
    activate: (sid, tab) =>
      void hub.activateTab(sid, tab).catch((error) => report("notification tab activation", error)),
  });
  /** CPA picks up its OAuth callback from the workspace's address bar. */
  function captureCpaCallback(
    account: { id: string },
    sid: string,
    message: { tab: string; url: string },
  ) {
    const user = profileUser(account.id);
    if (user)
      void cpaRuntime
        ?.captureBrowserCallback(user, accountStore.get(account.id)?.proxyId, message.url)
        .then((captured) => {
          if (captured) hub.publish(sid, { t: "cpa-oauth", tab: message.tab, status: "submitted" });
        })
        .catch(() => {
          hub.publish(sid, { t: "cpa-oauth", tab: message.tab, status: "error" });
          console.error("CPA automatic callback failed; manual submission remains available");
        });
  }
  const grabSlots = createGrabSlots();
  const pixelCapacity = createPixelCapacity({
    maxActive: Infinity,
    onChange() {
      for (const sid of registry.sids())
        hub.publish(sid, { t: "px-capacity", available: pixelCapacity.available() });
      hub.broadcastStatus();
    },
  });
  const status = createServerStatus({
    resources: resources.current,
    onlineOwners: () => hub.onlineOwnerCount(),
    allocated: () => clientSessions.all().length,
    pixelsActive: () => pixelCapacity.count(),
    exitFor: (sid) => registry.get(sid)?.account ?? accountStore.get(clientSessions.profileOf(sid)),
  });
  const hub = createViewerHub({
    server: app.server,
    e2e,
    publicOrigin: process.env.MIRROR_PUBLIC_ORIGIN,
    access,
    upgradeSignedIn: (request) =>
      gate.authorizeUpgrade(request) && sessionGuard.authorizeUpgrade(request),
    registry,
    sessions: clientSessions,
    pixelCapacity,
    status,
    touch: (sid) => idleReaper.touch(sid),
    // Read for each connection: deploy-viewer.sh publishes a viewer without restarting this.
    build: () => viewerBuildId(),
    isStopping,
    onPresence: (sid) => notifications.presenceChanged(sid),
    report,
  });
  const idleReaper = createIdleReaper({
    sessions: () =>
      clientSessions
        .all()
        .filter((record) => registry.isStarted(record.sid))
        .map((record) => ({ sid: record.sid, token: record })),
    isOnline: (sid) => hub.onlineSessions().has(sid),
    isBusy: async (sid) => {
      const runtime = registry.get(sid);
      if (!runtime) return false;
      for (const target of runtime.targets.values()) {
        if (target.type !== "page") continue;
        const user = profileUser(runtime.account.id);
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
        // Whether the page is writing a reply, which closing or reloading it would cut short.
        const generating = await evaluateInPage(
          runtime.browser.send,
          target.sessionId,
          PAGE_GENERATING_EXPRESSION,
          "Idle page inspection timed out",
        );
        if (generating === true) return true;
      }
      return false;
    },
    release: (sid, token) => registry.sleep(sid, token),
    graceMs: sessionIdleGraceMs(process.env.MIRROR_IDLE_GRACE_MS, e2e),
    now: sessionNow,
    onError: (error) => report("idle client cleanup", error),
  });
  const assetFetcher = createAssetFetcher({
    proxyFor: (ref) => registry.get(ref.sessionId)?.account.proxyUrl,
    send: (sessionId, method, params) => accounts.send(sessionId, method, params),
    sessionFor: (ref) => {
      const runtime = registry.get(ref.sessionId);
      const targets = runtime?.targets;
      if (ref.tabId === ANY_SESSION_TAB)
        return [...(targets?.values() ?? [])].find((target) => target.type === "page")?.sessionId;
      return runtime?.account.pool.ownerOf(ref.tabId) === ref.sessionId
        ? targets?.get(ref.tabId)?.sessionId
        : undefined;
    },
  });

  // ---------------------------------------------------------------- routes
  gate.registerRoutes(app);
  registerMailboxRoutes(app, mailbox, (request: IncomingMessage) => currentUser(request)?.id);
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
  const remoteCc = registerRemoteCcRoutes(app, {
    store: remoteCcStore,
    secret: createHmac("sha256", key).update("remote-cc").digest(),
    // Users who only sign in through OIDC keep remote-cc only while they keep signing in there.
    userActive: (user) => !oidc || oidc.recentlySignedIn(user.id),
    publicOrigin: (request) =>
      process.env.MIRROR_PUBLIC_ORIGIN?.replace(/\/+$/, "") ||
      `${request.headers["x-forwarded-proto"] === "http" ? "http" : "https"}://${request.headers.host}`,
    checkExit: (user, nodeId) =>
      checkProxy(user, nodeId).catch((error: unknown) => {
        if (error instanceof ProxyCatalogError && error.statusCode === 429)
          throw new RemoteCcError(429, "REMOTE_CC_EXIT_BUSY", error.message);
        throw error;
      }),
    saveExit: (profileId, metadata) => accountStore.setExitMetadata(profileId, metadata),
    browser: createRemoteCcBrowser({ registry, onlineSessions: () => hub.onlineSessions() }),
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
  const requireSession = () => sessionRouteGuard(access);
  const assetLimits = assetLimitsFromEnv();
  registerAssetRoutes(app, {
    serverKey: randomBytes(32),
    serverKeyForSession: (sid) =>
      registry.isClosing(sid) ? undefined : registry.get(sid)?.assetKey,
    cache: createAssetCache(join(profile, "asset-cache"), undefined, {
      maxEntryBytes: assetLimits.maxBytes,
    }),
    fetcher: assetFetcher,
    limits: assetLimits,
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
    managerFor: (sid) => registry.get(sid)?.uploads,
  });
  registerNotifyRoutes(app, {
    relay: notifications,
    preHandler: requireSession(),
    authorized: (request, sid) => access.ownsSession(request, sid),
  });
  const ctx: GatewayContext = {
    e2e,
    lock,
    userStore,
    accountStore,
    clientSessions,
    mailbox,
    remoteCcStore,
    cpaStore,
    cpaRuntime,
    proxyCatalog,
    networkRuntime,
    exits,
    access,
    registry,
    accounts,
    hub,
    workspace: createWorkspaceErrors({
      currentOwner,
      owned: (owner) => clientSessions.owned(owner),
      report,
    }),
    idleReaper,
    platforms,
    requirePlatform,
    profileSystem,
    checkProxy,
    exitChecks,
    requireSession,
    status,
    isStopping,
    report,
  };
  const profiles = createProfileActions(ctx);
  registerSessionRoutes(app, ctx, profiles, remoteCc);
  registerProfileRoutes(app, ctx, profiles);
  registerAdminRoutes(app, ctx, profiles);
  registerAccountRoutes(app, {
    attempts: gate.attempts,
    store: userStore,
    sessions: clientSessions,
    lifecycle: lock,
    currentUser,
    currentOwner,
    userIdForOwner: access.userIdForOwner,
    profileName: (id) => accountStore.all().find((record) => record.id === id)?.name ?? id,
    onlineSessions: () => hub.onlineSessions(),
    stopSession: registry.releaseLocked,
    oidc: oidc ? { label: oidc.settings.label, issuer: oidc.settings.issuer } : undefined,
    onPasswordChanged: (userId) => {
      hub.closeUserSessions(userId);
      // A new password also cuts off every computer and egress host connected as this user.
      remoteCcStore.removeUser(userId);
    },
  });

  // ---------------------------------------------------------------- maintenance
  /** Sleeping sessions start their 24 h clock; profiles nobody uses close their Chrome. */
  const reapIdleResources = () =>
    lock.run(async () => {
      if (stopping) return;
      for (const record of clientSessions.all()) {
        if (registry.isStarted(record.sid)) continue;
        try {
          if (record.sleepingSince === undefined) await clientSessions.setSleeping(record, true);
          else await registry.expireSleepingLocked(record);
        } catch (error) {
          report("sleeping client cleanup", error);
        }
      }
      await accounts.closeUnused((id) => registry.profileInUse(id), ACCOUNT_IDLE_CLOSE_MS);
    });
  if (e2e)
    registerE2eRoutes(app, ctx, {
      advance: (milliseconds) => (e2eIdleOffset += milliseconds),
      reap: reapIdleResources,
    });
  // Wait for old cleanup before another operation can reuse a SID or profile.
  const stopHealthWatch = accounts.watchHealth({
    run: (task) => lock.run(task),
    isStopping,
    async onDead(account) {
      for (const runtime of [...registry.values()]) {
        if (runtime.account !== account) continue;
        await registry.teardown(runtime.sid, {
          onStopError: (error) => report("crashed workspace cleanup", error),
        });
      }
    },
  });
  // Revoked logins (logout, password/role/enabled change, deletion) close the user's
  // connections now; the periodic check below still catches logins that simply expire.
  const stopRevocationWatch = userStore.onLoginsRevoked((userId) => {
    hub.closeRevoked(userId);
    notifications.closeUnauthorized();
  });
  const statusTimer = setInterval(() => {
    hub.closeUnauthorized();
    notifications.closeUnauthorized();
    void resources
      .sample()
      .then(() => hub.broadcastStatus())
      .catch((error) => report("resource sampling", error));
  }, 3000);
  statusTimer.unref?.();
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
          .reconcileOAuth(ownerOfInstance)
          .catch((error) => report("CPA authorization sync failed", error))
          .finally(() => {
            oauthSync = undefined;
          });
      }, 3000)
    : undefined;
  oauthTimer?.unref();

  // ---------------------------------------------------------------- start and stop
  let stopPromise: Promise<void> | undefined;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopHealthWatch();
    clearInterval(statusTimer);
    stopRevocationWatch();
    clearInterval(idleTimer);
    clearInterval(oauthTimer);
    idleReaper.dispose();
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    stopPromise = (async () => {
      await hub.close().catch(() => {});
      notifications.close();
      await assetFetcher.close().catch((error) => report("asset shutdown failed", error));
      await app.close().catch(() => {});
      await oauthSync;
      await cpaRuntime?.drain();
      await lock.run(async () => {
        await registry.stopAll((error) => report("client shutdown failed", error));
        await accounts.closeAll();
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
