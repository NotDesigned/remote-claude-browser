/**
 * This device's 「网页通知」 setting for one browser profile, and the NotifyPolicy it reports to
 * the gateway (see @mirror/protocol notify.ts).
 *
 * The setting (on or off) and each site's answer are remembered in this browser per profile; the
 * device's own permission is the browser's Notification.permission, which only the person can
 * change. A device that cannot show notifications at all reports nothing, so that another device
 * of the same person that can keeps its say.
 */
import {
  NOTIFY_MAX_ORIGINS,
  notifyOrigin,
  type NotifyDecision,
  type NotifyPolicy,
} from "@mirror/protocol";

export interface NotifySettings {
  enabled: boolean;
  origins: Record<string, NotifyDecision>;
}

/** The browser's own permission here, or "unsupported" without a Notification API. */
export type DevicePermission = NotificationPermission | "unsupported";

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { enabled: true, origins: {} };

export const notifyStorageKey = (profile: string) => `mirror.notify.${profile}`;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function loadNotifySettings(storage: Storage, key: string): NotifySettings {
  let value: unknown;
  try {
    value = JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return { ...DEFAULT_NOTIFY_SETTINGS, origins: {} };
  }
  if (typeof value !== "object" || value === null)
    return { ...DEFAULT_NOTIFY_SETTINGS, origins: {} };
  const { enabled, origins } = value as { enabled?: unknown; origins?: unknown };
  const kept: Record<string, NotifyDecision> = {};
  if (typeof origins === "object" && origins !== null)
    for (const [origin, decision] of Object.entries(origins as Record<string, unknown>)) {
      if (Object.keys(kept).length >= NOTIFY_MAX_ORIGINS) break;
      if (notifyOrigin(origin) !== origin) continue;
      if (decision === "granted" || decision === "denied") kept[origin] = decision;
    }
  return { enabled: enabled !== false, origins: kept };
}

export function saveNotifySettings(storage: Storage, key: string, settings: NotifySettings): void {
  try {
    storage.setItem(key, JSON.stringify(settings));
  } catch {
    // Private windows may refuse; the setting then lasts as long as the page.
  }
}

/** The policy this device reports, or null when it has nothing to say (no Notification API). */
export function devicePolicy(
  settings: NotifySettings,
  device: DevicePermission,
): NotifyPolicy | null {
  if (device === "unsupported") return null;
  return {
    state: settings.enabled ? device : "denied",
    origins: { ...settings.origins },
  };
}

/** Remembers a site's answer; the newest answers are kept when there are too many. */
export function decideSite(
  settings: NotifySettings,
  origin: string,
  decision: NotifyDecision,
): NotifySettings {
  const origins = { ...settings.origins };
  delete origins[origin];
  origins[origin] = decision;
  const keys = Object.keys(origins);
  for (const oldest of keys.slice(0, Math.max(0, keys.length - NOTIFY_MAX_ORIGINS)))
    delete origins[oldest];
  return { ...settings, origins };
}

/** How a site is named to the person: 「Claude 想给你发通知」. */
export function siteLabel(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return origin;
  }
  if (host === "claude.ai" || host.endsWith(".claude.ai")) return "Claude";
  return host.replace(/^www\./, "");
}

export type NotifySummaryTone = "on" | "off" | "blocked" | "unsupported";

/** What the ⋯ menu says about the setting on this device. */
export function notifySummary(
  settings: NotifySettings,
  device: DevicePermission,
): { tone: NotifySummaryTone; text: string } {
  if (device === "unsupported")
    return {
      tone: "unsupported",
      text: "这个浏览器不能显示通知。iPhone、iPad 上需先把工作台「添加到主屏幕」，再从主屏幕打开",
    };
  if (!settings.enabled) return { tone: "off", text: "已关闭：网页会看到通知被拒绝" };
  if (device === "denied")
    return { tone: "blocked", text: "浏览器已阻止本站通知，请在浏览器的网站设置里允许" };
  if (device === "default")
    return { tone: "on", text: "已开启：网页请求时会先问你，需要浏览器授权" };
  return { tone: "on", text: "已开启：网页的通知会出现在这台设备上" };
}

/**
 * The tag a notification gets on this device: the site's own tag, kept apart per site, replaces
 * the earlier one as on the remote browser; without one, each notification stands alone.
 */
export function deviceTag(origin: string, tag: string | undefined, id: string): string {
  return tag === undefined ? `mirror:${id}` : `mirror:${origin}:${tag}`;
}
