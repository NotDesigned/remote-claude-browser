/**
 * The selected exit's local time, using the gateway's UTC sample and the profile's IANA zone.
 */
import type { ReceivedServerStatus } from "./server-status";

export interface RemoteClockText {
  /** Short, for the top bar: "高雄 · 19:12". */
  label: string;
  /** Actual exit location, full local date, IANA zone and UTC offset. */
  title: string;
}

/** Keep the gateway's UTC clock while advancing by time elapsed on the viewer. */
export function remoteClockNow(sample: ReceivedServerStatus, now = Date.now()): number {
  return sample.value.sampledAt + now - sample.receivedAt;
}

export function formatStatusClock(
  sample: ReceivedServerStatus | null,
  now = Date.now(),
): RemoteClockText | null {
  return sample
    ? formatRemoteClock(sample.value.timeZone, new Date(remoteClockNow(sample, now)), {
        city: sample.value.exitCity,
        country: sample.value.exitCountry,
      })
    : null;
}

/** Null when the zone is missing or this browser does not know it. */
export function formatRemoteClock(
  timeZone: string | undefined,
  at: Date = new Date(),
  location: { city?: string; country?: string } = {},
): RemoteClockText | null {
  if (!timeZone) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("zh-CN", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "shortOffset",
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;
    const time = `${parts.hour}:${parts.minute}`;
    const city = location.city?.trim();
    const country = location.country?.trim();
    const place = city || country || "当地时间";
    const fullPlace = city && country && city !== country ? `${city}，${country}` : place;
    return {
      label: `${place} · ${time}`,
      title: `${fullPlace} · ${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${time} · ${timeZone}（${parts.timeZoneName}）`,
    };
  } catch {
    return null;
  }
}

/** Milliseconds until the minute shown next. */
export function msToNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}
