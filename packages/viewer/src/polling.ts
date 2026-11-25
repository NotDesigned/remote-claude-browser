import { useEffect, useRef, useState } from "preact/hooks";

/** Polling shared by the panels: no overlapping requests, stale answers dropped, errors cleared. */
export interface PollerOptions<T> {
  load(): Promise<T>;
  intervalMs: number;
  onData(value: T): void;
  /** The last poll's failure, or null once a poll succeeds again. */
  onError(message: string | null): void;
  /** While true, scheduled polls are skipped (a hidden tab). */
  isHidden?(): boolean;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Polls now; an answer still on its way from before is dropped. Never rejects. */
  refresh(): Promise<void>;
  /** The page became visible again: poll now rather than at the next tick. */
  resume(): void;
}

export const failureMessage = (failure: unknown, fallback = "加载失败，请稍后重试。") =>
  failure instanceof Error && failure.message ? failure.message : fallback;

export function createPoller<T>(options: PollerOptions<T>): Poller {
  let running = false;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (running) timer = setTimeout(tick, options.intervalMs);
  };
  const run = async () => {
    const sequence = ++latest;
    clear();
    let value: T;
    try {
      value = await options.load();
    } catch (failure) {
      if (!running || sequence !== latest) return;
      options.onError(failureMessage(failure));
      schedule();
      return;
    }
    if (!running || sequence !== latest) return;
    options.onError(null);
    options.onData(value);
    schedule();
  };
  function tick() {
    timer = null;
    if (!running) return;
    if (options.isHidden?.()) schedule();
    else void run();
  }
  return {
    start() {
      if (running) return;
      running = true;
      void run();
    },
    stop() {
      running = false;
      latest++;
      clear();
    },
    refresh: () => (running ? run() : Promise.resolve()),
    resume() {
      if (running && !options.isHidden?.()) void run();
    },
  };
}

const documentHidden = () => typeof document !== "undefined" && document.hidden;

function onVisible(resume: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const listener = () => {
    if (!document.hidden) resume();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export interface PollingOptions {
  /** Poll only while true (for example while the panel is open). Default true. */
  enabled?: boolean;
  /** Skip polls while the tab is hidden and poll again as it comes back. Default true. */
  pauseWhenHidden?: boolean;
  /** A change starts over: the data so far belongs to the previous key. */
  key?: unknown;
}

export interface Polling<T> {
  data: T | undefined;
  /** The last poll's failure; null after a successful poll. Separate from action messages. */
  error: string | null;
  refresh(): Promise<void>;
  /** Local changes (after an action) until the next poll. */
  setData(update: T | undefined | ((current: T | undefined) => T | undefined)): void;
}

export function usePolling<T>(
  load: () => Promise<T>,
  intervalMs: number,
  { enabled = true, pauseWhenHidden = true, key }: PollingOptions = {},
): Polling<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const poller = useRef<Poller | null>(null);
  const shownKey = useRef(key);
  if (shownKey.current !== key) {
    shownKey.current = key;
    // Read during this render: the previous key's data must not flash under the new one.
    if (data !== undefined) setData(undefined);
    if (error !== null) setError(null);
  }
  useEffect(() => {
    if (!enabled) return;
    const current = createPoller({
      load: () => loadRef.current(),
      intervalMs,
      onData: (value) => setData(() => value),
      onError: setError,
      isHidden: pauseWhenHidden ? documentHidden : undefined,
    });
    poller.current = current;
    current.start();
    const stopVisible = pauseWhenHidden ? onVisible(current.resume) : () => undefined;
    return () => {
      stopVisible();
      current.stop();
      if (poller.current === current) poller.current = null;
    };
  }, [enabled, intervalMs, pauseWhenHidden, key]);
  return {
    data,
    error,
    refresh: () => poller.current?.refresh() ?? Promise.resolve(),
    setData,
  };
}

export interface SharedPollState<T> {
  data: T | undefined;
  error: string | null;
}

/**
 * One poll that several components read: it runs while anyone subscribes, and each subscriber
 * sees the same answers instead of polling the same API on its own.
 */
export interface SharedPoll<T> {
  subscribe(listener: (state: SharedPollState<T>) => void): () => void;
  state(): SharedPollState<T>;
  refresh(): Promise<void>;
}

export function createSharedPoll<T>(
  load: () => Promise<T>,
  intervalMs: number,
  options: { isHidden?(): boolean; watchVisibility?(resume: () => void): () => void } = {},
): SharedPoll<T> {
  const listeners = new Set<(state: SharedPollState<T>) => void>();
  let state: SharedPollState<T> = { data: undefined, error: null };
  const publish = (next: SharedPollState<T>) => {
    state = next;
    for (const listener of [...listeners]) listener(state);
  };
  const poller = createPoller({
    load,
    intervalMs,
    onData: (data) => publish({ data, error: null }),
    onError: (error) => {
      if (error !== state.error) publish({ ...state, error });
    },
    isHidden: options.isHidden ?? documentHidden,
  });
  let stopVisible: (() => void) | null = null;
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        poller.start();
        stopVisible = (options.watchVisibility ?? onVisible)(poller.resume);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        poller.stop();
        stopVisible?.();
        stopVisible = null;
      };
    },
    state: () => state,
    refresh: () => poller.refresh(),
  };
}

export function useSharedPoll<T>(source: SharedPoll<T>, enabled = true): SharedPollState<T> {
  const [state, setState] = useState(source.state);
  useEffect(() => {
    if (!enabled) return;
    setState(source.state());
    return source.subscribe(setState);
  }, [source, enabled]);
  return state;
}
