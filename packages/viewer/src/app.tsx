/** Viewer shell layout. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentMsg, Down, eventWithTime, TabId } from "@mirror/protocol";
import { EventType } from "@mirror/protocol";
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
import { HudLayer } from "./hud";
import {
  pollServerStatus,
  receiveServerStatus,
  ServerStatusBar,
  type ReceivedServerStatus,
} from "./server-status";
import { createServerClock, DEFAULT_LIVE_BUFFER_MS } from "./clock";
import { createResyncController, type ResyncTabState, RESYNC_WINDOW_MS } from "./resync";
import { connectGateway, type GatewayConnectionState, type GatewaySocket } from "./ws";
import { createFileUploadRelay, type FileUploadRelay, type UploadState } from "./uploads";
import { createPresentationState } from "./presentation";
import {
  ClientSessionError,
  clientChatUrl,
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

export function App() {
  const uploadRef = useRef<FileUploadRelay | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef<AbortController | null>(null);
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const hostRef = useRef<HTMLElement>(null);
  const socketRef = useRef<GatewaySocket | null>(null);
  const mirrorRef = useRef<Mirror | null>(null);
  const pxViewRef = useRef<PxView | null>(null);
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
  const [statusReachable, setStatusReachable] = useState(false);
  const [statusAuthRejected, setStatusAuthRejected] = useState(false);
  const [statusNow, setStatusNow] = useState(Date.now);
  const [inputReady, setInputReady] = useState(false);
  const [inputFailures, setInputFailures] = useState<Record<TabId, boolean>>({});
  const [pageStates, setPageStates] = useState<Record<TabId, "recovering" | "ready" | "failed">>(
    {},
  );
  const [activeTab, setActiveTab] = useState<TabId | null>(null);
  const [tabs, setTabs] = useState<Extract<Down, { t: "tabs" }>["tabs"]>([]);
  const [modeByTab, setModeByTab] = useState<Record<TabId, "dom" | "px" | undefined>>({});
  const [pixelAvailable, setPixelAvailable] = useState(true);
  const [resyncByTab, setResyncByTab] = useState<Record<TabId, ResyncTabState | undefined>>({});
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [bufferMs, setBufferMs] = useState(DEFAULT_LIVE_BUFFER_MS);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [viewers, setViewers] = useState<Extract<Down, { t: "presence" }>["viewers"]>([]);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return window.localStorage.getItem("mirror.theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  const [chromeByTab, setChromeByTab] = useState<
    Record<TabId, Extract<Down, { t: "chrome" }> | undefined>
  >({});
  const activeTitle = tabs.find((tab) => tab.id === activeTab)?.title.trim() ?? "";

  useEffect(() => {
    document.title = activeTitle || "远程浏览器";
  }, [activeTitle]);

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
    try {
      window.localStorage.setItem("mirror.theme", theme);
    } catch {
      // Keep the selected theme for this page even when storage is unavailable.
    }
  }, [theme]);

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
    let entryMode = entryParams.get("mode");
    const entryTab = entryParams.get("tab");
    const presentation = createPresentationState();
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
    const uploads = createFileUploadRelay({
      onState: (state) => {
        if (!disposed) setUploadState(state);
      },
    });
    uploadRef.current = uploads;
    const scroll = createScrollFilter({ send: (message) => socket?.send(message) });
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
          scrollFilter: scroll,
        });
      },
    });
    mirrorRef.current = mirror;
    const ensurePxView = (): PxView => {
      if (pxView !== null) return pxView;
      pxView = createPxView({
        container: host,
        send: (message) => {
          if (driver && inputsReady) socket?.send(message);
        },
        onEnterPx: () => mirror.teardown(),
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
      controller.abort();
      driver = false;
      inputsReady = false;
      host.inert = true;
      socket?.close();
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      socketRef.current = null;
      mirrorRef.current = null;
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
        presentation.observe(message);
        if (message.t === "px" || (message.t === "mode" && message.mode === "px")) {
          ensurePxView().handle(message);
        } else if (message.t === "mode") {
          pxView?.handle(message);
        }
        if (presentation.shouldMirror(message, currentTab)) {
          mirror.handle(message);
        } else if (
          message.t === "snapshot" &&
          presentation.canAcknowledge(message, currentTab, driver)
        ) {
          // Pixel mode still acknowledges the viewport epoch, without rebuilding an iframe.
          socket?.send({ t: "view-ack", tab: message.tab, epoch: message.epoch });
          inputStatus(true);
        }
        if (message.t === "hello") {
          setInputFailures({});
          setPageStates({});
          presentation.resetViewport();
          viewerId = message.viewerId;
          sessionId = message.sessionId;
          setViewerId(message.viewerId);
          void fetch(`/s/${encodeURIComponent(message.sessionId)}/downloads`, {
            signal: controller.signal,
          })
            .then(async (response) => {
              if (response.ok && !disposed) setDownloads(await response.json());
            })
            .catch(() => undefined);
          driver = message.role === "driver";
          if (driver) setDriverId(message.viewerId);
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
          if (message.mode === "dom" && message.tab === currentTab) scheduleViewport(0);
        }
        if (message.t === "tabs") {
          setTabs(message.tabs);
          const active = message.tabs.find((tab) => tab.active);
          if (active !== undefined) {
            const tabChanged = currentTab !== active.id;
            currentTab = active.id;
            setActiveTab(active.id);
            pxView?.selectTab(active.id);
            if (mirror.getActiveTab() !== null && mirror.getActiveTab() !== active.id) {
              mirror.selectTab(active.id);
            }
            if (tabChanged) scheduleViewport(0);
            if (entryMode === "px" || entryMode === "dom") {
              const requestedMode = entryMode;
              entryMode = null;
              const tab = message.tabs.find((item) => item.id === entryTab)?.id ?? active.id;
              if (tab !== active.id) socket?.send({ t: "nav", tab, action: "activate" });
              socket?.send({ t: "mode", tab, mode: requestedMode });
              const url = new URL(window.location.href);
              url.searchParams.delete("mode");
              url.searchParams.delete("tab");
              window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
            }
          }
        }
        if (message.t === "download" && !dismissedDownloadIdsRef.current.has(message.id)) {
          setDownloads((current) => updateDownloads(current, message));
        }
        if (message.t === "filepick" && driver && sessionId !== null) {
          uploads.handlePick(message, sessionId);
        }
      },
      {
        onRttSample(sample) {
          if (disposed) return;
          mirror.observeRtt(sample);
          setRttMs(sample);
        },
        onStateChange(state, reconnected) {
          if (disposed) return;
          setConnection(state);
          if (state !== "open") {
            inputStatus(false);
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
            // The new hello forces geometry negotiation for the new viewer identity.
            // Content recovery does not unlock input before its viewport acknowledgement.
            mirror.connectionRestored();
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

  return (
    <div id="shell" data-theme={theme}>
      <TabStrip
        tabs={tabs}
        chromeByTab={chromeByTab}
        onActivate={(tab) => {
          pxViewRef.current?.selectTab(tab);
          if (modeByTab[tab] !== "px") mirrorRef.current?.selectTab(tab);
          setActiveTab(tab);
        }}
        send={(message) => socketRef.current?.send(message)}
      />
      <UrlBar
        tab={activeTab}
        chrome={activeTab === null ? null : (chromeByTab[activeTab] ?? null)}
        fallbackUrl={tabs.find((tab) => tab.id === activeTab)?.url ?? ""}
        send={(message) => socketRef.current?.send(message)}
      />
      <header id="connection-state" data-state={connection}>
        <span id="input-state" role="status" data-ready={inputReady ? "true" : "false"}>
          {clientPhase === "replaced"
            ? "当前页面已停止操作"
            : clientPhase === "closed"
              ? "会话已结束"
              : clientPhase === "ending"
                ? "已停止操作"
                : clientPhase === "error"
                  ? "未建立操作连接"
                  : activeTab !== null && inputFailures[activeTab]
                    ? "输入尚未同步，稍后重试发送"
                    : inputReady
                      ? "可操作"
                      : "同步中，暂不可操作"}
        </span>
        <span class="connection-badge">{connectionLabel}</span>
        {clipboardError && (
          <span class="clipboard-error" role="status" title={clipboardError}>
            复制失败
          </span>
        )}
        {activeTab !== null && pageStates[activeTab] && pageStates[activeTab] !== "ready" && (
          <span id="page-recovery-state" role="alert">
            {pageStates[activeTab] === "recovering"
              ? "远程网页已崩溃，正在恢复…"
              : "远程网页恢复失败，请点击地址栏的刷新按钮"}
          </span>
        )}
        {fixturePath !== null && (
          <Presence
            viewers={viewers}
            viewerId={viewerId}
            driverId={driverId}
            send={(message) => socketRef.current?.send(message)}
          />
        )}
        <select
          id="view-mode-select"
          aria-label="浏览模式"
          value={pixelMode ? "px" : "dom"}
          disabled={activeTab === null}
          onChange={(event) => {
            const mode = event.currentTarget.value;
            if (mode === "chat") {
              window.location.assign(clientChatUrl(clientSession?.sid ?? null, activeTab));
            } else if (activeTab !== null && (mode === "dom" || mode === "px")) {
              socketRef.current?.send({ t: "mode", tab: activeTab, mode });
            }
          }}
        >
          <option value="chat">文字聊天</option>
          <option value="dom">DOM 模式</option>
          <option value="px" disabled={!pixelMode && !pixelAvailable}>
            {!pixelAvailable && !pixelMode ? "图像模式（已占用）" : "图像模式"}
          </option>
        </select>
        <button
          id="theme-toggle"
          type="button"
          aria-pressed={theme === "dark"}
          title="切换浅色／深色界面"
          onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
        >
          {theme === "light" ? "浅色" : "深色"}
        </button>
        <ServerStatusBar
          sample={serverStatus}
          live={clientPhase === "ready" ? connection === "open" : statusReachable}
          now={statusNow}
        />
      </header>
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
                      : "共用当前 Claude 登录，各自保留独立页面和输入。首次打开可能需要一些时间。"}
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
              {clientPhase === "error" &&
                (clientError?.status === 401 || clientError?.status === 403) && (
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
          viewerId={viewerId}
          driverId={driverId}
        />
      )}
      <aside id="transfer-panels" aria-label="文件与剪贴板">
        {uploadState !== null && (
          <section id="upload-panel" role="status">
            <span>{uploadState.name}</span>
            {uploadState.phase === "picking" && (
              <>
                <input
                  ref={fileInputRef}
                  id="local-file-picker"
                  type="file"
                  multiple={uploadState.multiple}
                  hidden
                  onChange={(event) =>
                    uploadRef.current?.select(uploadState.tab, event.currentTarget)
                  }
                />
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
