/**
 * The time where the remote browser is. Sites see that zone, set by the server's TZ, so it is the
 * one easy to lose track of. The viewer's own clock is accurate enough; only the zone comes from
 * the server.
 */

export interface RemoteClockText {
  /** Short, for the top bar: "洛杉矶 03:12". */
  label: string;
  /** Full, for a tooltip or the menu: "2026-11-11 周三 03:12 · America/Los_Angeles（GMT-8）". */
  title: string;
}

/** The zone's place name, such as 洛杉矶 for America/Los_Angeles; UTC or an offset otherwise. */
export function zonePlace(timeZone: string, at: Date): string {
  const name = (style: "shortGeneric" | "shortOffset") =>
    new Intl.DateTimeFormat("zh-CN", { timeZone, timeZoneName: style })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  const generic = name("shortGeneric").replace(/时间$/, "");
  if (generic !== "" && !/^GMT/.test(generic)) return generic;
  const offset = name("shortOffset");
  return offset === "GMT" || offset === "GMT+0" ? "UTC" : offset;
}

/** Null when the zone is missing or this browser does not know it. */
export function formatRemoteClock(
  timeZone: string | undefined,
  at: Date = new Date(),
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
    return {
      label: `${zonePlace(timeZone, at)} ${time}`,
      title: `${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${time} · ${timeZone}（${parts.timeZoneName}）`,
    };
  } catch {
    return null;
  }
}

/** Milliseconds until the minute shown next. */
export function msToNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}
