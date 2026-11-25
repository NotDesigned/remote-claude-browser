/**
 * What the shell shows about the running mirror: connection, tabs and their modes, presence,
 * input health, transfers and link quality. useMirrorRuntime feeds it from the gateway socket and
 * the presentation; everything here is a pure function of those events.
 */
import type { Down, ServerStatusMsg, TabId } from "@mirror/protocol";
import type { ViewMode } from "../client-session";
import { dismissDownload, updateDownloads, type DownloadEntry } from "../chrome/downloads";
import type { FrameRates } from "../hud";
import type { ResyncTabState } from "../resync";
import { receiveServerStatus, type ReceivedServerStatus } from "../server-status";
import type { UploadState } from "../uploads";
import type { GatewayConnectionState } from "../ws";
import { patch } from "./patch";

export type TabList = Extract<Down, { t: "tabs" }>["tabs"];
export type ChromeMessage = Extract<Down, { t: "chrome" }>;
export type Viewers = Extract<Down, { t: "presence" }>["viewers"];
export type PageState = Extract<Down, { t: "tab-state" }>["state"];
export type OAuthCallback = Extract<Down, { t: "cpa-oauth" }>["status"];

export interface RuntimeState {
  connection: GatewayConnectionState;
  inputReady: boolean;
  inputFailures: Record<TabId, boolean>;
  /** Why each failed tab's field sync failed, for the UI to show beside 「输入未同步」. */
  inputFailureReasons: Record<TabId, string>;
  pageStates: Record<TabId, PageState>;
  activeTab: TabId | null;
  tabs: TabList;
  modeByTab: Record<TabId, ViewMode | undefined>;
  /** The view asked for: the shell's switch shows it until the active tab has a mode. */
  viewMode: ViewMode;
  pixelAvailable: boolean;
  resyncByTab: Record<TabId, ResyncTabState | undefined>;
  rttMs: number | null;
  speedBps: number | null;
  peakSpeedBps: number | null;
  frameRates: FrameRates | null;
  bufferMs: number;
  viewerId: string | null;
  driverId: string | null;
  viewers: Viewers;
  clipboardError: string | null;
  buildStale: boolean;
  downloads: DownloadEntry[];
  /** Downloads offered in the tray; the others save without a notice. */
  shownDownloadIds: ReadonlySet<string>;
  uploadState: UploadState | null;
  chromeByTab: Record<TabId, ChromeMessage | undefined>;
  oauthCallbacks: Record<TabId, OAuthCallback>;
  serverStatus: ReceivedServerStatus | null;
}

export type RuntimeAction =
  | { type: "connection"; state: GatewayConnectionState }
  | { type: "input-ready"; ready: boolean }
  | { type: "input-status"; tab: TabId; failed: boolean; reason?: string }
  | { type: "oauth"; tab: TabId; status: OAuthCallback }
  | { type: "server-status"; value: ServerStatusMsg; now: number }
  | { type: "pixel-available"; available: boolean }
  /** A (re)connection's greeting: per-connection state starts over. */
  | { type: "hello"; viewerId: string; driver: boolean }
  | { type: "driver"; viewerId: string | null }
  | { type: "presence"; viewers: Viewers }
  | { type: "chrome"; message: ChromeMessage }
  | { type: "page-state"; tab: TabId; state: PageState }
  | { type: "tabs"; tabs: TabList }
  | { type: "downloads"; downloads: DownloadEntry[] }
  | { type: "download"; message: DownloadEntry }
  | { type: "dismiss-download"; id: string }
  | { type: "shown-downloads"; ids: ReadonlySet<string> }
  | { type: "upload"; state: UploadState | null }
  | { type: "resync"; state: ResyncTabState }
  | { type: "buffer"; ms: number }
  | { type: "rtt"; ms: number }
  | { type: "speed"; bps: number }
  | { type: "frame-rates"; rates: FrameRates | null }
  | { type: "clipboard-error"; message: string | null }
  | { type: "build-stale"; stale: boolean }
  | { type: "active-tab"; tab: TabId | null }
  | { type: "view-mode"; mode: ViewMode }
  | { type: "tab-mode"; tab: TabId; mode: ViewMode }
  /** The mirror stopped (session over, or taken by another page): nothing of it stays shown. */
  | { type: "reset"; connection: GatewayConnectionState };

