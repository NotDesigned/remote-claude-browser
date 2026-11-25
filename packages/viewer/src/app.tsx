import { apiRequest } from "./api";
/** Viewer shell layout. */
import { listAccounts, switchAccount, type AccountList } from "./accounts";
import { currentUser, logout, myBrowserSessions, type FrontendUser } from "./users";
import { AdminPanel } from "./admin-panel";
import { AccountPanel } from "./account-panel";
import { MailboxPanel } from "./mailbox-panel";
import type { WorkspaceDestination, WorkspaceMenuProps } from "./workspace-menu";
import { NetworkPanel, type NetworkTab } from "./network-panel";
import { cpaApi, isCpaBrowserAuthorization, type CpaBrowserAuthorization } from "./network-api";
import {
  localArea,
  readItem,
  readJson,
  removeItem,
  removePrefixed,
  sessionArea,
  writeItem,
  writeJson,
} from "./storage";
import { takeRemoteCcLink, RemoteCcLoginBanner } from "./network-remote-cc-panel";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AgentMsg, Down, eventWithTime, TabId } from "@mirror/protocol";
import { EventType, IncrementalSource } from "@mirror/protocol";
import { createMirror, type Mirror } from "./mirror";
import { attachMirrorInput } from "./input";
import { createInputResync, focusedValueMessage, type InputResync } from "./input/resync-input";
import { EventPipeline } from "./pipeline";
import { createEchoFilter } from "./pipeline/echo";
import { createScrollFilter } from "./pipeline/scroll";
import { createRebuildRestoreHooks } from "./rebuild-restore";
import { TabStrip } from "./chrome/tabstrip";
import { UrlBar } from "./chrome/urlbar";
import { Presence } from "./chrome/presence";
import { createClipboardWriter } from "./chrome/clipboard";
import {
  dismissDownload,
  DownloadTray,
  type DownloadEntry,
  updateDownloads,
} from "./chrome/downloads";
import type { FrameRates } from "./hud";
import { describeConnection } from "./connection-status";
import { pollServerStatus, receiveServerStatus, type ReceivedServerStatus } from "./server-status";
import { ShellBar, type LinkTarget, type ThemePreference } from "./shell-bar";
import { createVoiceLink, type VoiceLink } from "./media/voice";
import { createServerClock, DEFAULT_LIVE_BUFFER_MS } from "./clock";
import { createResyncController, type ResyncTabState, RESYNC_WINDOW_MS } from "./resync";
import { connectGateway, type GatewayConnectionState, type GatewaySocket } from "./ws";
import { createFileUploadRelay, type FileUploadRelay, type UploadState } from "./uploads";
import { externalLink } from "./input/default-actions";
import { createPresentation } from "./presentation";
import {
  ClientSessionError,
  PX_QUALITY_STORAGE_KEY,
  preferredPxQuality,
  preferredViewMode,
  rememberViewMode,
  type ViewMode,
  clientGatewayUrl,
  clientPageMode,
  clientReturnUrl,
  endClientSession,
  prepareClientSession,
  requestClientSession,
  resumesClientSession,
  type ClientSession,
} from "./client-session";
import { ProfilePicker } from "./profile-picker";
import "@rrweb/replay/dist/style.css";
import "./app.css";
import "./shell.css";
import { DOWNLOAD_NOTICE_MS, startClientDownload } from "./auto-download";

/** A viewer that never gets input (for example a follower) must still see the page. */
const SESSION_CHECK_INTERVAL_MS = 5_000;

function configuredResyncWindowMs(): number {
  const raw = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_P2_RESYNC_WINDOW_MS;
  if (raw === undefined || raw === "") return RESYNC_WINDOW_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : RESYNC_WINDOW_MS;
}

async function replayFixture(path: string, mirror: Mirror, signal?: AbortSignal): Promise<void> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
  const messages = (await response.json()) as AgentMsg[];
  if (signal?.aborted) return;
  const events = messages.flatMap((message): eventWithTime[] =>
    message.kind === "rrweb" ? [message.e] : [],
  );
  const snapshotEnd = events.findIndex((event) => event.type === EventType.FullSnapshot);
  if (snapshotEnd < 0) throw new Error("fixture has no FullSnapshot");
  const tab = "fixture-tab";
  mirror.handle({
    t: "snapshot",
    tab,
    epoch: 1,
    seq: snapshotEnd + 1,
    data: events.slice(0, snapshotEnd + 1),
  });
  const tail = events.slice(snapshotEnd + 1);
  if (tail.length > 0) {
    mirror.handle({
      t: "delta",
      tab,
      epoch: 1,
      seq: snapshotEnd + 2,
      data: tail,
    });
  }
}

/** Preferences in localStorage; blocked or full storage just means no memory. */
function viewStorage(): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: (key) => readItem(localArea(), key),
    setItem: (key, value) => writeItem(localArea(), key, value),
  };
}

