/** The running mirror as the shell sees it: one reducer state and the actions the shell takes. */
import type { PxQuality, ServerStatusMsg, TabId, Up } from "@mirror/protocol";
import { useEffect, useReducer, useRef, type MutableRef } from "preact/hooks";
import {
  preferredViewMode,
  rememberViewMode,
  type ClientSession,
  type ViewMode,
} from "../client-session";
import { DEFAULT_LIVE_BUFFER_MS } from "../clock";
import { createVoiceLink, type VoiceLink } from "../media/voice";
import type { LinkTarget } from "../shell-bar";
import type { GatewayConnectionState } from "../ws";
import { startMirrorRuntime, type MirrorRuntime } from "./mirror-runtime";
import { initialRuntime, pixelModeOf, runtimeReducer, type RuntimeState } from "./runtime-state";
import { viewStorage } from "./view-storage";

export interface MirrorRuntimeHookOptions {
  hostRef: MutableRef<HTMLElement | null>;
  fileInputRef: MutableRef<HTMLInputElement | null>;
  /** The session is ready: run the mirror. */
  enabled: boolean;
  sid: ClientSession["sid"] | undefined;
  fixturePath: string | null;
  linkTarget: LinkTarget;
  onEnded(): void;
  onReplaced(): void;
}

export interface MirrorRuntimeControl {
  state: RuntimeState;
  send(message: Up): void;
  activate(tab: TabId): void;
  reconnect(): void;
  /** Sends the active tab's field value again; false when there is nothing to send. */
  resyncInput(): boolean;
  changeView(mode: ViewMode, quality: PxQuality, remember?: boolean): void;
  updateQuality(quality: PxQuality): void;
  receiveServerStatus(value: ServerStatusMsg): void;
  /** Closed here: it stays closed, also after a reconnect. */
  dismissDownload(id: string): void;
  selectFiles(tab: TabId, input: HTMLInputElement): void;
  cancelFilePick(tab: TabId): void;
  cancelUpload(): void;
  /** Stops the mirror without changing what is shown. */
  stop(): void;
  /** Stops the mirror and clears what it showed. */
  reset(connection: GatewayConnectionState): void;
}

export function useMirrorRuntime(options: MirrorRuntimeHookOptions): MirrorRuntimeControl {
  const { enabled, sid, fixturePath } = options;
  const [state, dispatch] = useReducer(runtimeReducer, undefined, () => {
    let viewMode: ViewMode;
    if (fixturePath !== null) viewMode = "dom";
    else {
      const requested = new URLSearchParams(window.location.search).get("mode");
      viewMode =
        requested === "dom" || requested === "px" ? requested : preferredViewMode(viewStorage());
    }
    return initialRuntime(viewMode, DEFAULT_LIVE_BUFFER_MS);
  });
  // The view the entry URL or memory asks for applies once tabs exist.
  const pendingModeRef = useRef<ViewMode | null>(state.viewMode);
  const runtimeRef = useRef<MirrorRuntime | null>(null);
  const mountedRef = useRef(false);
  const voiceRef = useRef<VoiceLink | null>(null);
  const dismissedDownloadIdsRef = useRef(new Set<string>());
  const connectionKey = useRef(globalThis.crypto.randomUUID()).current;
  const latest = useRef(options);
  latest.current = options;
  const pixelModeRef = useRef(false);
  pixelModeRef.current = pixelModeOf(state);
  const live = () => {
    const runtime = runtimeRef.current;
    return runtime === null || runtime.disposed ? null : runtime;
  };

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

  const activeTitle = state.tabs.find((tab) => tab.id === state.activeTab)?.title.trim() ?? "";
  useEffect(() => {
    document.title = activeTitle || "远程 Claude";
  }, [activeTitle]);

  // Keep the current view in the address so a reload reopens it.
  useEffect(() => {
    if (fixturePath !== null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("mode") === state.viewMode) return;
    url.searchParams.set("mode", state.viewMode);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [state.viewMode]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      live()?.dispose();
    };
  }, []);

  useEffect(() => {
    const host = options.hostRef.current;
    if (host === null || !enabled) return;
    const runtime = startMirrorRuntime({
      host,
      sid,
      fixturePath,
      entryMode: pendingModeRef.current,
      connectionKey,
      dispatch,
      isMounted: () => mountedRef.current,
      voice: () => voiceRef.current,
      linkTarget: () => latest.current.linkTarget,
      pixelMode: () => pixelModeRef.current,
      filePicker: () => options.fileInputRef.current,
      dismissedDownloads: dismissedDownloadIdsRef.current,
      onEnded: () => latest.current.onEnded(),
      onReplaced: () => latest.current.onReplaced(),
      onCreated: (created) => {
        runtimeRef.current = created;
        pendingModeRef.current = null;
      },
    });
    return () => {
      runtime.dispose();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [enabled, sid, fixturePath]);

  useEffect(() => {
    const report = () => {
      const socket = live()?.socket;
      socket?.setVisible(!document.hidden);
      if (!document.hidden) socket?.probe();
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

  const stop = () => live()?.dispose();

  return {
    state,
    send: (message) => live()?.socket?.send(message),
    activate: (tab) => live()?.presentation.activate(tab),
    reconnect: () => live()?.socket?.reconnect(),
    resyncInput: () =>
      state.activeTab === null ? false : (live()?.inputResync.resync(state.activeTab) ?? false),
    changeView(mode, quality, remember = true) {
      if (remember) rememberViewMode(viewStorage(), mode);
      if (mode === state.viewMode) return;
      const runtime = live();
      if (runtime) runtime.presentation.requestMode(mode, quality);
      else {
        pendingModeRef.current = mode;
        dispatch({ type: "view-mode", mode });
      }
    },
    updateQuality: (quality) => live()?.presentation.updateQuality(quality),
    receiveServerStatus: (value) => dispatch({ type: "server-status", value, now: Date.now() }),
    dismissDownload(id) {
      dismissedDownloadIdsRef.current.add(id);
      dispatch({ type: "dismiss-download", id });
    },
    selectFiles: (tab, input) => live()?.uploads.select(tab, input),
    cancelFilePick: (tab) => live()?.uploads.cancelPick(tab),
    cancelUpload() {
      const runtime = live();
      runtime?.abortUploadRequest();
      runtime?.uploads.cancel();
    },
    stop,
    reset(connection) {
      stop();
      dispatch({ type: "reset", connection });
    },
  };
}
