/** Viewer shell layout. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentMsg, Down, eventWithTime, TabId } from "@mirror/protocol";
import { EventType, encodeResumeCursors } from "@mirror/protocol";
import { createMirror, type Mirror } from "./mirror";
import { attachMirrorInput } from "./input";
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
import { createPxView, type PxView } from "./pxview";
import { HudLayer, type FrameRates } from "./hud";
import { videoOption } from "./px-video";
import { pollServerStatus, receiveServerStatus, type ReceivedServerStatus } from "./server-status";
import { ShellBar, type ThemePreference } from "./shell-bar";
import { createVoiceLink, type VoiceLink } from "./media/voice";
import { createServerClock, DEFAULT_LIVE_BUFFER_MS } from "./clock";
import { createResyncController, type ResyncTabState, RESYNC_WINDOW_MS } from "./resync";
import { connectGateway, type GatewayConnectionState, type GatewaySocket } from "./ws";
import { createFileUploadRelay, type FileUploadRelay, type UploadState } from "./uploads";
import { createPresentationState } from "./presentation";
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
  type ClientSession,
} from "./client-session";
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

/** Accessing localStorage itself throws when site data is blocked; fall back to no memory. */
function viewStorage(): Pick<Storage, "getItem" | "setItem"> {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

const PICTURE_HOLD_TIMEOUT_MS = 8_000;
const THEME_CHECK_MS = 3_000;
/** How long after a click on a mirror file input the page's file request belongs to that click. */
const MIRROR_PICKER_WINDOW_MS = 5_000;
/** How long a tab list naming another tab is taken as older than this viewer's own click. */
const ACTIVATION_WAIT_MS = 2_000;

export function App() {
  const uploadRef = useRef<FileUploadRelay | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef<AbortController | null>(null);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const hostRef = useRef<HTMLElement>(null);
  const socketRef = useRef<GatewaySocket | null>(null);
  const mirrorRef = useRef<Mirror | null>(null);
  const pxViewRef = useRef<PxView | null>(null);
  const activateTabRef = useRef<((tab: TabId) => void) | null>(null);
  const dismissedDownloadIdsRef = useRef(new Set<string>());
  const runtimeCleanupRef = useRef<(() => void) | null>(null);
  const endControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const fixturePath = useRef(new URLSearchParams(window.location.search).get("fixture")).current;
  const [clientSession, setClientSession] = useState<ClientSession | null>(null);
  const [clientPhase, setClientPhase] = useState<
    "starting" | "ready" | "error" | "ending" | "closed" | "replaced"
  >(() => {
    const mode = clientPageMode(new URL(window.location.href));
    return mode === "closed" ? "closed" : mode === "fixture" ? "ready" : "starting";
  });
  const [clientError, setClientError] = useState<ClientSessionError | null>(null);
  const [endFailure, setEndFailure] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [connection, setConnection] = useState<GatewayConnectionState>("connecting");
  const [serverStatus, setServerStatus] = useState<ReceivedServerStatus | null>(null);
  const [, setStatusReachable] = useState(false);
  const [statusAuthRejected, setStatusAuthRejected] = useState(false);
  // Re-render each second so the menu notices when the last status sample turns stale.
  const [, setStatusNow] = useState(Date.now);
  const [inputReady, setInputReady] = useState(false);
  const [inputFailures, setInputFailures] = useState<Record<TabId, boolean>>({});
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
  // The page changes shape while the picture starts, which the mirror should not show.
  const pictureHoldRef = useRef<{
    tab: TabId;
    messages: Down[];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const releasePictureHold = (replay: boolean) => {
    const hold = pictureHoldRef.current;
    if (!hold) return;
    pictureHoldRef.current = null;
    clearTimeout(hold.timer);
    if (replay) for (const message of hold.messages) mirrorRef.current?.handle(message);
  };
  const holdMirrorForPicture = (tab: TabId) => {
    releasePictureHold(true);
    pictureHoldRef.current = {
      tab,
      messages: [],
      timer: setTimeout(() => releasePictureHold(true), PICTURE_HOLD_TIMEOUT_MS),
    };
  };
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
  const themeKey = `${themePreference}:${systemDark}`;
  const syncedThemeRef = useRef<string | null>(null);
  useEffect(() => {
    if (themeSid === null) return;
    let active = true;
    const url = `/s/${encodeURIComponent(themeSid)}/theme`;
    const sync = async () => {
      if (document.hidden) return;
      if (syncedThemeRef.current !== themeKey) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme: themePreference, systemDark }),
        });
        if (!response.ok) return;
        const { applied } = (await response.json()) as { applied: boolean };
        if (active && applied) syncedThemeRef.current = themeKey;
        return;
      }
      const response = await fetch(url);
      if (!response.ok) return;
      const { theme: remote } = (await response.json()) as { theme: ThemePreference | null };
      if (!active || remote === null || remote === themePreference) return;
      syncedThemeRef.current = `${remote}:${systemDark}`;
      setThemePreference(remote);
    };
    void sync().catch(() => {});
    const timer = setInterval(() => void sync().catch(() => {}), THEME_CHECK_MS);
    return () => {
      active = false;
      clearInterval(timer);
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
        const session = await requestClientSession(request, { signal: controller.signal });
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
  }, [bootstrapAttempt]);

  useEffect(() => {
    const timer = setInterval(() => setStatusNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // An open page outlives its session when the service restarts. While it cannot reconnect, check
  // whether the session still exists, and start over with a live one if it does not.
  const sessionUnreachable =
    clientPhase === "ready" && clientSession !== null && connection === "closed";
  useEffect(() => {
    if (!sessionUnreachable || clientSession === null) return;
    const sid = clientSession.sid;
    const timer = setInterval(() => {
      let clientKey: string;
      try {
        clientKey = prepareClientSession(
          new URL(window.location.href),
          window.sessionStorage,
          () => {},
        ).clientKey;
      } catch {
        return;
      }
      // Asking again returns this page's live session, a new one if the old one has ended.
      void requestClientSession({ clientKey, sid })
        .then((session) => {
          if (session.sid !== sid) setBootstrapAttempt((current) => current + 1);
        })
        .catch(() => {});
    }, SESSION_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sessionUnreachable, clientSession?.sid]);

  useEffect(() => {
    setStatusReachable(false);
    if (
      fixturePath !== null ||
      clientPhase === "ready" ||
      statusAuthRejected ||
      clientError?.status === 401 ||
      clientError?.status === 403
    )
      return;
    return pollServerStatus({
      onSample: (value) => {
        const now = Date.now();
        setStatusNow(now);
        setServerStatus((previous) => receiveServerStatus(previous, value, now));
      },
      onReachable: setStatusReachable,
      onAuthFailure: () => setStatusAuthRejected(true),
    });
  }, [clientPhase, clientError?.status, fixturePath, statusAuthRejected]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || clientPhase !== "ready") return;
    let disposed = false;
    const controller = new AbortController();
    let socket: GatewaySocket | null = null;
    let viewerId: string | null = null;
    let driver = false;
    let inputsReady = false;
    const inputStatus = (ready: boolean) => {
      if (disposed) return;
      inputsReady = ready;
      setInputReady(ready);
      host.inert = !ready;
    };
    inputStatus(false);
    let sessionId: string | null = null;
    let currentTab: TabId | null = null;
    const entryParams = new URLSearchParams(window.location.search);
    let entryMode: "dom" | "px" | null = pendingModeRef.current;
    pendingModeRef.current = null;
    const entryTab = entryParams.get("tab");
    const presentation = createPresentationState();
    const knownModes = new Map<TabId, "dom" | "px">();
    const autoStarted = new Set<string>();
    const dismissDownloadSoon = (id: string) => {
      const timer = setTimeout(() => {
        if (disposed) return;
        dismissedDownloadIdsRef.current.add(id);
        setDownloads((current) => dismissDownload(current, id));
      }, DOWNLOAD_NOTICE_MS);
      downloadTimers.add(timer);
    };
    const downloadTimers = new Set<ReturnType<typeof setTimeout>>();
    let reconnectPending = false;
    let viewportBeforeDisconnect: ReturnType<typeof presentation.currentViewport>;
    let pxView: PxView | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const reportViewport = () => {
      resizeTimer = null;
      if (disposed || !driver || currentTab === null) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (!presentation.needsViewport(currentTab, w, h, dpr)) return;
      inputStatus(false);
      presentation.requested(currentTab, w, h, dpr);
      socket?.send({ t: "view", tab: currentTab, w, h, dpr });
    };
    const scheduleViewport = (delay = 300) => {
      if (disposed) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(reportViewport, delay);
    };
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
        if (!disposed && driver && currentTab !== null)
          socket?.send({ t: "resync-req", tab: currentTab, reason: "editable-clear" });
      },
    });
    // A file input in the mirror opens its own picker, and the same click reaches the remote page.
    let mirrorPickerOpenedAt = Number.NEGATIVE_INFINITY;
    const uploads = createFileUploadRelay({
      onState: (state) => {
        if (!disposed) setUploadState(state);
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
    const scroll = createScrollFilter({ send: (message) => socket?.send(message) });
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
        const response = await fetch(`/s/${encodeURIComponent(sid)}/uploads/prepare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tab }),
          signal: request.signal,
        });
        const result = (await response.json()) as Extract<Down, { t: "filepick" }> & {
          error?: string;
        };
        if (disposed || request.signal.aborted) return;
        if (!response.ok) throw new Error(result.error || "远端附件入口尚未就绪");
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
      .use(echo)
      .use(scroll)
      .onReset(echo.reset)
      .onReset(scroll.reset);
    const restoreHooks = createRebuildRestoreHooks().use(echo.restoreHook);
    const clock = createServerClock({ bufferMs: DEFAULT_LIVE_BUFFER_MS });
    const resync = createResyncController({
      windowMs: configuredResyncWindowMs(),
      send: (message) => socket?.send(message),
      // Remote pictures are an explicit user choice; recovery must not start a stream.
      autoPx: () => undefined,
      onStateChange(state) {
        if (disposed) return;
        setResyncByTab((current) => ({ ...current, [state.tab]: state }));
      },
    });
    const mirror = createMirror({
      container: host,
      pipeline,
      clock,
      onBufferApplied: (buffer) => {
        if (!disposed) setBufferMs(buffer);
      },
      restoreHooks,
      rtc: {
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
        // A follower may receive the driver's viewport snapshot while its replay is scaled.
        // Never pre-ack that geometry: queued follower input must stay gated across a transfer.
        if (presentation.canAcknowledge(snapshot, currentTab, driver)) {
          socket?.send({ t: "view-ack", tab: snapshot.tab, epoch: snapshot.epoch });
          inputStatus(true);
        } else if (
          driver &&
          snapshot.tab === currentTab &&
          !inputsReady &&
          snapshot.reason !== "viewport"
        ) {
          scheduleViewport(0);
        }
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
            if (driver && inputsReady) socket?.send(message);
          },
          onEditableFocus: echo.setFocused,
          onEditableInput: echo.input,
          onKeyDown: echo.keyDown,
          onFileSelection: (tab, input) => {
            if (driver) uploads.select(tab, input);
            else input.value = "";
          },
          onFilePickerOpened: () => {
            mirrorPickerOpenedAt = Date.now();
          },
          onFilePickerCanceled: (tab) => uploads.cancelPick(tab),
          onPasteFiles: (tab, files) => {
            if (driver && sessionId !== null) void uploadPastedFiles(tab, files, sessionId);
          },
          scrollFilter: scroll,
        });
      },
    });
    mirrorRef.current = mirror;
    let activating: { tab: TabId; at: number } | null = null;
    const followTab = (tab: TabId) => {
      const tabChanged = currentTab !== tab;
      currentTab = tab;
      setActiveTab(tab);
      // The gateway stops a tab's picture when another becomes active, without a message
      // about the new one, so the view must follow what this tab is really showing.
      if (tabChanged) setViewMode(knownModes.get(tab) ?? entryMode ?? "dom");
      pxView?.selectTab(tab);
      if (mirror.getActiveTab() !== null && mirror.getActiveTab() !== tab) mirror.selectTab(tab);
      if (tabChanged) scheduleViewport(0);
    };
    // Before the click goes out, as the tab's snapshot can arrive ahead of the new tab list.
    activateTabRef.current = (tab) => {
      activating = { tab, at: Date.now() };
      followTab(tab);
    };
    let paintedFrames = 0;
    let gatewayFrames = { capture: 0, encode: 0, drop: 0 };
    const frameRateTimer = setInterval(() => {
      const display = paintedFrames;
      paintedFrames = 0;
      setFrameRates({ ...gatewayFrames, display });
    }, 1_000);
    const ensurePxView = (): PxView => {
      if (pxView !== null) return pxView;
      pxView = createPxView({
        container: host,
        send: (message) => {
          // Asking for a keyframe is about the picture, so it does not wait for input to unlock.
          if (driver && (inputsReady || message.t === "vid-key")) socket?.send(message);
        },
        onEnterPx: () => mirror.teardown(),
        onPaint: () => {
          paintedFrames++;
        },
      });
      if (currentTab !== null) pxView.selectTab(currentTab);
      pxViewRef.current = pxView;
      return pxView;
    };
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      mirror.refreshViewportLayout();
      scheduleViewport();
    });
    resizeObserver.observe(host);
    const onWindowResize = () => scheduleViewport();
    window.addEventListener("resize", onWindowResize);
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(frameRateTimer);
      controller.abort();
      driver = false;
      inputsReady = false;
      host.inert = true;
      for (const timer of downloadTimers) clearTimeout(timer);
      // A stale "ready" must not stay behind: the next connection unlocks input only after its own
      // hello and viewport agreement.
      if (mountedRef.current) setInputReady(false);
      socket?.close();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      socketRef.current = null;
      voiceRef.current?.setSender(null);
      mirrorRef.current = null;
      activateTabRef.current = null;
      pxViewRef.current = null;
      pxView?.destroy();
      pxView = null;
      resync.dispose();
      clipboard.dispose();
      uploads.dispose();
      uploadRef.current = null;
      uploadRequestRef.current?.abort();
      setUploadState(null);
      mirror.teardown();
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
          return;
        }

        if (message.t === "server-status") {
          const now = Date.now();
          setStatusNow(now);
          setServerStatus((previous) => receiveServerStatus(previous, message, now));
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
        presentation.observe(message);
        // Acknowledge receipt so the gateway paces frames to what this link actually delivers.
        if (message.t === "px") socket?.send({ t: "px-ack", tab: message.tab });
        if (
          message.t === "px" ||
          message.t === "vid" ||
          message.t === "vid-cfg" ||
          (message.t === "mode" && message.mode === "px")
        ) {
          ensurePxView().handle(message);
        } else if (message.t === "mode") {
          pxView?.handle(message);
        }
        if (message.t === "mode" && pictureHoldRef.current?.tab === message.tab)
          releasePictureHold(message.mode === "dom");
        const hold = pictureHoldRef.current;
        if (hold && presentation.shouldMirror(message, currentTab)) {
          hold.messages.push(message);
        } else if (presentation.shouldMirror(message, currentTab)) {
          mirror.handle(message);
        } else if (
          message.t === "snapshot" &&
          presentation.canAcknowledge(message, currentTab, driver)
        ) {
          // Pixel mode still acknowledges the viewport epoch, without rebuilding an iframe.
          socket?.send({ t: "view-ack", tab: message.tab, epoch: message.epoch });
          inputStatus(true);
        }
        if (
          message.t === "view-ok" &&
          driver &&
          message.tab === currentTab &&
          presentation.matchesViewport(message.tab, message.w, message.h)
        )
          inputStatus(true);
        if (message.t === "hello") {
          setInputFailures({});
          setPageStates({});
          const resumed =
            reconnectPending &&
            currentTab !== null &&
            !presentation.isPixel(currentTab) &&
            (message.resumed ?? []).includes(currentTab);
          if (reconnectPending) {
            reconnectPending = false;
            mirror.connectionRestored(resumed);
          }
          // A resumed replay keeps its negotiated geometry; anything else renegotiates (D7).
          if (resumed) presentation.restoreViewport(viewportBeforeDisconnect);
          else presentation.resetViewport();
          viewportBeforeDisconnect = undefined;
          viewerId = message.viewerId;
          sessionId = message.sessionId;
          setViewerId(message.viewerId);
          void fetch(`/s/${encodeURIComponent(message.sessionId)}/downloads`, {
            signal: controller.signal,
          })
            .then(async (response) => {
              if (!response.ok || disposed) return;
              const listed = (await response.json()) as DownloadEntry[];
              setDownloads(listed);
              // Finished before this page connected: offer the link briefly, never re-download.
              for (const entry of listed)
                if (entry.state !== "active") {
                  autoStarted.add(entry.id);
                  dismissDownloadSoon(entry.id);
                }
            })
            .catch(() => undefined);
          driver = message.role === "driver";
          if (driver) setDriverId(message.viewerId);
          if (resumed && driver) inputStatus(true);
          scheduleViewport(0);
        }
        if (message.t === "driver") {
          setDriverId(message.viewerId);
          const wasDriver = driver;
          driver = viewerId !== null && message.viewerId === viewerId;
          if (!driver) {
            uploads.clear();
            uploadRequestRef.current?.abort();
            inputStatus(false);
            presentation.resetViewport();
          }
          // Presence rebroadcasts the current driver on every join. Only a real role transition
          // needs a fresh measurement; resending an unchanged view rebuilds the remote epoch.
          if (driver && !wasDriver) {
            presentation.resetViewport();
            scheduleViewport(0);
          }
        }
        if (message.t === "presence") setViewers(message.viewers);
        if (message.t === "clip") {
          clipboard.write(message.text);
        }
        if (message.t === "snapshot" && currentTab === null) {
          // Join payloads contain background tabs too; only tabs.active selects thereafter.
          currentTab = message.tab;
          setActiveTab(message.tab);
          scheduleViewport(0);
        }
        if (message.t === "chrome") {
          setChromeByTab((current) => ({ ...current, [message.tab]: message }));
          setActiveTab((current) => current ?? message.tab);
        }
        if (message.t === "tab-state") {
          setPageStates((current) => ({ ...current, [message.tab]: message.state }));
          if (message.tab === currentTab) {
            inputStatus(false);
            if (message.state === "ready") {
              presentation.resetViewport();
              scheduleViewport(0);
            }
          }
        }
        if (message.t === "mode") {
          setModeByTab((current) => ({ ...current, [message.tab]: message.mode }));
          knownModes.set(message.tab, message.mode);
          if (message.tab === currentTab) setViewMode(message.mode);
          if (message.mode === "dom" && message.tab === currentTab) scheduleViewport(0);
        }
        if (message.t === "tabs") {
          setTabs(message.tabs);
          const active = message.tabs.find((tab) => tab.active);
          // A list sent before the gateway saw this viewer's click still names the old tab.
          const outdated =
            active !== undefined &&
            activating !== null &&
            activating.tab !== active.id &&
            Date.now() - activating.at < ACTIVATION_WAIT_MS;
          if (active !== undefined && !outdated) {
            activating = null;
            followTab(active.id);
            if (entryMode === "px" || entryMode === "dom") {
              const requestedMode = entryMode;
              entryMode = null;
              const tab = message.tabs.find((item) => item.id === entryTab)?.id ?? active.id;
              if (tab !== active.id) socket?.send({ t: "nav", tab, action: "activate" });
              socket?.send(
                requestedMode === "px"
                  ? {
                      t: "mode",
                      tab,
                      mode: "px",
                      quality: preferredPxQuality(viewStorage()),
                      ...videoOption(),
                    }
                  : { t: "mode", tab, mode: "dom" },
              );
            }
          }
        }
        if (message.t === "download" && !dismissedDownloadIdsRef.current.has(message.id)) {
          setDownloads((current) => updateDownloads(current, message));
          if (message.state === "done" && message.href && !autoStarted.has(message.id)) {
            autoStarted.add(message.id);
            startClientDownload(message.href, message.name);
            dismissDownloadSoon(message.id);
          }
        }
        if (message.t === "filepick" && driver && sessionId !== null) {
          uploads.handlePick(message, sessionId);
        }
      },
      {
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
        resumeParam() {
          if (currentTab === null || presentation.isPixel(currentTab)) return null;
          const cursor = mirror.resumeCursor();
          return cursor === null ? null : encodeResumeCursors([cursor]);
        },
        onStateChange(state, reconnected) {
          if (disposed) return;
          setConnection(state);
          if (state !== "open") {
            inputStatus(false);
            viewportBeforeDisconnect ??= presentation.currentViewport();
            presentation.resetViewport();
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
          if (state === "closed" && !presentation.isPixel(currentTab)) mirror.connectionLost();
          if (state === "open" && reconnected && !presentation.isPixel(currentTab)) {
            // `hello` says whether the gateway resumed this replay; recovery waits for it.
            // Content recovery does not unlock input before its viewport acknowledgement.
            reconnectPending = true;
          }
        },
        onProtocolError(error) {
          if (disposed) return;
          const tab = mirror.getActiveTab();
          if (tab !== null) resync.request(tab, error.message);
        },
      },
    );
    socketRef.current = socket;
    voiceRef.current?.setSender((message) => socket?.send(message));

    return cleanup;
  }, [clientPhase, clientSession?.sid, fixturePath]);

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
  const connectionLabel =
    clientPhase === "replaced"
      ? "已由另一页面接管"
      : clientPhase === "closed"
        ? "已结束"
        : clientPhase === "ending"
          ? "结束中"
          : clientPhase === "error"
            ? "未连接"
            : connection === "open"
              ? "已连接"
              : connection === "connecting"
                ? "连接中"
                : "重新连接中";

  const activeChrome = activeTab === null ? null : (chromeByTab[activeTab] ?? null);
  const shellStatus: { text: string; tone: "ok" | "busy" | "bad" } =
    clientPhase !== "ready"
      ? { text: connectionLabel, tone: clientPhase === "starting" ? "busy" : "bad" }
      : connection !== "open"
        ? { text: connectionLabel, tone: "busy" }
        : activeTab !== null && inputFailures[activeTab]
          ? { text: "输入未同步", tone: "bad" }
          : inputReady
            ? { text: "已连接", tone: "ok" }
            : { text: "同步中", tone: "busy" };
  const changeView = (mode: ViewMode, remember = true) => {
    if (remember) rememberViewMode(viewStorage(), mode);
    if (mode === viewMode) return;
    if (activeTab === null) {
      pendingModeRef.current = mode;
      setViewMode(mode);
      return;
    }
    if (mode === "px") holdMirrorForPicture(activeTab);
    socketRef.current?.send(
      mode === "px"
        ? { t: "mode", tab: activeTab, mode, quality: pxQuality, ...videoOption() }
        : { t: "mode", tab: activeTab, mode },
    );
    setViewMode(mode);
  };

  return (
    <div id="shell" data-theme={theme}>
      <ShellBar
        viewMode={(activeTab !== null && modeByTab[activeTab]) || viewMode}
        onViewMode={changeView}
        pixelAvailable={pixelAvailable}
        status={shellStatus}
        theme={themePreference}
        onTheme={setThemePreference}
        pxQuality={pxQuality}
        onPxQuality={(quality) => {
          setPxQuality(quality);
          viewStorage().setItem(PX_QUALITY_STORAGE_KEY, quality);
          // Applied right away in the pixel view, otherwise the next time it opens.
          if (pixelMode && activeTab !== null)
            socketRef.current?.send({
              t: "mode",
              tab: activeTab,
              mode: "px",
              quality,
              ...videoOption(),
            });
        }}
        serverStatus={serverStatus}
        rttMs={rttMs}
        speedBps={speedBps}
        frameRate={pixelMode ? (frameRates?.display ?? null) : null}
      >
        <TabStrip
          tabs={tabs}
          chromeByTab={chromeByTab}
          onActivate={(tab) => {
            activateTabRef.current?.(tab);
          }}
          send={(message) => socketRef.current?.send(message)}
        />
      </ShellBar>
      <UrlBar
        tab={activeTab}
        chrome={activeChrome}
        fallbackUrl={tabs.find((tab) => tab.id === activeTab)?.url ?? ""}
        send={(message) => socketRef.current?.send(message)}
      />
      <div id="shell-banners">
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
      {clientPhase !== "ready" && (
        <section
          id="client-session-overlay"
          class="client-session-overlay"
          data-phase={clientPhase}
          role={clientPhase === "error" || clientPhase === "replaced" ? "alert" : "status"}
        >
          <div class="client-session-card">
            <span class="session-eyebrow">共用账号 · 独立页面</span>
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
                        : clientError?.code === "CLIENT_CAPACITY"
                          ? "会话名额已占用"
                          : "暂时无法打开会话"
                      : "正在打开独立会话…"}
            </h1>
            <p>
              {clientPhase === "replaced"
                ? "当前页面已停止连接和输入，可在另一页面继续，或另开独立会话。"
                : clientPhase === "closed"
                  ? "当前页面已停止连接。点击重新开启后，才会再次申请会话。"
                  : clientPhase === "ending"
                    ? "已停止本页面的输入和连接，正在释放会话名额。"
                    : clientPhase === "error"
                      ? clientError?.message
                      : "共用当前 Claude 登录和浏览器数据，各自保留独立页面。首次打开可能需要一些时间。"}
            </p>
            <p class="session-policy">
              共用账号，历史、设置和额度共享。关闭网页后保留 60
              秒，随后自动回收；正在生成时暂缓。可选择结束会话立即释放名额。
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
              {clientPhase === "error" && endFailure && clientSession !== null && (
                <a href={clientReturnUrl(clientSession.sid)}>返回当前会话</a>
              )}
            </div>
          </div>
        </section>
      )}
      {clientPhase === "ready" && (
        <HudLayer
          connection={connection}
          rttMs={rttMs}
          bufferMs={bufferMs}
          activeTab={activeTab}
          tabs={tabs}
          modeByTab={modeByTab}
          resyncByTab={resyncByTab}
          speedBps={speedBps}
          peakSpeedBps={peakSpeedBps}
          frames={frameRates}
        />
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
        {uploadState !== null && uploadState.phase !== "choosing" && (
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
            {uploadState.phase === "uploading" && (
              <>
                <progress max={uploadState.total || 1} value={uploadState.loaded} />
                <small>{Math.round((uploadState.loaded / (uploadState.total || 1)) * 100)}%</small>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                uploadRequestRef.current?.abort();
                uploadRef.current?.cancel();
              }}
            >
              {uploadState.phase === "picking" || uploadState.phase === "uploading"
                ? "取消上传"
                : "关闭"}
            </button>
          </section>
        )}
        <DownloadTray
          downloads={downloads}
          error={downloadError}
          onCancel={async (id) => {
            if (!clientSession) return;
            setDownloadError(null);
            try {
              const response = await fetch(
                `/s/${encodeURIComponent(clientSession.sid)}/downloads/${encodeURIComponent(id)}`,
                { method: "DELETE" },
              );
              if (!response.ok) throw new Error("取消下载失败，请重试");
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
