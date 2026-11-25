/** Viewer shell layout. */
import { listAccounts, switchAccount, type AccountList } from "./accounts";
import { currentUser, logout, type FrontendUser } from "./users";
import { AdminPanel } from "./admin-panel";
import { AccountPanel } from "./account-panel";
import { MailboxPanel } from "./mailbox-panel";
import type { WorkspaceDestination, WorkspaceMenuProps } from "./workspace-menu";
import { NetworkPanel } from "./network-panel";
import { usePanels } from "./app/panels";
import { cpaApi, isCpaBrowserAuthorization, type CpaBrowserAuthorization } from "./network-api";
import { readJson, removeItem, removePrefixed, sessionArea, writeJson } from "./storage";
import { viewStorage } from "./app/view-storage";
import { useTheme } from "./app/use-theme";
import { takeRemoteCcLink } from "./network-remote-cc-panel";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { TabStrip } from "./chrome/tabstrip";
import { UrlBar } from "./chrome/urlbar";
import { ClientSessionOverlay } from "./app/session-overlay";
import { PageLoadFailed, ShellBanners } from "./app/shell-notices";
import { TransferPanels } from "./app/transfer-panels";
import { describeConnection } from "./connection-status";
import { ShellBar, type LinkTarget } from "./shell-bar";
import { PX_QUALITY_STORAGE_KEY, preferredPxQuality } from "./client-session";
import { useClientSession, useSessionWatch } from "./app/use-client-session";
import { useMirrorRuntime } from "./app/use-mirror-runtime";
import { inputFailureReasonOf, pixelModeOf } from "./app/runtime-state";
import { useServerStatusPoll } from "./app/use-server-status-poll";
import { ProfilePicker } from "./profile-picker";
import "@rrweb/replay/dist/style.css";
import "./app.css";
import "./shell.css";

