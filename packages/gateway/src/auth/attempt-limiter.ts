/**
 * Limits password checks. Each key (a client IP, a user) has at most one check in flight and
 * waits longer after each failure; across all keys at most `maxPending` checks run at once, which
 * bounds the scrypt work anyone can ask of the gateway.
 */

/** One password check in flight per key, and a bound on scrypt work across all clients. */
export const MAX_PENDING_LOGINS = 16;
const MAX_KEYS = 10_000;
const RESET_MS = 15 * 60_000;

interface Attempt {
  failures: number;
  until: number;
  at: number;
  pending: boolean;
}

/** A check that was let through; exactly one of its methods should be called when it is done. */
export interface AttemptTicket {
  /** The password matched: the keys start over. */
  succeed(): void;
  /** The password did not match: the keys wait longer before the next check. */
  fail(): void;
  /** The check did not finish (an error): nothing is counted. */
  release(): void;
}

export type AttemptLimiter = ReturnType<typeof createAttemptLimiter>;

export function createAttemptLimiter(
  options: { now?: () => number; maxPending?: number; maxKeys?: number } = {},
) {
  const now = options.now ?? Date.now;
  const maxPending = options.maxPending ?? MAX_PENDING_LOGINS;
  const maxKeys = options.maxKeys ?? MAX_KEYS;
  const attempts = new Map<string, Attempt>();
  let pending = 0;

  const prune = (at: number) => {
    if (attempts.size < maxKeys) return;
    for (const [key, value] of attempts)
      if (!value.pending && at - value.at > RESET_MS) attempts.delete(key);
    for (const [key, value] of attempts) {
      if (attempts.size < maxKeys) break;
      if (!value.pending) attempts.delete(key);
    }
  };

  return {
    /** A ticket for one check under every one of `keys`, or undefined: wait and try again. */
    begin(keys: readonly string[]): AttemptTicket | undefined {
      const at = now();
      if (pending >= maxPending) return undefined;
      for (const key of keys) {
        const previous = attempts.get(key);
        if (previous && (previous.pending || previous.until > at)) return undefined;
      }
      prune(at);
      const held = keys.map((key) => {
        const previous = attempts.get(key);
        const attempt: Attempt = {
          failures: previous && at - previous.at < RESET_MS ? previous.failures : 0,
          until: 0,
          at,
          pending: true,
        };
        attempts.set(key, attempt);
        return [key, attempt] as const;
      });
      pending++;
      let settled = false;
      const settle = (outcome: "succeed" | "fail" | "release") => {
        if (settled) return;
        settled = true;
        pending--;
        for (const [key, attempt] of held) {
          attempt.pending = false;
          if (outcome === "succeed") {
            if (attempts.get(key) === attempt) attempts.delete(key);
          } else if (outcome === "fail") {
            attempt.failures++;
            attempt.until = now() + Math.min(30_000, 500 * 2 ** Math.min(attempt.failures - 1, 16));
          }
        }
      };
      return {
        succeed: () => settle("succeed"),
        fail: () => settle("fail"),
        release: () => settle("release"),
      };
    },
  };
}
