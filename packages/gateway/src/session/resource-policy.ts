/** Idle period before a browser account with no sessions is closed. */
export const ACCOUNT_IDLE_CLOSE_MS = 15 * 60_000;
/** Grace period before an offline session's pages are released. */
export const SESSION_IDLE_GRACE_MS = 15 * 60_000;

/**
 * The grace period in use: MIRROR_IDLE_GRACE_MS (milliseconds) when set, else
 * SESSION_IDLE_GRACE_MS (one minute in end-to-end tests). Compose passes an unset variable as "".
 */
export function sessionIdleGraceMs(value: string | undefined, e2e: boolean): number {
  if (value === undefined || value.trim() === "") return e2e ? 60_000 : SESSION_IDLE_GRACE_MS;
  const ms = Number(value.trim());
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new Error("MIRROR_IDLE_GRACE_MS must be a whole number of milliseconds");
  return ms;
}
