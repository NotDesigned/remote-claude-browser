export interface AppleAttempt {
  browser: object;
  control: AbortController;
  tab?: string;
}

const ATTEMPT_MS = 10 * 60_000;
const CANCELED_MS = 75_000;

export function createAppleAttempts() {
  const attempts = new Map<string, { attempt?: AppleAttempt; timer: NodeJS.Timeout }>();
  const keyOf = (sid: string, id: string) => JSON.stringify([sid, id.toLowerCase()]);

  function forget(key: string) {
    const entry = attempts.get(key);
    if (!entry) return;
    attempts.delete(key);
    clearTimeout(entry.timer);
    entry.attempt?.control.abort();
  }

  function remember(key: string, attempt?: AppleAttempt) {
    const timer = setTimeout(() => forget(key), attempt ? ATTEMPT_MS : CANCELED_MS).unref();
    attempts.set(key, { attempt, timer });
  }

  return {
    start(sid: string, id: string, browser: object) {
      const key = keyOf(sid, id);
      if (attempts.has(key)) return undefined;
      const attempt: AppleAttempt = { browser, control: new AbortController() };
      remember(key, attempt);
      return attempt;
    },
    get(sid: string, id: string) {
      return attempts.get(keyOf(sid, id))?.attempt;
    },
    refresh(sid: string, id: string) {
      const key = keyOf(sid, id);
      const entry = attempts.get(key);
      if (!entry?.attempt) return;
      clearTimeout(entry.timer);
      remember(key, entry.attempt);
    },
    cancel(sid: string, id: string) {
      const key = keyOf(sid, id);
      const entry = attempts.get(key);
      if (entry && !entry.attempt) return;
      forget(key);
      // DELETE can arrive before the opening POST after the wizard closes.
      remember(key);
    },
    close() {
      for (const key of attempts.keys()) forget(key);
    },
  };
}

export async function untilCanceled<T>(signal: AbortSignal | undefined, work: () => Promise<T>) {
  if (!signal) return work();
  signal.throwIfAborted();
  let abort!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
