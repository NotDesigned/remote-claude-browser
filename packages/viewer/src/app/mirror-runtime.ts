/**
 * One running mirror: the gateway socket, the presentation (page or pixel view), uploads,
 * downloads, clipboard, voice and build-skew reloads. It reports everything the shell shows as
 * RuntimeActions; useMirrorRuntime keeps those in a reducer and starts one of these per session.
 */
import type {
  AgentMsg,
  Down,
  eventWithTime,
  InputAckMsg,
  ResumeCursor,
  TabId,
} from "@mirror/protocol";
import {
  CAP_LIVE_TREE,
  EventType,
  IncrementalSource,
  LOCAL_RESYNC_REASON,
  MAX_HELD_TABS,
  editHash,
} from "@mirror/protocol";
import { apiRequest } from "../api";
import { DOWNLOAD_NOTICE_MS, startClientDownload } from "../auto-download";
import { createBuildSkew } from "../build-skew";
import { createClipboardWriter } from "../chrome/clipboard";
import type { DownloadEntry } from "../chrome/downloads";
import {
  clientGatewayUrl,
  preferredPxQuality,
  type ClientSession,
  type ViewMode,
} from "../client-session";
import { createServerClock, DEFAULT_LIVE_BUFFER_MS } from "../clock";
import { attachMirrorInput } from "../input";
import { externalLink } from "../input/default-actions";
import { deepActiveElement, isTextEditable } from "../input/keys";
import { createInputResync, focusedValueMessage, type InputResync } from "../input/resync-input";
import { createInputSequencer, type InputLabStats, type SettledAck } from "../input/input-seq";
import {
  createPredictOverlay,
  createProxyLab,
  type OverlayState,
  type ProxyLab,
} from "../input/predict-overlay";
import { createProxyInput, type ProxyInput } from "../input/proxy-input";
import { inputModeOverride } from "./input-mode";
import type { VoiceLink } from "../media/voice";
import { createMirror, type Mirror } from "../mirror";
import { EventPipeline } from "../pipeline";
import { createEchoFilter, localFieldText } from "../pipeline/echo";
import {
  createScrollFilter,
  replayScrollPosition,
  watchReplayScrollRestores,
} from "../pipeline/scroll";
import { createPresentation } from "../presentation";
import { createRebuildRestoreHooks } from "../rebuild-restore";
import { createResyncController, RESYNC_WINDOW_MS } from "../resync";
import type { LinkTarget } from "../shell-bar";
import { createFileUploadRelay, type FileUploadRelay } from "../uploads";
import { connectGateway, type GatewaySocket } from "../ws";
import type { RuntimeAction } from "./runtime-state";
import { viewStorage } from "./view-storage";

/** How long after a click on a mirror file input the page's file request belongs to that click. */
const MIRROR_PICKER_WINDOW_MS = 5_000;
/** The tab a fixture replay shows. */
export const FIXTURE_TAB = "fixture-tab";
/** Acks and stamps the inputlab keeps for smokes to read, newest last. */
const INPUT_LAB_LOG = 4_000;

/** What `window.__mirrorInputLab` offers with ?inputlab=1 (smokes and the HUD read it). */
export interface InputLabHandle {
  stats(): InputLabStats;
  /** Every input-ack received, as received. */
  acks: InputAckMsg[];
  /** Every ack as it settled, after the replay applied it. */
  settled: Array<SettledAck & { at: number; localHash?: string }>;
  /** The newest iseq sent per tab on this connection. */
  lastStamped(tab: TabId): number;
  outstanding(tab: TabId): number;
  /**
   * Every typing echo window as it closed: how long after the field's last key, and what closed
   * it (an ack, the ack mode's liveness ceiling, or the decay timer).
   */
  windows: Array<{
    tab: TabId | null;
    nodeId: number;
    ms: number;
    how: "ack" | "liveness" | "decay";
    at: number;
  }>;
  caps(): { acks: boolean; echo: boolean; proxy: boolean };
  /** Single-writer input (predict-overlay.ts, proxy-input.ts). */
  proxy: {
    active(): boolean;
    lab: ProxyLab;
    state(): OverlayState;
    model(): ReturnType<ProxyInput["model"]>;
    element(): HTMLElement;
  };
}

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
  const tab = FIXTURE_TAB;
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