export function initialRuntime(viewMode: ViewMode, bufferMs: number): RuntimeState {
  return {
    connection: "connecting",
    inputReady: false,
    inputFailures: {},
    inputFailureReasons: {},
    pageStates: {},
    activeTab: null,
    tabs: [],
    modeByTab: {},
    viewMode,
    pixelAvailable: true,
    resyncByTab: {},
    rttMs: null,
    speedBps: null,
    peakSpeedBps: null,
    frameRates: null,
    bufferMs,
    viewerId: null,
    driverId: null,
    viewers: [],
    clipboardError: null,
    buildStale: false,
    downloads: [],
    shownDownloadIds: new Set(),
    uploadState: null,
    chromeByTab: {},
    oauthCallbacks: {},
    serverStatus: null,
  };
}

export function runtimeReducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  switch (action.type) {
    case "connection":
      return patch(state, { connection: action.state });
    case "input-ready":
      return patch(state, { inputReady: action.ready });
    case "input-status": {
      const inputFailureReasons = { ...state.inputFailureReasons };
      if (action.failed)
        inputFailureReasons[action.tab] = action.reason ?? "远端页面未接受这次输入";
      else delete inputFailureReasons[action.tab];
      return {
        ...state,
        inputFailures: { ...state.inputFailures, [action.tab]: action.failed },
        inputFailureReasons,
      };
    }
    case "oauth":
      return {
        ...state,
        oauthCallbacks: { ...state.oauthCallbacks, [action.tab]: action.status },
      };
    case "server-status":
      return patch(state, {
        serverStatus: receiveServerStatus(state.serverStatus, action.value, action.now),
      });
    case "pixel-available":
      return patch(state, { pixelAvailable: action.available });
    case "hello":
      // The gateway follows `hello` with the input-status of every tab still failed.
      return {
        ...state,
        oauthCallbacks: {},
        inputFailures: {},
        inputFailureReasons: {},
        pageStates: {},
        viewerId: action.viewerId,
        driverId: action.driver ? action.viewerId : state.driverId,
      };
    case "driver":
      return patch(state, { driverId: action.viewerId });
    case "presence":
      return patch(state, { viewers: action.viewers });
    case "chrome":
      return {
        ...state,
        chromeByTab: { ...state.chromeByTab, [action.message.tab]: action.message },
      };
    case "page-state":
      return { ...state, pageStates: { ...state.pageStates, [action.tab]: action.state } };
    case "tabs":
      return patch(state, { tabs: action.tabs });
    case "downloads":
      return patch(state, { downloads: action.downloads });
    case "download":
      return { ...state, downloads: updateDownloads(state.downloads, action.message) };
    case "dismiss-download":
      return { ...state, downloads: dismissDownload(state.downloads, action.id) };
    case "shown-downloads":
      return patch(state, { shownDownloadIds: action.ids });
    case "upload":
      return patch(state, { uploadState: action.state });
    case "resync":
      return { ...state, resyncByTab: { ...state.resyncByTab, [action.state.tab]: action.state } };
    case "buffer":
      return patch(state, { bufferMs: action.ms });
    case "rtt":
      return patch(state, { rttMs: action.ms });
    case "speed":
      return patch(state, {
        speedBps: action.bps,
        peakSpeedBps: Math.max(state.peakSpeedBps ?? 0, action.bps),
      });
    case "frame-rates":
      return patch(state, { frameRates: action.rates });
    case "clipboard-error":
      return patch(state, { clipboardError: action.message });
    case "build-stale":
      return patch(state, { buildStale: action.stale });
    case "active-tab":
      return patch(state, { activeTab: action.tab });
    case "view-mode":
      return patch(state, { viewMode: action.mode });
    case "tab-mode":
      return { ...state, modeByTab: { ...state.modeByTab, [action.tab]: action.mode } };
    case "reset":
      return patch(state, {
        connection: action.connection,
        inputReady: false,
        activeTab: null,
        tabs: [],
        viewers: [],
        viewerId: null,
        driverId: null,
        downloads: [],
      });
  }
}

/** The active tab is in pixel mode. */
export function pixelModeOf(state: Pick<RuntimeState, "activeTab" | "modeByTab">): boolean {
  return state.activeTab !== null && state.modeByTab[state.activeTab] === "px";
}

/** The gateway's short reason while the active tab's input is not synced. */
export function inputFailureReasonOf(
  state: Pick<RuntimeState, "activeTab" | "inputFailures" | "inputFailureReasons">,
): string | undefined {
  return state.activeTab !== null && state.inputFailures[state.activeTab]
    ? state.inputFailureReasons[state.activeTab]
    : undefined;
}
