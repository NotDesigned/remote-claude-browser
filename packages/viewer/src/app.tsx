/** Viewer shell layout. */
import { apiRequest } from "./api";
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
import { takeRemoteCcLink, RemoteCcLoginBanner } from "./network-remote-cc-panel";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { TabStrip } from "./chrome/tabstrip";
import { UrlBar } from "./chrome/urlbar";
import { Presence } from "./chrome/presence";
import { DownloadTray } from "./chrome/downloads";
import { describeConnection } from "./connection-status";
import { ShellBar, type LinkTarget } from "./shell-bar";
import { PX_QUALITY_STORAGE_KEY, preferredPxQuality, clientReturnUrl } from "./client-session";
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
    picked: pickedAccount,
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
  const [downloadError, setDownloadError] = useState<string | null>(null);
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
  // Where the mirror starts, for the load-failure notice drawn over it; read after layout.
  const [hostTop, setHostTop] = useState(0);
  const pageFailureShown =
    activeChrome !== null &&
    (!!oauthCallbacks[activeChrome.tab] || (activeChrome.failed === true && !pixelMode));
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!pageFailureShown || host === null) return;
    const measure = () => setHostTop(host.offsetTop);
    measure();
    const observer = new ResizeObserver(measure);
    // Banners above the mirror push it down, and shrink it as they do.
    observer.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pageFailureShown]);
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
      <div id="shell-banners">
        {user && currentProfile && clientSession && clientPhase === "ready" && (
          <RemoteCcLoginBanner sid={clientSession.sid} profileId={currentProfile.id} />
        )}
        {activeTab !== null && pageStates[activeTab] && pageStates[activeTab] !== "ready" && (
          <p id="page-recovery-state" class="shell-banner" data-tone="warn" role="alert">
            {pageStates[activeTab] === "recovering"
              ? "远程网页已崩溃，正在恢复…"
              : "远程网页恢复失败，请刷新页面"}
          </p>
        )}
        {clipboardError && (
          <p class="shell-banner clipboard-error" data-tone="warn" role="status">
            {clipboardError}
          </p>
        )}
        {buildStale && (
          <p id="build-stale" class="shell-banner" role="status">
            页面已更新，空闲时会自动刷新。
            <button type="button" onClick={() => window.location.reload()}>
              立即刷新
            </button>
          </p>
        )}
        {fixturePath !== null && (
          <Presence viewers={viewers} viewerId={viewerId} driverId={driverId} send={runtime.send} />
        )}
      </div>
      <main id="mirror-host" data-input-ready={inputReady ? "true" : "false"} ref={hostRef} />
      {activeChrome &&
        (oauthCallbacks[activeChrome.tab] || (activeChrome.failed === true && !pixelMode)) && (
          // From where the mirror starts: the address bar above it is how to go somewhere else.
          <section id="page-load-failed" role="alert" style={{ top: `${hostTop}px` }}>
            <h2>
              {oauthCallbacks[activeChrome.tab] === "submitted"
                ? "授权回调已提交给 CPA"
                : oauthCallbacks[activeChrome.tab] === "error"
                  ? "授权回调自动提交失败"
                  : "这个网页打不开"}
            </h2>
            <p>
              {oauthCallbacks[activeChrome.tab] === "submitted"
                ? "可以返回 CPA 面板查看授权结果。"
                : activeChrome.url}
            </p>
            {oauthCallbacks[activeChrome.tab] && (
              <>
                {oauthCallbacks[activeChrome.tab] === "error" && (
                  <p>自动提交失败，可返回 CPA 面板手动提交上面的回调地址。</p>
                )}
                <button type="button" onClick={() => navigateWorkspace("cpa")}>
                  查看 CPA 授权
                </button>
              </>
            )}
            {oauthCallbacks[activeChrome.tab] !== "submitted" && (
              <button
                type="button"
                onClick={() => runtime.send({ t: "nav", tab: activeChrome.tab, action: "reload" })}
              >
                重新加载
              </button>
            )}
          </section>
        )}
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
        <section
          id="client-session-overlay"
          class="client-session-overlay"
          data-phase={clientPhase}
          role={clientPhase === "error" || clientPhase === "replaced" ? "alert" : "status"}
        >
          <div class="client-session-card">
            <span class="session-eyebrow">独立浏览器</span>
            <h1>
              {clientPhase === "replaced"
                ? "此会话已在另一页面打开"
                : clientPhase === "closed"
                  ? "当前会话已结束"
                  : clientPhase === "ending"
                    ? "正在结束会话…"
                    : clientPhase === "error"
                      ? endFailure
                        ? "未能结束会话"
                        : "暂时无法打开会话"
                      : "正在打开独立会话…"}
            </h1>
            <p>
              {clientPhase === "replaced"
                ? "当前页面已停止连接和输入，可在另一页面继续，或另开独立会话。"
                : clientPhase === "closed"
                  ? "当前页面已停止连接。点击重新开启后，才会再次申请会话。"
                  : clientPhase === "ending"
                    ? "已停止本页面的输入和连接，正在释放会话资源。"
                    : clientPhase === "error"
                      ? clientError?.message
                      : "正在连接当前用户的独立浏览器。首次打开可能需要一些时间。"}
            </p>
            <p class="session-policy">
              不同用户的浏览器数据互相隔离。同一浏览器配置下的会话共享网站登录。离线约 60
              秒后释放远程窗口；返回时重新打开启动页，未发送草稿不保留。正在生成时暂缓释放。
            </p>
            {clientPhase === "error" &&
              clientError !== null &&
              clientError.ownedSessions.length > 0 && (
                <div class="owned-client-sessions">
                  <p>返回本设备已有的会话：</p>
                  {clientError.ownedSessions.map((session) => (
                    <a key={session.sid} href={clientReturnUrl(session.sid)}>
                      {session.label}
                    </a>
                  ))}
                </div>
              )}
            <div class="client-session-actions">
              {clientPhase === "replaced" && (
                <a class="session-primary-action" href="/?new=1" target="_blank" rel="noopener">
                  另开独立会话
                </a>
              )}
              {clientPhase === "closed" && (
                <button
                  id="client-session-reopen"
                  type="button"
                  class="session-primary-action"
                  onClick={() => window.location.assign("/?new=1")}
                >
                  重新开启会话
                </button>
              )}
              {clientPhase === "error" && (
                <button
                  id="client-session-retry"
                  type="button"
                  class="session-primary-action"
                  onClick={() => {
                    if (endFailure) void closeClientSession();
                    else clientSessionControl.retry();
                  }}
                >
                  {endFailure ? "重试结束" : "重试"}
                </button>
              )}
              {clientPhase === "error" && clientError?.status === 401 && (
                <a href="/gate">重新登录</a>
              )}
              {clientPhase === "error" &&
                !endFailure &&
                (pickedAccount !== null || clientError?.code === "EXIT_REQUIRED") && (
                  <a href="/?new=1">重新选择配置并设置出口</a>
                )}
              {clientPhase === "error" && endFailure && clientSession !== null && (
                <a href={clientReturnUrl(clientSession.sid)}>返回当前会话</a>
              )}
            </div>
          </div>
        </section>
      )}
      {clientPhase === "ready" && (
        // Media notices (see media/video.ts) appear here, over the page's top right.
        <aside id="viewer-hud-layer" aria-label="页面提示" />
      )}
      <aside id="transfer-panels" aria-label="文件与剪贴板">
        <input
          ref={fileInputRef}
          id="local-file-picker"
          type="file"
          multiple={uploadState?.multiple ?? false}
          hidden
          onChange={(event) => {
            if (uploadState === null) event.currentTarget.value = "";
            else runtime.selectFiles(uploadState.tab, event.currentTarget);
          }}
          onCancel={() => {
            if (uploadState !== null) runtime.cancelFilePick(uploadState.tab);
          }}
        />
        {/* Uploading: a thin bar along the bottom edge, over everything, taking no room. */}
        {uploadState?.phase === "uploading" && (
          <div
            id="upload-progress"
            role="progressbar"
            aria-label={uploadState.name || "正在上传附件"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              uploadState.total > 0
                ? Math.round((uploadState.loaded / uploadState.total) * 100)
                : undefined
            }
            data-indeterminate={uploadState.total > 0 ? undefined : "true"}
          >
            <span
              style={
                uploadState.total > 0
                  ? { width: `${(uploadState.loaded / uploadState.total) * 100}%` }
                  : undefined
              }
            />
          </div>
        )}
        {/* Only what needs the person: a tap to open the picker, or a failure. */}
        {uploadState !== null &&
          (uploadState.phase === "picking" || uploadState.phase === "error") && (
            <section id="upload-panel" role="status">
              <span>{uploadState.name}</span>
              {uploadState.phase === "picking" && (
                <>
                  <button type="button" onClick={() => fileInputRef.current?.click()}>
                    选择本机文件
                  </button>
                  <small>单文件 ≤100 MB，单批 ≤500 MB</small>
                </>
              )}
              <button type="button" onClick={runtime.cancelUpload}>
                {uploadState.phase === "picking" ? "取消上传" : "关闭"}
              </button>
            </section>
          )}
        <DownloadTray
          downloads={downloads.filter((download) => shownDownloadIds.has(download.id))}
          error={downloadError}
          onCancel={async (id) => {
            if (!clientSession) return;
            setDownloadError(null);
            try {
              await apiRequest(
                `/s/${encodeURIComponent(clientSession.sid)}/downloads/${encodeURIComponent(id)}`,
                "DELETE",
              );
            } catch {
              setDownloadError("取消下载失败，请重试");
            }
          }}
          onDismiss={runtime.dismissDownload}
        />
      </aside>
    </div>
  );
}
