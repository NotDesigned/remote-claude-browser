/**
 * Website notifications, carried from the remote page to the person's own device.
 *
 * The remote Chromium blocks its own notifications and permission bubbles (nobody can click
 * them there). The agent replaces the page's Notification API with one whose permission is the
 * viewer's answer; the gateway relays each notification to the session's viewers, which show it
 * with their own browser's Notification API and report what happens to it.
 */

/** What a page's Notification.permission says. */
export type NotifyPermission = "default" | "granted" | "denied";
/** A remembered answer for one site. */
export type NotifyDecision = "granted" | "denied";
export type NotifyEventType = "show" | "click" | "close" | "error";

/**
 * A viewer's notification settings for the session's profile: `state` is the device as a whole
 * ("denied" when the setting is off or the device's browser blocks notifications, "granted" when
 * it can show them, "default" when it has not been asked yet), `origins` the answers per site.
 */
export interface NotifyPolicy {
  state: NotifyPermission;
  origins: Record<string, NotifyDecision>;
}

/** Caps on what one notification carries; the gateway cuts anything longer. */
export const NOTIFY_MAX_TITLE = 256;
export const NOTIFY_MAX_BODY = 1024;
export const NOTIFY_MAX_TAG = 128;
/** An icon as a data URL is passed through up to this size, in characters; larger ones drop. */
export const NOTIFY_MAX_ICON_DATA = 64 * 1024;
export const NOTIFY_MAX_ICON_URL = 4096;
/** Remembered sites per profile on a device. */
export const NOTIFY_MAX_ORIGINS = 64;

/** A workbench page's random id for its notification feed and policy. */
export const NOTIFY_DEVICE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The page's permission for `origin` under a viewer's policy (none yet: "default"). */
export function effectiveNotifyPermission(
  policy: NotifyPolicy | null | undefined,
  origin: string,
): NotifyPermission {
  if (!policy) return "default";
  if (policy.state === "denied") return "denied";
  const decision = policy.origins[origin];
  if (decision === "denied") return "denied";
  // A site allowed earlier still needs this device's own permission before it can be shown.
  return decision === "granted" && policy.state === "granted" ? "granted" : "default";
}

/**
 * The page's permission for `origin` with several devices open: granted when any of them can show
 * its notifications, denied only when every one of them refuses, otherwise default.
 */
export function mergedNotifyPermission(
  policies: Iterable<NotifyPolicy>,
  origin: string,
): NotifyPermission {
  let some = false;
  let undecided = false;
  for (const policy of policies) {
    some = true;
    const permission = effectiveNotifyPermission(policy, origin);
    if (permission === "granted") return "granted";
    if (permission === "default") undecided = true;
  }
  return !some || undecided ? "default" : "denied";
}

/** An http(s) origin as `scheme://host[:port]`, or null for anything else. */
export function notifyOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/** Untrusted input: a policy with only well-formed, bounded entries, or null. */
export function readNotifyPolicy(value: unknown): NotifyPolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const { state, origins } = value as { state?: unknown; origins?: unknown };
  if (state !== "default" && state !== "granted" && state !== "denied") return null;
  const kept: Record<string, NotifyDecision> = {};
  if (typeof origins === "object" && origins !== null) {
    let count = 0;
    for (const [key, decision] of Object.entries(origins as Record<string, unknown>)) {
      if (count >= NOTIFY_MAX_ORIGINS) break;
      const origin = notifyOrigin(key);
      if (origin === null || origin !== key) continue;
      if (decision !== "granted" && decision !== "denied") continue;
      kept[origin] = decision;
      count += 1;
    }
  }
  return { state, origins: kept };
}

/** A notification as the page described it, before the gateway's caps. */
export interface NotifyContent {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  silent?: boolean;
  requireInteraction?: boolean;
  renotify?: boolean;
}

/** Agent -> gateway (private binding lane, like voice). `id` is the agent's, per document. */
export type NotifyAgentOut =
  | { op: "hello"; origin: string }
  | { op: "ask"; req: number; origin: string }
  | ({ op: "show"; id: number; origin: string } & NotifyContent)
  | { op: "close"; id: number };

/** Gateway -> agent. */
export type NotifyAgentIn =
  /** The page's permission now, and whether nobody is looking at the session. */
  | { permission: NotifyPermission; away: boolean }
  | { answer: number; permission: NotifyPermission }
  | { event: number; type: NotifyEventType };
