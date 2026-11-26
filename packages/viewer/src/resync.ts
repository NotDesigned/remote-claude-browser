/**
 * Per-tab divergence recovery policy.
 *
 * Mirror owns the mechanical Replayer swap. This controller owns when a recovery request may
 * leave the viewer: repeated requests back off, and a full rolling window delays the next request
 * until a slot opens. Recovery never permanently disables a tab or changes its display mode.
 */
import type { TabId, Up } from "@mirror/protocol";

export const RESYNC_WINDOW_MS = 30_000;
export const MAX_RESYNCS_PER_WINDOW = 3;
export const RESYNC_BACKOFF_BASE_MS = 250;
export const RESYNC_BACKOFF_MAX_MS = 5_000;
/** How soon a request the socket could not send (it was connecting) is tried again. */
export const RESYNC_UNSENT_RETRY_MS = 1_000;

export interface ResyncTabState {
  tab: TabId;
  /** Requests actually sent to the gateway during this viewer lifetime. */
  totalResyncs: number;
  /** Requests sent inside the current rolling window. */
  recentResyncs: number;
  pending: boolean;
  backoffMs: number;
  /** The pending request is waiting for space in the rolling rate limit. */
  storm: boolean;
}

export interface ResyncControllerOptions {
  /** Returns false when the message could not be sent; it is then tried again shortly. */
  send(message: Extract<Up, { t: "resync-req" }>): unknown;
  onStateChange?(state: ResyncTabState): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  windowMs?: number;
  maxResyncs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface ResyncController {
  /** Returns false when an equivalent request is already pending. */
  request(tab: TabId, reason: string): boolean;
  /** Cancel a not-yet-sent request when another epoch repaired the mirror first. */
  recovered(tab: TabId): void;
  getState(tab: TabId): ResyncTabState;
  states(): ResyncTabState[];
  dispose(): void;
}

interface MutableTabState {
  sentAt: number[];
  totalResyncs: number;
  storm: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pendingReason: string | null;
  backoffMs: number;
}

export function createResyncController(options: ResyncControllerOptions): ResyncController {
  const now = options.now ?? Date.now;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const windowMs = positiveInteger("windowMs", options.windowMs ?? RESYNC_WINDOW_MS);
  const maxResyncs = positiveInteger("maxResyncs", options.maxResyncs ?? MAX_RESYNCS_PER_WINDOW);
  const backoffBaseMs = positiveInteger(
    "backoffBaseMs",
    options.backoffBaseMs ?? RESYNC_BACKOFF_BASE_MS,
  );
  const backoffMaxMs = positiveInteger(
    "backoffMaxMs",
    options.backoffMaxMs ?? RESYNC_BACKOFF_MAX_MS,
  );
  if (backoffMaxMs < backoffBaseMs) {
    throw new RangeError("backoffMaxMs must be greater than or equal to backoffBaseMs");
  }

  const tabs = new Map<TabId, MutableTabState>();
  let disposed = false;

  const mutable = (tab: TabId): MutableTabState => {
    let state = tabs.get(tab);
    if (state === undefined) {
      state = {
        sentAt: [],
        totalResyncs: 0,
        storm: false,
        timer: null,
        pendingReason: null,
        backoffMs: 0,
      };
      tabs.set(tab, state);
    }
    prune(state, now(), windowMs);
    return state;
  };

  const snapshot = (tab: TabId, state = mutable(tab)): ResyncTabState => ({
    tab,
    totalResyncs: state.totalResyncs,
    recentResyncs: state.sentAt.length,
    pending: state.pendingReason !== null,
    backoffMs: state.backoffMs,
    storm: state.storm,
  });

  const notify = (tab: TabId, state: MutableTabState): void => {
    options.onStateChange?.(snapshot(tab, state));
  };

  const wait = (tab: TabId, state: MutableTabState, delayMs: number): void => {
    state.backoffMs = delayMs;
    state.timer = schedule(() => dispatch(tab, state), delayMs);
    state.timer.unref?.();
    notify(tab, state);
  };

  const dispatch = (tab: TabId, state: MutableTabState): void => {
    state.timer = null;
    const reason = state.pendingReason;
    if (disposed || reason === null) return;
    prune(state, now(), windowMs);
    if (state.sentAt.length >= maxResyncs) {
      state.storm = true;
      wait(tab, state, state.sentAt[0]! + windowMs - now());
      return;
    }
    // A socket that is connecting drops what it is given; the request stays pending until sent.
    if (options.send({ t: "resync-req", tab, reason }) === false) {
      wait(tab, state, RESYNC_UNSENT_RETRY_MS);
      return;
    }
    state.pendingReason = null;
    state.storm = false;
    state.sentAt.push(now());
    state.totalResyncs += 1;
    state.backoffMs = 0;
    notify(tab, state);
  };

  return {
    request(tab, reason) {
      if (disposed) return false;
      const state = mutable(tab);
      if (state.pendingReason !== null) return false;
      state.pendingReason = reason;
      state.storm = state.sentAt.length >= maxResyncs;
      const delayMs = state.storm
        ? state.sentAt[0]! + windowMs - now()
        : state.sentAt.length === 0
          ? 0
          : Math.min(backoffMaxMs, backoffBaseMs * 2 ** (state.sentAt.length - 1));
      if (delayMs === 0) dispatch(tab, state);
      else wait(tab, state, delayMs);
      return true;
    },
    recovered(tab) {
      const state = tabs.get(tab);
      if (state === undefined || state.pendingReason === null) return;
      if (state.timer !== null) cancel(state.timer);
      state.timer = null;
      state.pendingReason = null;
      state.backoffMs = 0;
      state.storm = false;
      notify(tab, state);
    },
    getState(tab) {
      return snapshot(tab);
    },
    states() {
      return [...tabs].map(([tab, state]) => snapshot(tab, state));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of tabs.values()) {
        if (state.timer !== null) cancel(state.timer);
      }
      tabs.clear();
    },
  };
}

function prune(state: MutableTabState, at: number, windowMs: number): void {
  const cutoff = at - windowMs;
  while (state.sentAt.length > 0 && state.sentAt[0]! <= cutoff) state.sentAt.shift();
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
