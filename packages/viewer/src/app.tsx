/**
 * Viewer shell layout: the composition root. The session (app/use-client-session.ts), the running
 * mirror (app/use-mirror-runtime.ts), panel routing (app/panels.ts), the theme and the workspace
 * each keep their own state; this file wires them to the shell's components.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { switchAccount } from "./accounts";
import { TabStrip } from "./chrome/tabstrip";
import { UrlBar } from "./chrome/urlbar";
import { PX_QUALITY_STORAGE_KEY, preferredPxQuality } from "./client-session";
import { describeConnection } from "./connection-status";
import { ProfilePicker } from "./profile-picker";
import { ShellBar, type LinkTarget } from "./shell-bar";
import type { WorkspaceDestination, WorkspaceMenuProps } from "./workspace-menu";
import { usePanels } from "./app/panels";
import { inputFailureReasonOf, pixelModeOf } from "./app/runtime-state";
import { ClientSessionOverlay } from "./app/session-overlay";
import { PageLoadFailed, ShellBanners } from "./app/shell-notices";
import { TransferPanels } from "./app/transfer-panels";
import { useClientSession, useSessionWatch } from "./app/use-client-session";
import { useMirrorRuntime } from "./app/use-mirror-runtime";
import { useServerStatusPoll } from "./app/use-server-status-poll";
import { useTheme } from "./app/use-theme";
import { useCpaBrowserAuthorization, useEntryLinks, useWorkspaceUser } from "./app/use-workspace";
import { viewStorage } from "./app/view-storage";
import { WorkspacePanels } from "./app/workspace-panels";
import { NotificationPrompts } from "./notifications/notify-ui";
import { useNotifications } from "./notifications/use-notifications";
import "@rrweb/replay/dist/style.css";
import "./app.css";
import "./shell.css";

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLElement>(null);
  const fixturePath = useRef(new URLSearchParams(window.location.search).get("fixture")).current;
  const clientSessionControl = useClientSession();
  const {
    phase: clientPhase,
    session: clientSession,
    error: clientError,
  } = clientSessionControl.state;
  const readySid = clientPhase === "ready" ? (clientSession?.sid ?? null) : null;
  const [panels, dispatchPanels] = usePanels();
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
    onReplaced: () => {
      clientSessionControl.replaced();
      // The in-session picker switches this session's profile, which is no longer this page's.
      dispatchPanels({ type: "picker", open: false });
    },
  });
  const { connection, activeTab, tabs, modeByTab, chromeByTab, frameRates } = runtime.state;
  const finishSession = () => {
    runtime.reset("closed");
    clientSessionControl.finish();
    dispatchPanels({ type: "picker", open: false });
  };
  const closeClientSession = () => clientSessionControl.end(() => runtime.reset("closed"));
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

  // The same choice as Claude's Appearance setting.
  const theme = useTheme(readySid);
  const workspaceUser = useWorkspaceUser({
    fixturePath,
    sid: readySid,
    stop: runtime.stop,
    onNotAdmin: () => dispatchPanels({ type: "close", panel: "admin" }),
  });
  const { user, accountList, refreshUser, refreshAccounts } = workspaceUser;
  const entry = useEntryLinks(user, dispatchPanels);
  const cpaAuthorization = useCpaBrowserAuthorization({
    userId: user?.id,
    sid: readySid,
    accountList,
    pickerOpen: panels.pickerOpen,
    onFailed: () => dispatchPanels({ type: "open", panel: "network", networkTab: "cpa" }),
  });
  const browserAuthorization = cpaAuthorization.authorization;
  // Website notifications, remembered per browser profile on this device.
  const notifications = useNotifications(
    fixturePath === null ? readySid : null,
    accountList?.current ?? null,
  );

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
    inputReady: runtime.state.inputReady,
  });

  const navigateWorkspace = (destination: WorkspaceDestination) => {
    workspaceUser.setLogoutError(null);
    cpaAuthorization.setError(null);
    // A CPA authorization waiting for its browser is kept: 「浏览器配置」 shows the same picker,
    // still asking for that choice, and its 返回 is what gives the authorization up.
    dispatchPanels({ type: "navigate", destination, pickerAvailable: clientPhase === "ready" });
    if (destination === "profiles" && clientPhase !== "ready" && clientPhase !== "picking")
      window.location.assign("/?new=1");
  };
  const workspace: WorkspaceMenuProps | undefined = user
    ? {
        user,
        onNavigate: navigateWorkspace,
        onLogout: () => void workspaceUser.signOut(),
        logoutPending: workspaceUser.logoutPending,
        error: workspaceUser.logoutError,
      }
    : undefined;

  return (
    <div
      id="shell"
      data-theme={theme.theme}
      data-connection={connection}
      data-picking={clientPhase === "picking" || panels.pickerOpen}
    >
      <ShellBar
        viewMode={(activeTab !== null && modeByTab[activeTab]) || runtime.state.viewMode}
        onViewMode={(mode) => runtime.changeView(mode, pxQuality)}
        pixelAvailable={runtime.state.pixelAvailable}
        status={shellStatus}
        theme={theme.preference}
        onTheme={theme.setPreference}
        linkTarget={linkTarget}
        onLinkTarget={setLinkTarget}
        workspace={workspace}
        onMenuOpen={refreshUser}
        notifications={notifications.state ? notifications : undefined}
        pxQuality={pxQuality}
        onPxQuality={(quality) => {
          setPxQuality(quality);
          viewStorage().setItem(PX_QUALITY_STORAGE_KEY, quality);
          runtime.updateQuality(quality);
        }}
        serverStatus={runtime.state.serverStatus}
        rttMs={runtime.state.rttMs}
        speedBps={runtime.state.speedBps}
        frameRate={pixelMode ? (frameRates?.display ?? null) : null}
        profileName={currentProfile?.name}
        onReconnect={clientPhase === "ready" ? runtime.reconnect : undefined}
        onResyncInput={clientPhase === "ready" ? () => void runtime.resyncInput() : undefined}
        diagnostics={
          clientPhase === "ready"
            ? {
                connection,
                rttMs: runtime.state.rttMs,
                bufferMs: runtime.state.bufferMs,
                activeTab,
                tabs,
                modeByTab,
                resyncByTab: runtime.state.resyncByTab,
                speedBps: runtime.state.speedBps,
                peakSpeedBps: runtime.state.peakSpeedBps,
                frames: frameRates,
                inputLab: runtime.state.inputLab,
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
      {user && (
        <WorkspacePanels
          user={user}
          panels={panels}
          dispatchPanels={dispatchPanels}
          currentSid={clientSession?.sid}
          browserSessionId={readySid ?? undefined}
          browserProxyId={clientPhase === "ready" ? currentProfile?.proxyId : undefined}
          browserProfileName={clientPhase === "ready" ? currentProfile?.name : undefined}
          onOpenMailUrlInBrowser={
            clientPhase === "ready" && connection === "open"
              ? (url) => {
                  runtime.send({ t: "nav", tab: activeTab ?? "", action: "newtab", url });
                  dispatchPanels({ type: "browser-opened" });
                }
              : undefined
          }
          onBrowseProfiles={() => navigateWorkspace("profiles")}
          remoteCcCode={entry.remoteCcCode}
          accountLinked={entry.accountLinked}
          onEntryLinkUsed={entry.consume}
          authorizationError={cpaAuthorization.error}
          onUserChanged={refreshUser}
          onSessionEnded={(sid) => {
            refreshAccounts();
            if (sid === clientSession?.sid) finishSession();
          }}
          onChooseBrowser={(authorization) => {
            cpaAuthorization.choose(authorization);
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
        pageState={activeTab === null ? undefined : runtime.state.pageStates[activeTab]}
        clipboardError={runtime.state.clipboardError}
        buildStale={runtime.state.buildStale}
        presence={
          fixturePath === null
            ? null
            : {
                viewers: runtime.state.viewers,
                viewerId: runtime.state.viewerId,
                driverId: runtime.state.driverId,
                send: runtime.send,
              }
        }
      />
      <NotificationPrompts control={notifications} />
      <main
        id="mirror-host"
        data-input-ready={runtime.state.inputReady ? "true" : "false"}
        ref={hostRef}
      />
      <PageLoadFailed
        hostRef={hostRef}
        chrome={activeChrome}
        oauth={activeChrome === null ? undefined : runtime.state.oauthCallbacks[activeChrome.tab]}
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
                  cpaAuthorization.forget();
                }
              : undefined
          }
          onChanged={refreshAccounts}
          onDeleted={() => window.location.reload()}
          workspace={workspace}
          theme={theme.preference}
          onTheme={theme.setPreference}
          logoutError={workspaceUser.logoutError}
        />
      )}
      {clientPhase !== "ready" && clientPhase !== "picking" && (
        <ClientSessionOverlay
          session={clientSessionControl.state}
          onRetry={() => {
            if (clientSessionControl.state.endFailure) void closeClientSession();
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
        uploadState={runtime.state.uploadState}
        downloads={runtime.state.downloads.filter((download) =>
          runtime.state.shownDownloadIds.has(download.id),
        )}
        sid={clientSession?.sid}
        onSelectFiles={runtime.selectFiles}
        onCancelFilePick={runtime.cancelFilePick}
        onCancelUpload={runtime.cancelUpload}
        onDismissDownload={runtime.dismissDownload}
      />
    </div>
  );
}