const THEME_CHECK_MS = 3_000;
/** A CPA authorization waiting for the person to choose its browser. */
const CPA_BROWSER_KEY = "mirror-cpa-browser";
/** How long after a click on a mirror file input the page's file request belongs to that click. */
const MIRROR_PICKER_WINDOW_MS = 5_000;

export function App() {
  const uploadRef = useRef<FileUploadRelay | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef<AbortController | null>(null);
  const [shownDownloadIds, setShownDownloadIds] = useState<ReadonlySet<string>>(new Set());
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const hostRef = useRef<HTMLElement>(null);
  const socketRef = useRef<GatewaySocket | null>(null);
  const presentationRef = useRef<ReturnType<typeof createPresentation> | null>(null);
  const inputResyncRef = useRef<InputResync | null>(null);
  const dismissedDownloadIdsRef = useRef(new Set<string>());
  const runtimeCleanupRef = useRef<(() => void) | null>(null);
  const endControllerRef = useRef<AbortController | null>(null);
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
  const [clientSession, setClientSession] = useState<ClientSession | null>(null);
  const [accountList, setAccountList] = useState<AccountList | null>(null);
  const [user, setUser] = useState<FrontendUser | null>(null);
  const [userPanelOpen, setUserPanelOpen] = useState(false);
  const [networkPanelOpen, setNetworkPanelOpen] = useState(false);
  const [networkTab, setNetworkTab] = useState<NetworkTab>("proxies");
  const [oauthCallbacks, setOAuthCallbacks] = useState<Record<string, "submitted" | "error">>({});
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [mailboxOpen, setMailboxOpen] = useState(false);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
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
  /** The configuration this tab's picker chose; a reload resumes without one. */
  const [pickedAccount, setPickedAccount] = useState<string | null>(null);
  const [clientPhase, setClientPhase] = useState<
    "picking" | "starting" | "ready" | "error" | "ending" | "closed" | "replaced"
  >(() => {
    const mode = clientPageMode(new URL(window.location.href));
    return mode === "closed" ? "closed" : mode === "fixture" ? "ready" : "starting";
  });
  const [clientError, setClientError] = useState<ClientSessionError | null>(null);
  const [endFailure, setEndFailure] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [connection, setConnection] = useState<GatewayConnectionState>("connecting");
  const [serverStatus, setServerStatus] = useState<ReceivedServerStatus | null>(null);
  const [statusAuthRejected, setStatusAuthRejected] = useState(false);
  const [inputReady, setInputReady] = useState(false);
  const [inputFailures, setInputFailures] = useState<Record<TabId, boolean>>({});
  /** Why each failed tab's field sync failed, for the UI to show beside 「输入未同步」. */
  const [inputFailureReasons, setInputFailureReasons] = useState<Record<TabId, string>>({});
  const [pageStates, setPageStates] = useState<Record<TabId, "recovering" | "ready" | "failed">>(
    {},
  );
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const voiceRef = useRef<VoiceLink | null>(null);
  useEffect(() => {
    const voice = createVoiceLink();
    voiceRef.current = voice;
    const unlock = () => voice.unlock();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      voiceRef.current = null;
      voice.dispose();
    };
  }, []);
  const [tabs, setTabs] = useState<Extract<Down, { t: "tabs" }>["tabs"]>([]);
  const [modeByTab, setModeByTab] = useState<Record<TabId, "dom" | "px" | undefined>>({});
  const [pixelAvailable, setPixelAvailable] = useState(true);
  const [resyncByTab, setResyncByTab] = useState<Record<TabId, ResyncTabState | undefined>>({});
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [speedBps, setSpeedBps] = useState<number | null>(null);
  const [frameRates, setFrameRates] = useState<FrameRates | null>(null);
  const pixelModeRef = useRef(false);
  const [peakSpeedBps, setPeakSpeedBps] = useState<number | null>(null);
  const [bufferMs, setBufferMs] = useState(DEFAULT_LIVE_BUFFER_MS);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [viewers, setViewers] = useState<Extract<Down, { t: "presence" }>["viewers"]>([]);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (fixturePath !== null) return "dom";
    const requested = new URLSearchParams(window.location.search).get("mode");
    return requested === "dom" || requested === "px" ? requested : preferredViewMode(viewStorage());
  });
  // The view the entry URL or memory asks for applies once tabs exist.
  const pendingModeRef = useRef<"dom" | "px" | null>(viewMode);
  const pageKey = useRef(globalThis.crypto.randomUUID()).current;
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const stored = viewStorage().getItem("mirror.theme");
    return stored === "light" || stored === "dark" ? stored : "auto";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const theme: "light" | "dark" =
    themePreference === "auto" ? (systemDark ? "dark" : "light") : themePreference;
  const [pxQuality, setPxQuality] = useState(() => preferredPxQuality(viewStorage()));
  const [linkTarget, setLinkTarget] = useState<LinkTarget>(() =>
    viewStorage().getItem("mirror.links") === "device" ? "device" : "inside",
  );
  const linkTargetRef = useRef(linkTarget);
  linkTargetRef.current = linkTarget;
  useEffect(() => {
    viewStorage().setItem("mirror.links", linkTarget);
  }, [linkTarget]);
  const [chromeByTab, setChromeByTab] = useState<
    Record<TabId, Extract<Down, { t: "chrome" }> | undefined>
  >({});
  const activeTitle = tabs.find((tab) => tab.id === activeTab)?.title.trim() ?? "";

  useEffect(() => {
    document.title = activeTitle || "远程 Claude";
  }, [activeTitle]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Keep the current view in the address so a reload reopens it.
  useEffect(() => {
    if (fixturePath !== null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("mode") === viewMode) return;
    url.searchParams.set("mode", viewMode);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [viewMode]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      endControllerRef.current?.abort();
      runtimeCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    viewStorage().setItem("mirror.theme", themePreference);
  }, [theme, themePreference]);
  // The same choice as Claude's Appearance setting. This page's choice goes first, and is repeated
  // until a Claude page has taken it. Only then can a change made under Settings come back.
  const themeSid = clientPhase === "ready" ? (clientSession?.sid ?? null) : null;
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
          runtimeCleanupRef.current?.();
          window.location.reload();
          return;
        }
        loadedUserId.current = loaded.id;
        setUser(loaded);
        if (loaded.role !== "admin") setUserPanelOpen(false);
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
    setNetworkTab("remote-cc");
    setNetworkPanelOpen(true);
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
    setAccountPanelOpen(true);
  }, [user, accountLinked]);
  const signOut = async () => {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError(null);
    try {
      // An already expired sign-in counts as signed out.
      await logout();
      removePrefixed(sessionArea(), "mirror-cpa-");
      runtimeCleanupRef.current?.();
      window.location.assign("/gate");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出失败，请稍后重试。");
      setLogoutPending(false);
    }
  };
  const themeKey = `${themePreference}:${systemDark}`;
  const syncedThemeRef = useRef<string | null>(null);
  useEffect(() => {
    if (themeSid === null) return;
    let active = true;
    const url = `/s/${encodeURIComponent(themeSid)}/theme`;
    const send = async () => {
      const result = await apiRequest<{ applied?: boolean } | undefined>(url, "POST", {
        theme: themePreference,
        systemDark,
      });
      if (active && result?.applied) syncedThemeRef.current = themeKey;
    };
    const sync = async () => {
      if (document.hidden) return;
      if (syncedThemeRef.current !== themeKey) {
        await send();
        return;
      }
      const result = await apiRequest<{ theme?: ThemePreference | null } | undefined>(url);
      if (!active || result === undefined) return;
      const remote = result.theme ?? null;
      // The gateway has restarted and does not know this client's choice.
      if (remote === null) {
        syncedThemeRef.current = null;
        await send();
        return;
      }
      if (remote === themePreference) return;
      syncedThemeRef.current = `${remote}:${systemDark}`;
      setThemePreference(remote);
    };
    void sync().catch(() => {});
    const timer = setInterval(() => void sync().catch(() => {}), THEME_CHECK_MS);
    // A phone coming back should not show the old mode for up to a whole check.
    const onVisible = () => void sync().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [themeSid, themeKey]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const pageMode = clientPageMode(url);
    if (pageMode === "closed") {
      setClientPhase("closed");
      return;
    }
    if (pageMode === "fixture") return;
    let resuming = false;
    try {
      resuming = resumesClientSession(url, window.sessionStorage);
    } catch {
      // The picker is still usable when accessing sessionStorage itself is blocked.
    }
    if (pickedAccount === null && !resuming) {
      setClientPhase("picking");
      return;
    }
    let active = true;
    const controller = new AbortController();
    setClientPhase("starting");
    setClientError(null);
    setEndFailure(false);
    void (async () => {
      try {
        const request = prepareClientSession(url, window.sessionStorage, (nextUrl) => {
          window.history.replaceState(window.history.state, "", nextUrl);
        });
        const session = await requestClientSession(
          pickedAccount === null ? request : { ...request, account: pickedAccount },
          { signal: controller.signal },
        );
        if (!active || !mountedRef.current || controller.signal.aborted) return;
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set("sid", session.sid);
        window.history.replaceState(
          window.history.state,
          "",
          `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`,
        );
        setClientSession(session);
        setClientPhase("ready");
      } catch (error) {
        if (!active || !mountedRef.current || controller.signal.aborted) return;
        setClientError(
          error instanceof ClientSessionError
            ? error
            : new ClientSessionError(0, "CLIENT_START", "无法打开独立会话，请稍后重试。"),
        );
        setClientPhase("error");
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [bootstrapAttempt, pickedAccount]);

  const finishSession = () => {
    runtimeCleanupRef.current?.();
    setInputReady(false);
    setConnection("closed");
    setActiveTab(null);
    setTabs([]);
    setViewers([]);
    setViewerId(null);
    setDriverId(null);
    setDownloads([]);
    setClientError(null);
    setClientSession(null);
    setClientPhase("closed");
    setProfilePickerOpen(false);
    window.history.replaceState(window.history.state, "", "/?closed=1");
  };
  // Observe existing sessions after a disconnect; only an explicit action opens a new one.
  const sessionUnreachable =
    clientPhase === "ready" && clientSession !== null && connection !== "open";
  useEffect(() => {
    if (!sessionUnreachable || clientSession === null) return;
    let active = true;
    const sid = clientSession.sid;
    const timer = setInterval(() => {
      void myBrowserSessions()
        .then((sessions) => {
          if (active && !sessions.some((session) => session.sid === sid && session.currentDevice))
            finishSession();
        })
        .catch(() => {});
    }, SESSION_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sessionUnreachable, clientSession?.sid]);

  useEffect(() => {
    if (
      fixturePath !== null ||
      clientPhase === "ready" ||
      statusAuthRejected ||
      clientError?.status === 401 ||
      clientError?.status === 403
    )
      return;
    return pollServerStatus({
      sid: clientSession?.sid,
      onSample: (value) => {
        setServerStatus((previous) => receiveServerStatus(previous, value, Date.now()));
      },
      onAuthFailure: () => setStatusAuthRejected(true),
    });
  }, [clientPhase, clientSession?.sid, clientError?.status, fixturePath, statusAuthRejected]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || clientPhase !== "ready") return;
    let disposed = false;
    const controller = new AbortController();
    let socket: GatewaySocket | null = null;
    let sessionId: string | null = null;
    const pageUrls = new Map<TabId, string>();
    const autoStarted = new Set<string>();
    const shownDownloads = new Set<string>();
    const showDownload = (id: string) => {
      if (disposed || shownDownloads.has(id)) return;
      shownDownloads.add(id);
      setShownDownloadIds(new Set(shownDownloads));
    };
    const dismissDownloadSoon = (id: string) => {
      const timer = setTimeout(() => {
        if (disposed) return;
        dismissedDownloadIdsRef.current.add(id);
        setDownloads((current) => dismissDownload(current, id));
      }, DOWNLOAD_NOTICE_MS);
      downloadTimers.add(timer);
    };
    const downloadTimers = new Set<ReturnType<typeof setTimeout>>();
    const clipboard = createClipboardWriter({
      onCopied: () => {
        if (!disposed) setClipboardError(null);
      },
      onError: () => {
        if (!disposed) setClipboardError("复制失败，请允许浏览器访问剪贴板");
      },
    });
    const echo = createEchoFilter({
      onContenteditableReconcile: () => {
        const tab = presentation.activeTab();
        if (tab !== null && presentation.canInput(tab, "dom"))
          socket?.send({ t: "resync-req", tab, reason: "editable-clear" });
      },
    });
    // A file input in the mirror opens its own picker, and the same click reaches the remote page.
    let mirrorPickerOpenedAt = Number.NEGATIVE_INFINITY;
    const uploads = createFileUploadRelay({
      // A finished upload needs no notice: the page shows the attachment itself.
      onState: (state) => {
        if (!disposed) setUploadState(state?.phase === "done" ? null : state);
      },
      openPicker: (multiple) => {
        if (Date.now() - mirrorPickerOpenedAt < MIRROR_PICKER_WINDOW_MS) return true;
        const input = fileInputRef.current;
        if (input === null || typeof input.showPicker !== "function") return false;
        input.multiple = multiple;
        try {
          input.showPicker();
          return true;
        } catch {
          return false;
        }
      },
    });
    uploadRef.current = uploads;
    const scroll = createScrollFilter({
      send(message) {
        if (presentation.canInput(message.tab, "dom")) socket?.send(message);
      },
    });
    // Pasted images become attachments of the remote page: stage the files, then open the
    // remote attachment input. Its `filepick` (also published over the socket) pairs with them.
    const uploadPastedFiles = async (tab: TabId, files: File[], sid: string): Promise<void> => {
      uploadRequestRef.current?.abort();
      const request = new AbortController();
      uploadRequestRef.current = request;
      uploads.selectFiles(tab, files);
      setUploadState({
        tab,
        phase: "uploading",
        multiple: files.length > 1,
        loaded: 0,
        total: 0,
        name: `正在把粘贴的${files.length > 1 ? ` ${files.length} 个文件` : "图片"}作为附件传到远端…`,
      });
      try {
        const result = await apiRequest<Extract<Down, { t: "filepick" }> | undefined>(
          `/s/${encodeURIComponent(sid)}/uploads/prepare`,
          "POST",
          { tab },
          undefined,
          { signal: request.signal },
        );
        if (disposed || request.signal.aborted) return;
        if (result === undefined) throw new Error("远端附件入口尚未就绪");
        uploads.handlePick(result, sid);
      } catch (error) {
        if (disposed || request.signal.aborted) return;
        uploads.clear();
        setUploadState({
          tab,
          phase: "error",
          multiple: false,
          loaded: 0,
          total: 0,
          name: `粘贴的附件未能上传：${error instanceof Error ? error.message : "请重试"}`,
        });
      } finally {
        if (uploadRequestRef.current === request) uploadRequestRef.current = null;
      }
    };
    const pipeline = new EventPipeline()
      .use((event) => {
        // The browser already paints the local selection. rrweb would replace it with a
        // delayed range ordered by document position, losing the direction of a backward drag.
        if (
          event.type === EventType.IncrementalSnapshot &&
          event.data.source === IncrementalSource.Selection
        )
          return null;
        return event;
      })
      .use(echo)
      .use(scroll)
      .onReset(echo.reset)
      .onReset(scroll.reset);
    const restoreHooks = createRebuildRestoreHooks().use(echo.restoreHook);
    const clock = createServerClock({ bufferMs: DEFAULT_LIVE_BUFFER_MS });
    const resync = createResyncController({
      windowMs: configuredResyncWindowMs(),
      send: (message) => socket?.send(message),
      onStateChange(state) {
        if (disposed) return;
        setResyncByTab((current) => ({ ...current, [state.tab]: state }));
      },
    });
    const mirror = createMirror({
      container: host,
      pipeline,
      clock,
      // Each hidden tab costs this browser its page's memory, which a phone has least of.
      parkedTabs: /\bMobi/.test(navigator.userAgent) ? 1 : 2,
      onBufferApplied: (buffer) => {
        if (!disposed) setBufferMs(buffer);
      },
      restoreHooks,
      rtc: {
        // A site's video has no other way here. Canvases are few on these pages, and blank is fine.
        requestCanvases: false,
        send(tab, lane, payload) {
          socket?.send({ t: "rtc-sig", tab, lane, payload });
        },
        onError(error) {
          console.warn("mirror media WebRTC unavailable", error);
        },
      },
      onSnapshotApplied(snapshot) {
        if (disposed) return;
        resync.recovered(snapshot.tab);
        presentation.snapshotApplied(snapshot);
      },
      requestResync(tab, reason) {
        resync.request(tab, reason);
      },
      attachInteraction(tab, replayer) {
        // A press inside the mirror happens in its frame, out of the page's listeners' sight.
        const frame = replayer.iframe.contentWindow;
        const unlock = () => voiceRef.current?.unlock();
        frame?.addEventListener("pointerdown", unlock, true);
        frame?.addEventListener("keydown", unlock, true);
        return attachMirrorInput({
          replayer,
          tab,
          send: (message) => {
            if (presentation.canInput(tab, "dom")) socket?.send(message);
          },
          onEditableFocus: echo.setFocused,
          onEditableInput: echo.input,
          onKeyDown: echo.keyDown,
          onFileSelection: (tab, input) => {
            if (presentation.canInput(tab, "dom")) uploads.select(tab, input);
            else input.value = "";
          },
          linkToOpen: (target) =>
            linkTargetRef.current === "device" ? externalLink(target, pageUrls.get(tab)) : null,
          openLink: (url) => {
            window.open(url, "_blank", "noopener,noreferrer");
          },
          onFilePickerOpened: () => {
            mirrorPickerOpenedAt = Date.now();
          },
          onFilePickerCanceled: (tab) => uploads.cancelPick(tab),
          onPasteFiles: (tab, files) => {
            if (presentation.canInput(tab, "dom") && sessionId !== null)
              void uploadPastedFiles(tab, files, sessionId);
          },
          scrollFilter: scroll,
        });
      },
    });
    let paintedFrames = 0;
    let gatewayFrames = { capture: 0, encode: 0, drop: 0 };
    const presentation = createPresentation({
      host,
      mirror,
      send: (message) => socket?.send(message),
      entryTab: new URLSearchParams(window.location.search).get("tab"),
      entryMode: pendingModeRef.current,
      preferredQuality: () => preferredPxQuality(viewStorage()),
      onTab: setActiveTab,
      onViewMode: setViewMode,
      onTabMode: (tab, mode) => setModeByTab((current) => ({ ...current, [tab]: mode })),
      onInputReady: (ready) => {
        if (mountedRef.current) setInputReady(ready);
      },
      onPaint: () => paintedFrames++,
    });
    presentationRef.current = presentation;
    pendingModeRef.current = null;
    const inputResync = createInputResync({
      valueFor: (tab) => {
        const replayer = mirror.getReplayer();
        const root = replayer?.iframe.contentDocument;
        if (!replayer || !root || mirror.getActiveTab() !== tab) return null;
        return focusedValueMessage(root, tab, (node) => replayer.getMirror().getId(node));
      },
      send: (message) => {
        if (presentation.canInput(message.tab, "dom")) socket?.send(message);
      },
    });
    inputResyncRef.current = inputResync;
    // Frame rates only mean something in the pixel view: elsewhere, do not redraw the page for them.
    let sampledFrames = false;
    const frameRateTimer = setInterval(() => {
      const sample = pixelModeRef.current;
      if (sample) setFrameRates({ ...gatewayFrames, display: paintedFrames });
      else if (sampledFrames) setFrameRates(null);
      sampledFrames = sample;
      paintedFrames = 0;
    }, 1_000);
    const resizeObserver = new ResizeObserver(presentation.resized);
    resizeObserver.observe(host);
    window.addEventListener("resize", presentation.resized);
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(frameRateTimer);
      controller.abort();
      for (const timer of downloadTimers) clearTimeout(timer);
      socket?.close();
      resizeObserver.disconnect();
      window.removeEventListener("resize", presentation.resized);
      socketRef.current = null;
      voiceRef.current?.setSender(null);
      presentationRef.current = null;
      presentation.dispose();
      inputResync.dispose();
      inputResyncRef.current = null;
      resync.dispose();
      clipboard.dispose();
      uploads.dispose();
      uploadRef.current = null;
      uploadRequestRef.current?.abort();
      setUploadState(null);
      if (mountedRef.current) setPixelAvailable(true);
      if (runtimeCleanupRef.current === cleanup) runtimeCleanupRef.current = null;
    };
    runtimeCleanupRef.current = cleanup;

    if (fixturePath !== null) {
      setActiveTab("fixture-tab");
      setConnection("open");
      void replayFixture(fixturePath, mirror, controller.signal).catch((error: unknown) => {
        if (disposed) return;
        host.dataset.mirrorState = "error";
        host.textContent = error instanceof Error ? error.message : String(error);
      });
      return cleanup;
    }

    socket = connectGateway(
      clientGatewayUrl(window.location.href, clientSession?.sid),
      (message: Down) => {
        if (disposed) return;
        if (message.t === "audio") {
          voiceRef.current?.play(message.pcm);
          return;
        }
        if (message.t === "mic") {
          voiceRef.current?.setMic(message.tab, message.on);
          return;
        }
        if (message.t === "input-status") {
          setInputFailures((previous) => ({ ...previous, [message.tab]: message.failed }));
          setInputFailureReasons((previous) => {
            const next = { ...previous };
            if (message.failed) next[message.tab] = message.reason ?? "远端页面未接受这次输入";
            else delete next[message.tab];
            return next;
          });
          inputResync.status(message.tab, message.failed);
          return;
        }
        if (message.t === "cpa-oauth") {
          setOAuthCallbacks((previous) => ({ ...previous, [message.tab]: message.status }));
          return;
        }

        if (message.t === "server-status") {
          setServerStatus((previous) => receiveServerStatus(previous, message, Date.now()));
          return;
        }
        if (message.t === "px-capacity") setPixelAvailable(message.available);
        if (message.t === "px-stats") {
          gatewayFrames = {
            capture: message.captureFps,
            encode: message.encodeFps,
            drop: message.dropFps,
          };
          return;
        }
        presentation.handle(message);
        if (message.t === "hello") {
          setOAuthCallbacks({});
          // The gateway follows `hello` with the input-status of every tab still failed.
          setInputFailures({});
          setInputFailureReasons({});
          setPageStates({});
          sessionId = message.sessionId;
          setViewerId(message.viewerId);
          void apiRequest<DownloadEntry[] | undefined>(
            `/s/${encodeURIComponent(message.sessionId)}/downloads`,
            "GET",
            undefined,
            undefined,
            { signal: controller.signal },
          )
            .then((response) => {
              if (disposed || !Array.isArray(response)) return;
              // Closed here before a reconnect: it stays closed.
              const listed = response.filter(
                (entry) => !dismissedDownloadIdsRef.current.has(entry.id),
              );
              setDownloads(listed);
              // Finished before this page connected: offer the link briefly, never re-download.
              for (const entry of listed) {
                autoStarted.add(entry.id);
                showDownload(entry.id);
                if (entry.state !== "active") dismissDownloadSoon(entry.id);
              }
            })
            .catch(() => undefined);
          if (message.role === "driver") setDriverId(message.viewerId);
        }
        if (message.t === "driver") {
          setDriverId(message.viewerId);
          if (!presentation.isDriver()) {
            uploads.clear();
            uploadRequestRef.current?.abort();
          }
        }
        if (message.t === "presence") setViewers(message.viewers);
        if (message.t === "clip") {
          clipboard.write(message.text);
        }
        if (message.t === "chrome") {
          pageUrls.set(message.tab, message.url);
          setChromeByTab((current) => ({ ...current, [message.tab]: message }));
        }
        if (message.t === "tab-state")
          setPageStates((current) => ({ ...current, [message.tab]: message.state }));
        if (message.t === "tabs") setTabs(message.tabs);
        if (message.t === "download" && !dismissedDownloadIdsRef.current.has(message.id)) {
          setDownloads((current) => updateDownloads(current, message));
          // The link works from the start: the browser saves the file as it arrives, and shows that.
          if (message.href && !autoStarted.has(message.id)) {
            autoStarted.add(message.id);
            startClientDownload(message.href, message.name);
          }
          if (message.state === "canceled") showDownload(message.id);
          if (message.state === "done") {
            // A phone's browser may refuse a save nobody tapped for, so it keeps the button.
            if (/\bMobi/.test(navigator.userAgent)) showDownload(message.id);
            if (shownDownloads.has(message.id)) dismissDownloadSoon(message.id);
            else setDownloads((current) => dismissDownload(current, message.id));
          }
        }
        if (message.t === "filepick" && presentation.isDriver() && sessionId !== null) {
          uploads.handlePick(message, sessionId);
        }
      },
      {
        visible: !document.hidden,
        connectionKey: pageKey,
        onRttSample(sample) {
          if (disposed) return;
          mirror.observeRtt(sample);
          setRttMs(sample);
        },
        onSpeedSample(sample) {
          if (disposed) return;
          setSpeedBps(sample);
          setPeakSpeedBps((peak) => Math.max(peak ?? 0, sample));
        },
        resumeParam: presentation.resumeParam,
        onStateChange(state, reconnected) {
          if (disposed) return;
          setConnection(state);
          presentation.connectionChanged(state, reconnected);
          if (state === "ended") {
            finishSession();
            return;
          }
          if (state === "replaced") {
            cleanup();
            setActiveTab(null);
            setTabs([]);
            setViewers([]);
            setViewerId(null);
            setDriverId(null);
            setDownloads([]);
            setClientPhase("replaced");
            return;
          }
        },
        onProtocolError(error) {
          if (!disposed) mirror.recover(error.message);
        },
      },
    );
    socketRef.current = socket;
    voiceRef.current?.setSender((message) => socket?.send(message));

    return cleanup;
  }, [clientPhase, clientSession?.sid, fixturePath]);

  useEffect(() => {
    const report = () => {
      socketRef.current?.setVisible(!document.hidden);
      if (!document.hidden) socketRef.current?.probe();
    };
    document.addEventListener("visibilitychange", report);
    window.addEventListener("pageshow", report);
    window.addEventListener("online", report);
    return () => {
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("pageshow", report);
      window.removeEventListener("online", report);
    };
  }, []);

  const closeClientSession = async () => {
    if (clientSession === null || endControllerRef.current !== null) return;
    const controller = new AbortController();
    endControllerRef.current = controller;
    runtimeCleanupRef.current?.();
    setInputReady(false);
    setConnection("closed");
    setActiveTab(null);
    setTabs([]);
    setViewers([]);
    setViewerId(null);
    setDriverId(null);
    setDownloads([]);
    setClientError(null);
    setEndFailure(false);
    setClientPhase("ending");
    try {
      await endClientSession(clientSession.sid, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setClientSession(null);
      setClientPhase("closed");
      window.history.replaceState(window.history.state, "", "/?closed=1");
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setClientError(
        error instanceof ClientSessionError
          ? error
          : new ClientSessionError(0, "CLIENT_END", "未能结束会话，请重试。当前页面已停止操作。"),
      );
      setEndFailure(true);
      setClientPhase("error");
    } finally {
      if (endControllerRef.current === controller) endControllerRef.current = null;
    }
  };
  const pixelMode = activeTab !== null && modeByTab[activeTab] === "px";
  pixelModeRef.current = pixelMode;
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
  const resyncInput = useCallback(
    () => (activeTab === null ? false : (inputResyncRef.current?.resync(activeTab) ?? false)),
    [activeTab],
  );
  // The gateway's short reason while the active tab's input is not synced.
  const inputFailureReason =
    activeTab !== null && inputFailures[activeTab] ? inputFailureReasons[activeTab] : undefined;
  const shellStatus = describeConnection({
    clientPhase,
    connection,
    inputUnsynced: activeTab !== null && !!inputFailures[activeTab],
    inputFailureReason,
    inputReady,
  });
  const changeView = (mode: ViewMode, remember = true) => {
    if (remember) rememberViewMode(viewStorage(), mode);
    if (mode === viewMode) return;
    if (presentationRef.current) presentationRef.current.requestMode(mode, pxQuality);
    else {
      pendingModeRef.current = mode;
      setViewMode(mode);
    }
  };

  const navigateWorkspace = (destination: WorkspaceDestination) => {
    setLogoutError(null);
    setAuthorizationError(null);
    if (destination === "profiles") forgetBrowserAuthorization();
    setUserPanelOpen(destination === "admin");
    setAccountPanelOpen(destination === "account");
    setMailboxOpen(destination === "mailboxes");
    // 「网络与接入」 opens on the tab last used; other callers name the tab.
    setNetworkPanelOpen(
      destination === "network" || destination === "proxies" || destination === "cpa",
    );
    if (destination === "proxies" || destination === "cpa") setNetworkTab(destination);
    if (destination === "profiles") {
      if (clientPhase === "ready") setProfilePickerOpen(true);
      else if (clientPhase !== "picking") window.location.assign("/?new=1");
    }
  };
  useEffect(() => {
    if (
      !browserAuthorization ||
      browserAuthorization.userId !== user?.id ||
      profilePickerOpen ||
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
        setNetworkTab("cpa");
        setNetworkPanelOpen(true);
      });
  }, [
    browserAuthorization,
    profilePickerOpen,
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
      data-picking={clientPhase === "picking" || profilePickerOpen}
    >
      <ShellBar
        viewMode={(activeTab !== null && modeByTab[activeTab]) || viewMode}
        onViewMode={changeView}
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
          presentationRef.current?.updateQuality(quality);
        }}
        serverStatus={serverStatus}
        rttMs={rttMs}
        speedBps={speedBps}
        frameRate={pixelMode ? (frameRates?.display ?? null) : null}
        profileName={currentProfile?.name}
        onReconnect={clientPhase === "ready" ? () => socketRef.current?.reconnect() : undefined}
        onResyncInput={clientPhase === "ready" ? () => void resyncInput() : undefined}
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
          onActivate={(tab) => presentationRef.current?.activate(tab)}
          send={(message) => socketRef.current?.send(message)}
        />
      </ShellBar>
      {userPanelOpen && user?.role === "admin" && (
        <AdminPanel
          current={user}
          onClose={() => setUserPanelOpen(false)}
          onChanged={refreshUser}
        />
      )}
      {accountPanelOpen && user && (
        <AccountPanel
          user={user}
          currentSid={clientSession?.sid}
          onClose={() => setAccountPanelOpen(false)}
          initialNotice={accountLinked ? "单点登录账号已绑定。" : undefined}
          onSessionEnded={(sid) => {
            refreshAccounts();
            if (sid === clientSession?.sid) finishSession();
          }}
        />
      )}
      {mailboxOpen && user && <MailboxPanel key={user.id} onClose={() => setMailboxOpen(false)} />}
      {user && (
        <NetworkPanel
          key={user.id}
          remoteCcCode={remoteCcLink?.code || null}
          open={networkPanelOpen}
          error={authorizationError}
          tab={networkTab}
          onTabChange={setNetworkTab}
          user={user}
          browserSessionId={clientPhase === "ready" ? clientSession?.sid : undefined}
          browserProxyId={clientPhase === "ready" ? currentProfile?.proxyId : undefined}
          onClose={() => setNetworkPanelOpen(false)}
          onOpenBrowser={() => {
            setNetworkPanelOpen(false);
            setProfilePickerOpen(false);
          }}
          onChooseBrowser={(authorization) => {
            setAuthorizationError(null);
            writeJson(sessionArea(), CPA_BROWSER_KEY, authorization);
            setBrowserAuthorization(authorization);
            setNetworkPanelOpen(false);
            setProfilePickerOpen(clientPhase === "ready");
          }}
        />
      )}
      <UrlBar
        tab={activeTab}
        chrome={activeChrome}
        fallbackUrl={tabs.find((tab) => tab.id === activeTab)?.url ?? ""}
        send={(message) => socketRef.current?.send(message)}
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
        {fixturePath !== null && (
          <Presence
            viewers={viewers}
            viewerId={viewerId}
            driverId={driverId}
            send={(message) => socketRef.current?.send(message)}
          />
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
                onClick={() =>
                  socketRef.current?.send({ t: "nav", tab: activeChrome.tab, action: "reload" })
                }
              >
                重新加载
              </button>
            )}
          </section>
        )}
      {(clientPhase === "picking" || profilePickerOpen) && (
        <ProfilePicker
          requiredProxyId={browserAuthorization?.proxyId}
          proxyManagerOpen={networkPanelOpen && networkTab === "proxies"}
          onPick={async (id) => {
            if (!profilePickerOpen) {
              setPickedAccount(id);
              return;
            }
            if (id === accountList?.current) {
              setProfilePickerOpen(false);
              return;
            }
            await switchAccount(clientSession!.sid, id);
            window.location.reload();
          }}
          current={profilePickerOpen ? accountList?.current : null}
          onBack={
            profilePickerOpen || browserAuthorization
              ? () => {
                  setProfilePickerOpen(false);
                  forgetBrowserAuthorization();
                  if (browserAuthorization) {
                    setNetworkTab("cpa");
                    setNetworkPanelOpen(true);
                  }
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
                    else setBootstrapAttempt((current) => current + 1);
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
            else uploadRef.current?.select(uploadState.tab, event.currentTarget);
          }}
          onCancel={() => {
            if (uploadState !== null) uploadRef.current?.cancelPick(uploadState.tab);
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
              <button
                type="button"
                onClick={() => {
                  uploadRequestRef.current?.abort();
                  uploadRef.current?.cancel();
                }}
              >
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
          onDismiss={(id) => {
            dismissedDownloadIdsRef.current.add(id);
            setDownloads((current) => dismissDownload(current, id));
          }}
        />
      </aside>
    </div>
  );
}