/** This tab's own memory; sessionStorage itself throws when site data is blocked. */
function sessionStorageOrNull(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export interface MirrorRuntimeOptions {
  host: HTMLElement;
  /** The client session; a fixture page has none. */
  sid: ClientSession["sid"] | undefined;
  /** Replay this recording instead of connecting. */
  fixturePath: string | null;
  /** The view the entry address or memory asks for, applied once tabs exist. */
  entryMode: ViewMode | null;
  /** This page's identity across reconnects. */
  connectionKey: string;
  dispatch(action: RuntimeAction): void;
  /** The shell is still on the page. */
  isMounted(): boolean;
  voice(): VoiceLink | null;
  linkTarget(): LinkTarget;
  /** The active tab is in pixel mode: only then are frame rates sampled. */
  pixelMode(): boolean;
  /** The shell's hidden file input, opened for a remote file request. */
  filePicker(): HTMLInputElement | null;
  /** Downloads closed on this page: they stay closed after a reconnect. */
  dismissedDownloads: Set<string>;
  /** The gateway ended the session. */
  onEnded(): void;
  /** Another page took the session over; this runtime has stopped. */
  onReplaced(): void;
  /** The runtime exists and can be stopped, before it connects. */
  onCreated(runtime: MirrorRuntime): void;
}

export interface MirrorRuntime {
  disposed: boolean;
  socket: GatewaySocket | null;
  presentation: ReturnType<typeof createPresentation>;
  inputResync: InputResync;
  uploads: FileUploadRelay;
  /** Stops staging a pasted file, if one is on its way. */
  abortUploadRequest(): void;
  /** Stops everything; safe to call more than once. */
  dispose(): void;
}

export function startMirrorRuntime(options: MirrorRuntimeOptions): MirrorRuntime {
  const { host, dispatch, fixturePath, dismissedDownloads } = options;
  let disposed = false;
  const controller = new AbortController();
  let socket: GatewaySocket | null = null;
  let sessionId: string | null = null;
  let uploadRequest: AbortController | null = null;
  const pageUrls = new Map<TabId, string>();
  const autoStarted = new Set<string>();
  const shownDownloads = new Set<string>();
  const showDownload = (id: string) => {
    if (disposed || shownDownloads.has(id)) return;
    shownDownloads.add(id);
    dispatch({ type: "shown-downloads", ids: new Set(shownDownloads) });
  };
  const dismissDownloadSoon = (id: string) => {
    const timer = setTimeout(() => {
      if (disposed) return;
      dismissedDownloads.add(id);
      dispatch({ type: "dismiss-download", id });
    }, DOWNLOAD_NOTICE_MS);
    downloadTimers.add(timer);
  };
  const downloadTimers = new Set<ReturnType<typeof setTimeout>>();
  const clipboard = createClipboardWriter({
    onCopied: () => {
      if (!disposed) dispatch({ type: "clipboard-error", message: null });
    },
    onError: () => {
      if (!disposed)
        dispatch({ type: "clipboard-error", message: "复制失败，请允许浏览器访问剪贴板" });
    },
  });
  // A page from before a deploy reloads into the new build when that interrupts nothing.
  const buildSkew = createBuildSkew({
    busy: () => {
      if (uploading) return true;
      const active = deepActiveElement(document);
      return active !== null && active !== document.body && isTextEditable(active);
    },
    reload: () => window.location.reload(),
    onStale: (stale) => {
      if (!disposed) dispatch({ type: "build-stale", stale });
    },
    storage: sessionStorageOrNull(),
  });
  /** Text typed this recently may not have reached the page yet. */
  const EDITABLE_TYPING_MS = 400;
  const inputLabOn = new URLSearchParams(window.location.search).get("inputlab") === "1";
  const sequencer = createInputSequencer({
    // Acks settle once the replay in view has played everything they cover.
    mark: (tab, played) => mirror.mark(tab, played),
  });
  const activeTab = () => mirror.getActiveTab();
  // Single-writer input: on when the gateway offers it and this viewer drives, unless this tab
  // asked for the legacy way.
  const inputOverride = inputModeOverride(window.location.search, sessionStorageOrNull());
  const proxyActive = () =>
    inputOverride !== "legacy" &&
    sequencer.enabled() &&
    sequencer.proxyEnabled() &&
    presentation.isDriver();
  const proxyLab = createProxyLab();
  const replayNode = (id: number) => mirror.getReplayer()?.getMirror().getNode(id) ?? null;
  const predictOverlay = createPredictOverlay({
    doc: document,
    node: replayNode,
    rtt: sequencer.rtt,
    ...(inputLabOn ? { lab: proxyLab } : {}),
    resend: (text) => {
      const tab = activeTab();
      if (tab !== null && presentation.canInput(tab, "dom"))
        socket?.send({ t: "text", tab, insert: text });
    },
    putBack: (text) => proxyInput.putBack(text),
  });
  const proxyInput = createProxyInput({
    doc: document,
    tab: activeTab,
    send: (message) =>
      "tab" in message && presentation.canInput(message.tab, "dom")
        ? (socket?.send(message) ?? false)
        : false,
    lastStamped: sequencer.lastStamped,
    outstanding: sequencer.outstanding,
    overlay: predictOverlay,
    node: replayNode,
    idOf: (node) => mirror.getReplayer()?.getMirror().getId(node) ?? -1,
    replaySelection: () => {
      const root = mirror.getReplayer()?.iframe.contentDocument;
      return root?.getSelection()?.toString() ?? "";
    },
    onPasteFiles: (files) => {
      const tab = activeTab();
      if (tab !== null && presentation.canInput(tab, "dom") && sessionId !== null)
        void uploadPastedFiles(tab, files, sessionId);
    },
    ...(inputLabOn ? { lab: proxyLab } : {}),
  });
  let replayAppliedFrame: number | null = null;
  /** An IME composition is open in the replay (see attachInteraction). */
  let composing = false;
  const echo = createEchoFilter({
    composing: () => composing,
    onWindowClosed: (closed) => {
      if (!inputLabOn) return;
      inputLab.windows.push({ ...closed, tab: activeTab(), at: performance.now() });
      if (inputLab.windows.length > INPUT_LAB_LOG) inputLab.windows.shift();
    },
    acks: {
      enabled: sequencer.echoEnabled,
      subscribe: (listener) =>
        sequencer.subscribe((settled) => {
          if (settled.tab === activeTab()) listener(settled);
        }),
      outstanding: () => {
        const tab = activeTab();
        return tab === null ? 0 : sequencer.outstanding(tab);
      },
      lastStamped: () => {
        const tab = activeTab();
        return tab === null ? 0 : sequencer.lastStamped(tab);
      },
      count: sequencer.count,
    },
    // The reason asks the gateway to answer this page alone from its cached state, not every
    // viewer from a new page snapshot; the mirror takes only the focused editor from it.
    onContenteditableReconcile: () => {
      const tab = presentation.activeTab();
      if (tab === null || !presentation.canInput(tab, "dom") || mirror.getActiveTab() !== tab)
        return false;
      mirror.reconcileEditable(LOCAL_RESYNC_REASON);
      return true;
    },
    nodeFor: (id) => mirror.getReplayer()?.getMirror().getNode(id) ?? null,
  });
  // A file input in the mirror opens its own picker, and the same click reaches the remote page.
  let mirrorPickerOpenedAt = Number.NEGATIVE_INFINITY;
  let uploading = false;
  const uploads = createFileUploadRelay({
    // A finished upload needs no notice: the page shows the attachment itself.
    onState: (state) => {
      uploading = state?.phase === "uploading" || state?.phase === "picking";
      if (!disposed) dispatch({ type: "upload", state: state?.phase === "done" ? null : state });
    },
    openPicker: (multiple) => {
      if (Date.now() - mirrorPickerOpenedAt < MIRROR_PICKER_WINDOW_MS) return true;
      const input = options.filePicker();
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
  const scroll = createScrollFilter({
    send(message) {
      if (presentation.canInput(message.tab, "dom")) socket?.send(message);
    },
    position: (nodeId) => replayScrollPosition(mirror.getReplayer(), nodeId),
  });
  // Pasted images become attachments of the remote page: stage the files, then open the
  // remote attachment input. Its `filepick` (also published over the socket) pairs with them.
  const uploadPastedFiles = async (tab: TabId, files: File[], sid: string): Promise<void> => {
    uploadRequest?.abort();
    const request = new AbortController();
    uploadRequest = request;
    uploads.selectFiles(tab, files);
    dispatch({
      type: "upload",
      state: {
        tab,
        phase: "uploading",
        multiple: files.length > 1,
        loaded: 0,
        total: 0,
        name: `正在把粘贴的${files.length > 1 ? ` ${files.length} 个文件` : "图片"}作为附件传到远端…`,
      },
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
      dispatch({
        type: "upload",
        state: {
          tab,
          phase: "error",
          multiple: false,
          loaded: 0,
          total: 0,
          name: `粘贴的附件未能上传：${error instanceof Error ? error.message : "请重试"}`,
        },
      });
    } finally {
      if (uploadRequest === request) uploadRequest = null;
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
    send: (message) => socket?.send(message) ?? false,
    onStateChange(state) {
      if (disposed) return;
      dispatch({ type: "resync", state });
    },
  });
  /** The gateway keeps each tab's current DOM (hello.caps tree1). */
  let liveTree = false;
  const sendHeld = (cursors: readonly ResumeCursor[]) => {
    if (!liveTree) return;
    socket?.send({
      t: "held",
      tabs: cursors
        .slice(0, MAX_HELD_TABS)
        .map((cursor) => [cursor.tab, cursor.epoch, cursor.nextSeq] as [string, number, number]),
    });
  };
  const mirror = createMirror({
    container: host,
    pipeline,
    clock,
    // Each hidden tab costs this browser its page's memory, which a phone has least of.
    parkedTabs: /\bMobi/.test(navigator.userAgent) ? 1 : 2,
    onBufferApplied: (buffer) => {
      if (!disposed) dispatch({ type: "buffer", ms: buffer });
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
    // The gateway spaces these out itself, and they rebuild nothing. With the live tree, naming
    // the editor gets just its subtree back.
    requestCatchUp: (tab, reason, node) =>
      socket?.send({
        t: "resync-req",
        tab,
        reason,
        ...(liveTree && node !== undefined ? { node } : {}),
      }) ?? false,
    // Synchronous, so that it always comes before the tab activation it may precede.
    onHeldChange: (cursors) => sendHeld(cursors),
    editableBusy: () => echo.typingWithin(EDITABLE_TYPING_MS),
    onApplied: (tab, epoch, nextSeq) => {
      sequencer.applied(tab, epoch, nextSeq);
      // The page may have changed the field by itself (a late clear): reseed once per frame.
      if (replayAppliedFrame === null && proxyActive())
        replayAppliedFrame = requestAnimationFrame(() => {
          replayAppliedFrame = null;
          proxyInput.replayApplied();
        });
    },
    onEditablePatched: () => echo.settled(),
    watchReplayer: (_tab, replayer) => watchReplayScrollRestores(replayer, scroll),
    attachInteraction(tab, replayer) {
      // A press inside the mirror happens in its frame, out of the page's listeners' sight.
      const frame = replayer.iframe.contentWindow;
      const unlock = () => options.voice()?.unlock();
      frame?.addEventListener("pointerdown", unlock, true);
      frame?.addEventListener("keydown", unlock, true);
      const compositionStart = () => (composing = true);
      const compositionEnd = () => {
        if (!composing) return;
        composing = false;
        echo.compositionEnded();
      };
      // Some IMEs never send compositionend: input that is not part of a composition ends it all
      // the same. Leaving the field does not: a keyboard may commit the word after the blur.
      const inputEvent = (event: Event) => {
        if ((event as InputEvent).isComposing === false) compositionEnd();
      };
      frame?.addEventListener("compositionstart", compositionStart, true);
      frame?.addEventListener("compositionend", compositionEnd, true);
      frame?.addEventListener("input", inputEvent, true);
      // A parked page gets its interaction again each time it is shown: these must not pile up.
      const unlockCleanup = () => {
        frame?.removeEventListener("pointerdown", unlock, true);
        frame?.removeEventListener("keydown", unlock, true);
        frame?.removeEventListener("compositionstart", compositionStart, true);
        frame?.removeEventListener("compositionend", compositionEnd, true);
        frame?.removeEventListener("input", inputEvent, true);
        compositionEnd();
      };
      // A new replay of the page: the overlay measures again once an ack settles on it.
      predictOverlay.replayChanged();
      const detachInput = attachMirrorInput({
        replayer,
        tab,
        proxy: { active: proxyActive, input: proxyInput },
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
          options.linkTarget() === "device" ? externalLink(target, pageUrls.get(tab)) : null,
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
      return () => {
        unlockCleanup();
        detachInput();
      };
    },
  });
  let paintedFrames = 0;
  let gatewayFrames = { capture: 0, encode: 0, drop: 0 };
  const presentation = createPresentation({
    host,
    mirror,
    send: (message) => socket?.send(message),
    entryTab: new URLSearchParams(window.location.search).get("tab"),
    entryMode: options.entryMode,
    preferredQuality: () => preferredPxQuality(viewStorage()),
    onTab: (tab) => {
      proxyInput.flush();
      dispatch({ type: "active-tab", tab });
    },
    onViewMode: (mode) => dispatch({ type: "view-mode", mode }),
    onTabMode: (tab, mode) => dispatch({ type: "tab-mode", tab, mode }),
    onInputReady: (ready) => {
      if (options.isMounted()) dispatch({ type: "input-ready", ready });
    },
    onPaint: () => paintedFrames++,
  });
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
    ackMode: sequencer.echoEnabled,
  });
  const inputLab: InputLabHandle = {
    stats: sequencer.stats,
    acks: [],
    settled: [],
    lastStamped: sequencer.lastStamped,
    outstanding: sequencer.outstanding,
    caps: () => ({
      acks: sequencer.enabled(),
      echo: sequencer.echoEnabled(),
      proxy: proxyActive(),
    }),
    windows: [],
    proxy: {
      active: proxyActive,
      lab: proxyLab,
      state: predictOverlay.state,
      model: proxyInput.model,
      element: () => proxyInput.element,
    },
  };
  sequencer.subscribe((settled) => {
    if (settled.tab === activeTab() && proxyActive()) proxyInput.settled(settled);
    inputResync.settled(settled.tab, settled.failedValue);
    // Shadow measurement: at a burst's final ack, does this replay's field hash as the page's?
    let localHash: string | undefined;
    const edit = settled.edit;
    if (settled.final && edit && edit.node >= 0 && edit.hash !== "") {
      const node = mirror.getReplayer()?.getMirror().getNode(edit.node) ?? null;
      if (node !== null && mirror.getActiveTab() === settled.tab) {
        localHash = editHash(localFieldText(node as HTMLElement));
        sequencer.count(localHash === edit.hash ? "hashMatchAtFinal" : "hashMismatchAtFinal");
      }
    }
    if (inputLabOn) {
      inputLab.settled.push({
        ...settled,
        at: performance.now(),
        ...(localHash ? { localHash } : {}),
      });
      if (inputLab.settled.length > INPUT_LAB_LOG) inputLab.settled.shift();
    }
  });
  if (inputLabOn)
    (window as Window & { __mirrorInputLab?: InputLabHandle }).__mirrorInputLab = inputLab;
  // Frame rates only mean something in the pixel view: elsewhere, do not redraw the page for them.
  let sampledFrames = false;
  const frameRateTimer = setInterval(() => {
    const sample = options.pixelMode();
    if (sample)
      dispatch({ type: "frame-rates", rates: { ...gatewayFrames, display: paintedFrames } });
    else if (sampledFrames) dispatch({ type: "frame-rates", rates: null });
    sampledFrames = sample;
    paintedFrames = 0;
    if (inputLabOn && sequencer.enabled())
      dispatch({ type: "input-lab", stats: sequencer.stats() });
  }, 1_000);
  const resizeObserver = new ResizeObserver(presentation.resized);
  resizeObserver.observe(host);
  window.addEventListener("resize", presentation.resized);

  const runtime: MirrorRuntime = {
    disposed: false,
    socket: null,
    presentation,
    inputResync,
    uploads,
    abortUploadRequest: () => uploadRequest?.abort(),
    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.disposed = true;
      clearInterval(frameRateTimer);
      controller.abort();
      for (const timer of downloadTimers) clearTimeout(timer);
      socket?.close();
      resizeObserver.disconnect();
      window.removeEventListener("resize", presentation.resized);
      runtime.socket = null;
      options.voice()?.setSender(null);
      presentation.dispose();
      proxyInput.dispose();
      predictOverlay.dispose();
      if (replayAppliedFrame !== null) cancelAnimationFrame(replayAppliedFrame);
      inputResync.dispose();
      resync.dispose();
      clipboard.dispose();
      buildSkew.dispose();
      uploads.dispose();
      uploadRequest?.abort();
      dispatch({ type: "upload", state: null });
      if (options.isMounted()) dispatch({ type: "pixel-available", available: true });
    },
  };
  options.onCreated(runtime);

  if (fixturePath !== null) {
    dispatch({ type: "active-tab", tab: FIXTURE_TAB });
    dispatch({ type: "connection", state: "open" });
    void replayFixture(fixturePath, mirror, controller.signal).catch((error: unknown) => {
      if (disposed) return;
      host.dataset.mirrorState = "error";
      host.textContent = error instanceof Error ? error.message : String(error);
    });
    return runtime;
  }

  const receive = (message: Down) => {
    if (disposed) return;
    const voice = options.voice();
    if (message.t === "audio") {
      voice?.play(message.pcm);
      return;
    }
    if (message.t === "mic") {
      voice?.setMic(message.tab, message.on);
      return;
    }
    if (message.t === "input-ack") {
      if (inputLabOn) {
        inputLab.acks.push(message);
        if (inputLab.acks.length > INPUT_LAB_LOG) inputLab.acks.shift();
      }
      sequencer.onAck(message);
      return;
    }
    if (message.t === "input-status") {
      dispatch({
        type: "input-status",
        tab: message.tab,
        failed: message.failed,
        reason: message.reason,
      });
      inputResync.status(message.tab, message.failed);
      return;
    }
    if (message.t === "cpa-oauth") {
      dispatch({ type: "oauth", tab: message.tab, status: message.status });
      return;
    }
    if (message.t === "server-status") {
      dispatch({ type: "server-status", value: message, now: Date.now() });
      return;
    }
    if (message.t === "px-capacity")
      dispatch({ type: "pixel-available", available: message.available });
    if (message.t === "px-stats") {
      gatewayFrames = {
        capture: message.captureFps,
        encode: message.encodeFps,
        drop: message.dropFps,
      };
      return;
    }
    // A new connection numbers its input from 1 again, and says whether acks are on.
    if (message.t === "hello") {
      sequencer.hello(message.caps);
      liveTree = message.caps?.includes(CAP_LIVE_TREE) ?? false;
      // The inputlab keeps one connection's acks: their numbers start again with it.
      inputLab.acks.length = 0;
      inputLab.settled.length = 0;
    }
    presentation.handle(message);
    // What this page still holds, for a connection that has just begun.
    if (message.t === "hello") sendHeld(mirror.heldCursors());
    if (message.t === "hello") {
      buildSkew.observe(message.build);
      sessionId = message.sessionId;
      dispatch({ type: "hello", viewerId: message.viewerId, driver: message.role === "driver" });
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
          const listed = response.filter((entry) => !dismissedDownloads.has(entry.id));
          dispatch({ type: "downloads", downloads: listed });
          // Finished before this page connected: offer the link briefly, never re-download.
          for (const entry of listed) {
            autoStarted.add(entry.id);
            showDownload(entry.id);
            if (entry.state !== "active") dismissDownloadSoon(entry.id);
          }
        })
        .catch(() => undefined);
    }
    if (message.t === "driver") {
      dispatch({ type: "driver", viewerId: message.viewerId });
      if (!presentation.isDriver()) {
        // Another viewer drives now: this one types nothing and predicts nothing.
        proxyInput.flush();
        proxyInput.blur();
        predictOverlay.clear();
        uploads.clear();
        uploadRequest?.abort();
      }
    }
    if (message.t === "presence") dispatch({ type: "presence", viewers: message.viewers });
    if (message.t === "clip") {
      clipboard.write(message.text);
    }
    if (message.t === "chrome") {
      pageUrls.set(message.tab, message.url);
      dispatch({ type: "chrome", message });
    }
    if (message.t === "tab-state")
      dispatch({ type: "page-state", tab: message.tab, state: message.state });
    if (message.t === "tabs") dispatch({ type: "tabs", tabs: message.tabs });
    if (message.t === "download" && !dismissedDownloads.has(message.id)) {
      dispatch({ type: "download", message });
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
        else dispatch({ type: "dismiss-download", id: message.id });
      }
    }
    if (message.t === "filepick" && presentation.isDriver() && sessionId !== null) {
      uploads.handlePick(message, sessionId);
    }
  };

  socket = connectGateway(clientGatewayUrl(window.location.href, options.sid), receive, {
    visible: !document.hidden,
    connectionKey: options.connectionKey,
    onRttSample(sample) {
      if (disposed) return;
      mirror.observeRtt(sample);
      dispatch({ type: "rtt", ms: sample });
    },
    onSpeedSample(sample) {
      if (disposed) return;
      dispatch({ type: "speed", bps: sample });
    },
    resumeParam: presentation.resumeParam,
    stamp: sequencer.stamp,
    onStateChange(state, reconnected) {
      if (disposed) return;
      if (state !== "open") {
        // What was not acknowledged may not have arrived: offered again, never resent by itself.
        predictOverlay.connectionLost();
        sequencer.connectionLost();
      }
      dispatch({ type: "connection", state });
      presentation.connectionChanged(state, reconnected);
      if (state === "ended") {
        options.onEnded();
        return;
      }
      if (state === "replaced") {
        runtime.dispose();
        dispatch({ type: "reset", connection: "replaced" });
        options.onReplaced();
        return;
      }
    },
    onProtocolError(error) {
      // Not a replay failure: a garbled delta shows up as a sequence gap, which recovers
      // on its own. Asking for a snapshot here only turned build skew into resync storms.
      if (!disposed) console.warn("mirror: undecodable gateway message", error);
    },
  });
  runtime.socket = socket;
  options.voice()?.setSender((message) => socket?.send(message));
  return runtime;
}
