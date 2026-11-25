/**
 * Which workspace panel is open. The admin, account, mailbox and network panels replace one
 * another; the profile picker is a layer of its own that the network panel's proxy manager can
 * open over.
 */
import { useReducer } from "preact/hooks";
import type { NetworkTab } from "../network-panel";
import type { WorkspaceDestination } from "../workspace-menu";

export type WorkspacePanel = "admin" | "account" | "mailboxes" | "network";

export interface PanelState {
  open: WorkspacePanel | null;
  /** The network panel's tab, kept while it is closed: 「网络与接入」 reopens on it. */
  networkTab: NetworkTab;
  pickerOpen: boolean;
}

export type PanelAction =
  /** From the workspace menu. `pickerAvailable`: a session is ready to switch profiles in. */
  | { type: "navigate"; destination: WorkspaceDestination; pickerAvailable: boolean }
  | { type: "open"; panel: WorkspacePanel; networkTab?: NetworkTab }
  /** Closes `panel` if it is the one open. */
  | { type: "close"; panel: WorkspacePanel }
  | { type: "network-tab"; tab: NetworkTab }
  | { type: "picker"; open: boolean }
  /** The network panel handed over to the browser: show the page. */
  | { type: "browser-opened" }
  /** A CPA authorization waits for the person to choose its browser in the picker. */
  | { type: "browser-chosen"; pickerAvailable: boolean }
  /** Back from the picker; with an authorization waiting, back to its CPA tab. */
  | { type: "picker-back"; authorizationWaiting: boolean };

export const initialPanels: PanelState = { open: null, networkTab: "proxies", pickerOpen: false };

function destinationPanel(destination: WorkspaceDestination): WorkspacePanel | null {
  switch (destination) {
    case "admin":
    case "account":
    case "mailboxes":
      return destination;
    case "network":
    case "proxies":
    case "cpa":
      return "network";
    case "profiles":
      return null;
  }
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "navigate": {
      const { destination } = action;
      return {
        open: destinationPanel(destination),
        // 「网络与接入」 opens on the tab last used; other callers name the tab.
        networkTab:
          destination === "proxies" || destination === "cpa" ? destination : state.networkTab,
        pickerOpen: destination === "profiles" && action.pickerAvailable ? true : state.pickerOpen,
      };
    }
    case "open":
      return {
        ...state,
        open: action.panel,
        networkTab: action.networkTab ?? state.networkTab,
      };
    case "close":
      return state.open === action.panel ? { ...state, open: null } : state;
    case "network-tab":
      return state.networkTab === action.tab ? state : { ...state, networkTab: action.tab };
    case "picker":
      return state.pickerOpen === action.open ? state : { ...state, pickerOpen: action.open };
    case "browser-opened":
      return {
        ...state,
        open: state.open === "network" ? null : state.open,
        pickerOpen: false,
      };
    case "browser-chosen":
      return {
        ...state,
        open: state.open === "network" ? null : state.open,
        pickerOpen: action.pickerAvailable,
      };
    case "picker-back":
      return action.authorizationWaiting
        ? { open: "network", networkTab: "cpa", pickerOpen: false }
        : { ...state, pickerOpen: false };
  }
}

export function usePanels() {
  return useReducer(panelReducer, initialPanels);
}
