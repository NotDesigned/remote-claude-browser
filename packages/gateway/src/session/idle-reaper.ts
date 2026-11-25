/**
 * True while Claude is writing a reply into a page, which closing the page would cut short. Only
 * claude.ai counts: any other site may well have a visible "stop" button forever. Claude Code
 * shows the same button, but its work runs on another machine and goes on without the page.
 */
export const PAGE_GENERATING_EXPRESSION = `(() => /(^|\\.)claude\\.ai$/.test(location.hostname) && !/^\\/code(\\/|$)/.test(location.pathname) && [...document.querySelectorAll('button')].some(e => e.getClientRects().length > 0 && /stop|停止/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('data-testid') || ''))))()`;

/** A busy page holds its workspace at most this long after its last viewer left. */
export const MAX_BUSY_OFFLINE_MS = 30 * 60_000;

export interface IdleSession {
  sid: string;
  /** Stable record identity, replaced whenever the workspace is assigned to another owner. */
  token: unknown;
}

export interface IdleReaperOptions {
  sessions(): readonly IdleSession[];
  isOnline(sid: string): boolean;
  isBusy(sid: string): Promise<boolean>;
  release(sid: string, token: unknown): Promise<void>;
  now?: () => number;
  graceMs?: number;
  /** Offline this long, a workspace is released even while a page still reports being busy. */
  maxBusyOfflineMs?: number;
  onError?: (error: unknown) => void;
}

interface IdleState {
  token: unknown;
  offlineSince: number | null;
  generation: number;
}

/** Timer-free maintenance helper: callers decide when to sweep and signal reconnects via touch. */
export function createIdleReaper(options: IdleReaperOptions): {
  touch(sid: string): void;
  sweep(): Promise<void>;
  dispose(): void;
} {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? 60_000;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0)
    throw new RangeError("graceMs must be a non-negative safe integer");
  const busyLimit = options.maxBusyOfflineMs ?? MAX_BUSY_OFFLINE_MS;
  if (!Number.isSafeInteger(busyLimit) || busyLimit < 0)
    throw new RangeError("maxBusyOfflineMs must be a non-negative safe integer");
  // A grace period configured longer than the limit is never cut short by it.
  const maxBusyOfflineMs = Math.max(busyLimit, graceMs);
  const states = new Map<string, IdleState>();
  let disposed = false;
  let pending: Promise<void> | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      /* Reporting cannot break later maintenance. */
    }
  };
  const reset = (state: IdleState) => {
    state.offlineSince = null;
    state.generation++;
  };

  const run = async () => {
    let sessions: readonly IdleSession[];
    try {
      sessions = options.sessions();
    } catch (error) {
      report(error);
      return;
    }
    const present = new Set(sessions.map((record) => record.sid));
    for (const sid of states.keys()) if (!present.has(sid)) states.delete(sid);
    for (const record of sessions) {
      if (disposed) return;
      try {
        let state = states.get(record.sid);
        if (state === undefined || !Object.is(state.token, record.token)) {
          state = { token: record.token, offlineSince: null, generation: 0 };
          states.set(record.sid, state);
        }
        if (options.isOnline(record.sid)) {
          reset(state);
          continue;
        }
        const at = now();
        if (state.offlineSince === null || at < state.offlineSince) state.offlineSince = at;
        if (at - state.offlineSince < graceMs) continue;
        const generation = state.generation;
        // A page that never stops looking busy must not hold its workspace forever.
        const capped = at - state.offlineSince >= maxBusyOfflineMs;
        const busy = !capped && (await options.isBusy(record.sid));
        if (disposed || states.get(record.sid) !== state || state.generation !== generation)
          continue;
        const current = options.sessions().find((entry) => entry.sid === record.sid);
        if (current === undefined || !Object.is(current.token, record.token)) {
          states.delete(record.sid);
          continue;
        }
        if (options.isOnline(record.sid)) {
          reset(state);
          continue;
        }
        if (busy) continue;
        await options.release(record.sid, record.token);
        if (states.get(record.sid) === state && state.generation === generation)
          states.delete(record.sid);
      } catch (error) {
        // Failed busy checks/releases retain the original grace window for the next sweep.
        report(error);
      }
    }
  };

  return {
    touch(sid) {
      if (disposed) return;
      const state = states.get(sid);
      if (state !== undefined) reset(state);
    },
    sweep() {
      if (disposed) return Promise.resolve();
      pending ??= run().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    dispose() {
      disposed = true;
      states.clear();
    },
  };
}