/** A CPA authorization waiting for the person to choose its browser. */
const CPA_BROWSER_KEY = "mirror-cpa-browser";

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);
  const fixturePath = useRef(new URLSearchParams(window.location.search).get("fixture")).current;
  // remote-cc approval links: /?remote-cc=ABCD-EFGH opens the remote-cc tab with the code filled in.
  const [remoteCcLink] = useState(() => takeRemoteCcLink(window.location.href));
  const remoteCcLinkOpened = useRef(false);
  // After linking single sign-on the gate returns to /?account=linked: open the account panel.
  const [accountLinked] = useState(
    () => new URL(window.location.href).searchParams.get("account") === "linked",
  );
  const accountLinkedShown = useRef(false);
  const clientSessionControl = useClientSession();
  const {
    phase: clientPhase,
    session: clientSession,
    error: clientError,
    endFailure,
  } = clientSessionControl.state;
  const [accountList, setAccountList] = useState<AccountList | null>(null);
  const [user, setUser] = useState<FrontendUser | null>(null);
  const [panels, dispatchPanels] = usePanels();
  const [browserAuthorization, setBrowserAuthorization] = useState<CpaBrowserAuthorization | null>(
    () => readJson(sessionArea(), CPA_BROWSER_KEY, isCpaBrowserAuthorization),
  );
  const forgetBrowserAuthorization = () => {
    removeItem(sessionArea(), CPA_BROWSER_KEY);
    setBrowserAuthorization(null);
  };
  const [logoutPending, setLogoutPending] = useState(false);
  /** Signing out failed: shown in the ⋯ menu (or on the picker), where 退出登录 was pressed. */
  const [logoutError, setLogoutError] = useState<string | null>(null);
  /** A CPA authorization could not open in its browser: shown on the CPA tab. */
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [pxQuality, setPxQuality] = useState(() => preferredPxQuality(viewStorage()));
  const [linkTarget, setLinkTarget] = useState<LinkTarget>(() =>
    viewStorage().getItem("mirror.links") === "device" ? "device" : "inside",
  );
  useEffect(() => {
    viewStorage().setItem("mirror.links", linkTarget);
  }, [linkTarget]);
  const runtime = useMirrorRuntime({
    hostRef,
    fileInputRef,
    enabled: clientPhase === "ready",
    sid: clientSession?.sid,
    fixturePath,
    linkTarget,
    onEnded: () => finishSession(),
    onReplaced: () => clientSessionControl.replaced(),
  });
  const {
    connection,
    inputReady,
    pageStates,
    activeTab,
    tabs,
    modeByTab,
    viewMode,
    pixelAvailable,
    resyncByTab,
    rttMs,
    speedBps,
    peakSpeedBps,
    frameRates,
    bufferMs,
    viewerId,
    driverId,
    viewers,
    clipboardError,
    buildStale,
    downloads,
    shownDownloadIds,
    uploadState,
    chromeByTab,
    oauthCallbacks,
    serverStatus,
  } = runtime.state;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The same choice as Claude's Appearance setting.
  const themeSid = clientPhase === "ready" ? (clientSession?.sid ?? null) : null;
  const {
    preference: themePreference,
    setPreference: setThemePreference,
    theme,
  } = useTheme(themeSid);
  // Only the newest request may answer: an older one (another session's) can finish after it.
  const accountRequests = useRef(0);
  const refreshAccounts = useCallback(() => {
    const request = ++accountRequests.current;
    if (themeSid === null) return;
    void listAccounts(themeSid)
      .then((list) => {
        if (mountedRef.current && request === accountRequests.current) setAccountList(list);
      })
      .catch(() => {
        // The menu keeps whatever it last showed.
      });
  }, [themeSid]);
  useEffect(refreshAccounts, [refreshAccounts]);
  /** The user this page loaded for: everything on it (session, profiles, panels) is theirs. */
  const loadedUserId = useRef<string | null>(null);
  const userRequests = useRef(0);
  const refreshUser = useCallback(() => {
    if (fixturePath !== null) return;
    const request = ++userRequests.current;
    // A 401 goes to the gate from the API client itself.
    void currentUser()
      .then((loaded) => {
        if (!mountedRef.current || request !== userRequests.current) return;
        // Another tab signed in as someone else: this page's session, profiles and panels belong
        // to the previous user, so start over as the new one.
        if (loadedUserId.current !== null && loadedUserId.current !== loaded.id) {
          runtime.stop();
          window.location.reload();
          return;
        }
        loadedUserId.current = loaded.id;
        setUser(loaded);
        if (loaded.role !== "admin") dispatchPanels({ type: "close", panel: "admin" });
      })
      .catch(() => {
        // The menu keeps the user it last showed.
      });
  }, [fixturePath]);
  useEffect(refreshUser, [refreshUser]);
  useEffect(() => {
    if (!user || !remoteCcLink || remoteCcLinkOpened.current) return;
    remoteCcLinkOpened.current = true;
    // Read the address again: the session may have rewritten it since the link was opened.
    const current = takeRemoteCcLink(window.location.href);
    if (current) window.history.replaceState(window.history.state, "", current.url);
    if (!remoteCcLink.code) return;
    dispatchPanels({ type: "open", panel: "network", networkTab: "remote-cc" });
  }, [user, remoteCcLink]);
  useEffect(() => {
    if (!user || !accountLinked || accountLinkedShown.current) return;
    accountLinkedShown.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("account");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    dispatchPanels({ type: "open", panel: "account" });
  }, [user, accountLinked]);
  const signOut = async () => {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError(null);
    try {
      // An already expired sign-in counts as signed out.
      await logout();
      removePrefixed(sessionArea(), "mirror-cpa-");
      runtime.stop();
      window.location.assign("/gate");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出失败，请稍后重试。");
      setLogoutPending(false);
    }
  };

  const finishSession = () => {
    runtime.reset("closed");
    clientSessionControl.finish();
    dispatchPanels({ type: "picker", open: false });
  };
  // Observe existing sessions after a disconnect; only an explicit action opens a new one.
  useSessionWatch(
    clientPhase === "ready" && connection !== "open" ? (clientSession?.sid ?? null) : null,
    finishSession,
  );

  useServerStatusPoll(
    fixturePath === null &&
      clientPhase !== "ready" &&
      clientError?.status !== 401 &&
      clientError?.status !== 403,
    clientSession?.sid,
    `${clientPhase}:${clientError?.status}`,
    runtime.receiveServerStatus,
  );

  const closeClientSession = () => clientSessionControl.end(() => runtime.reset("closed"));
  const pixelMode = pixelModeOf(runtime.state);
  const activeChrome = activeTab === null ? null : (chromeByTab[activeTab] ?? null);
  const currentProfile = accountList?.accounts.find(
    (account) => account.id === accountList.current,
  );
  const shellStatus = describeConnection({
    clientPhase,
    connection,
    inputUnsynced: activeTab !== null && !!runtime.state.inputFailures[activeTab],
    inputFailureReason: inputFailureReasonOf(runtime.state),
    inputReady,
  });

  const navigateWorkspace = (destination: WorkspaceDestination) => {
    setLogoutError(null);
    setAuthorizationError(null);
    if (destination === "profiles") forgetBrowserAuthorization();
    dispatchPanels({ type: "navigate", destination, pickerAvailable: clientPhase === "ready" });
    if (destination === "profiles" && clientPhase !== "ready" && clientPhase !== "picking")
      window.location.assign("/?new=1");
  };
  useEffect(() => {
    if (
      !browserAuthorization ||
      browserAuthorization.userId !== user?.id ||
      panels.pickerOpen ||
      clientPhase !== "ready" ||
      !clientSession
    )
      return;
    const current = accountList?.accounts.find((account) => account.id === accountList.current);
    if (current?.proxyId !== browserAuthorization.proxyId) return;
    forgetBrowserAuthorization();
    void cpaApi
      .openOAuth(clientSession.sid, browserAuthorization.instanceId, browserAuthorization.state)
      .catch((error: Error) => {
        if (!mountedRef.current) return;
        setAuthorizationError(error.message);
        dispatchPanels({ type: "open", panel: "network", networkTab: "cpa" });
      });
  }, [
    browserAuthorization,
    panels.pickerOpen,
    clientPhase,
    clientSession?.sid,
    accountList,
    user?.id,
  ]);
  const workspace: WorkspaceMenuProps | undefined = user
    ? {
        user,
        onNavigate: navigateWorkspace,
        onLogout: () => void signOut(),
        logoutPending,
        error: logoutError,
      }
    : undefined;

  return (
    <div
      id="shell"
      data-theme={theme}
      data-connection={connection}
      data-picking={clientPhase === "picking" || panels.pickerOpen}
    >
      <ShellBar
        viewMode={(activeTab !== null && modeByTab[activeTab]) || viewMode}
        onViewMode={(mode) => runtime.changeView(mode, pxQuality)}
        pixelAvailable={pixelAvailable}
        status={shellStatus}
        theme={themePreference}
        onTheme={setThemePreference}
        linkTarget={linkTarget}
        onLinkTarget={setLinkTarget}
        workspace={workspace}
        onMenuOpen={refreshUser}
        pxQuality={pxQuality}
        onPxQuality={(quality) => {
          setPxQuality(quality);
          viewStorage().setItem(PX_QUALITY_STORAGE_KEY, quality);
          runtime.updateQuality(quality);
        }}
        serverStatus={serverStatus}
        rttMs={rttMs}
        speedBps={speedBps}
        frameRate={pixelMode ? (frameRates?.display ?? null) : null}
        profileName={currentProfile?.name}
        onReconnect={clientPhase === "ready" ? runtime.reconnect : undefined}
        onResyncInput={clientPhase === "ready" ? () => void runtime.resyncInput() : undefined}
        diagnostics={
          clientPhase === "ready"
            ? {
                connection,
                rttMs,
                bufferMs,
                activeTab,
                tabs,
                modeByTab,
                resyncByTab,
                speedBps,
                peakSpeedBps,
                frames: frameRates,
              }
            : null
        }
      >
        <TabStrip
          tabs={tabs}
          chromeByTab={chromeByTab}
          onActivate={runtime.activate}
          send={runtime.send}
        />
      </ShellBar>
      {panels.open === "admin" && user?.role === "admin" && (
        <AdminPanel
          key={user.id}
          current={user}
          onClose={() => dispatchPanels({ type: "close", panel: "admin" })}
          onChanged={refreshUser}
        />
      )}
      {panels.open === "account" && user && (
        <AccountPanel
          key={user.id}
          user={user}
          currentSid={clientSession?.sid}
          onClose={() => dispatchPanels({ type: "close", panel: "account" })}
          initialNotice={accountLinked ? "单点登录账号已绑定。" : undefined}
          onSessionEnded={(sid) => {
            refreshAccounts();
            if (sid === clientSession?.sid) finishSession();
          }}
        />
      )}
      {panels.open === "mailboxes" && user && (
        <MailboxPanel
          key={user.id}
          onClose={() => dispatchPanels({ type: "close", panel: "mailboxes" })}
        />
      )}
      {user && (
        <NetworkPanel
          key={user.id}
          remoteCcCode={remoteCcLink?.code || null}
          open={panels.open === "network"}
          error={authorizationError}
          tab={panels.networkTab}
          onTabChange={(tab) => dispatchPanels({ type: "network-tab", tab })}
          user={user}
          browserSessionId={clientPhase === "ready" ? clientSession?.sid : undefined}
          browserProxyId={clientPhase === "ready" ? currentProfile?.proxyId : undefined}
          onClose={() => dispatchPanels({ type: "close", panel: "network" })}
          onOpenBrowser={() => dispatchPanels({ type: "browser-opened" })}
          onChooseBrowser={(authorization) => {
            setAuthorizationError(null);
            writeJson(sessionArea(), CPA_BROWSER_KEY, authorization);
            setBrowserAuthorization(authorization);
            dispatchPanels({ type: "browser-chosen", pickerAvailable: clientPhase === "ready" });
          }}
        />
      )}
      <UrlBar
        tab={activeTab}
        chrome={activeChrome}
        fallbackUrl={tabs.find((tab) => tab.id === activeTab)?.url ?? ""}
        send={runtime.send}
      />
      <ShellBanners
        remoteCc={
          user && currentProfile && clientSession && clientPhase === "ready"
            ? { sid: clientSession.sid, profileId: currentProfile.id }
            : null
        }
        pageState={activeTab === null ? undefined : pageStates[activeTab]}
        clipboardError={clipboardError}
        buildStale={buildStale}
        presence={fixturePath === null ? null : { viewers, viewerId, driverId, send: runtime.send }}
      />
      <main id="mirror-host" data-input-ready={inputReady ? "true" : "false"} ref={hostRef} />
      <PageLoadFailed
        hostRef={hostRef}
        chrome={activeChrome}
        oauth={activeChrome === null ? undefined : oauthCallbacks[activeChrome.tab]}
        pixelMode={pixelMode}
        onShowCpa={() => navigateWorkspace("cpa")}
        onReload={(tab) => runtime.send({ t: "nav", tab, action: "reload" })}
      />
      {(clientPhase === "picking" || panels.pickerOpen) && (
        <ProfilePicker
          requiredProxyId={browserAuthorization?.proxyId}
          proxyManagerOpen={panels.open === "network" && panels.networkTab === "proxies"}
          onPick={async (id) => {
            if (!panels.pickerOpen) {
              clientSessionControl.pick(id);
              return;
            }
            if (id === accountList?.current) {
              dispatchPanels({ type: "picker", open: false });
              return;
            }
            await switchAccount(clientSession!.sid, id);
            window.location.reload();
          }}
          current={panels.pickerOpen ? accountList?.current : null}
          onBack={
            panels.pickerOpen || browserAuthorization
              ? () => {
                  dispatchPanels({
                    type: "picker-back",
                    authorizationWaiting: browserAuthorization !== null,
                  });
                  forgetBrowserAuthorization();
                }
              : undefined
          }
          onChanged={refreshAccounts}
          onDeleted={() => window.location.reload()}
          workspace={workspace}
          theme={themePreference}
          onTheme={setThemePreference}
          logoutError={logoutError}
        />
      )}
      {clientPhase !== "ready" && clientPhase !== "picking" && (
        <ClientSessionOverlay
          session={clientSessionControl.state}
          onRetry={() => {
            if (endFailure) void closeClientSession();
            else clientSessionControl.retry();
          }}
        />
      )}
      {clientPhase === "ready" && (
        // Media notices (see media/video.ts) appear here, over the page's top right.
        <aside id="viewer-hud-layer" aria-label="页面提示" />
      )}
      <TransferPanels
        fileInputRef={fileInputRef}
        uploadState={uploadState}
        downloads={downloads.filter((download) => shownDownloadIds.has(download.id))}
        sid={clientSession?.sid}
        onSelectFiles={runtime.selectFiles}
        onCancelFilePick={runtime.cancelFilePick}
        onCancelUpload={runtime.cancelUpload}
        onDismissDownload={runtime.dismissDownload}
      />
    </div>
  );
}
