/**
 * Puts pages nobody is looking at to sleep, and wakes each when someone looks at it again.
 *
 * A page is seen while it is its session's active tab and a viewer of that session is on screen.
 * A viewer left open in a background tab keeps its session online, so the idle reaper never ends
 * it, and a tab nobody switches to keeps running behind the one in use. Hours later each can hold
 * hundreds of megabytes. Asleep, a page shows a tiny placeholder in a process of its own, and the
 * site's renderer exits; waking returns to the page's own history entry, which loads it again.
 */

/** How long a page has gone unseen before it sleeps. */
export const PAGE_SLEEP_AFTER_MS = 30 * 60_000;

/** Whether the page plays sound or video someone may be listening to in another tab. */
export const PAGE_PLAYING_EXPRESSION = `[...document.querySelectorAll("audio, video")].some((m) => !m.paused && !m.ended && !m.muted && m.volume > 0)`;

/** MIRROR_PAGE_SLEEP_MS: unset is the default, 0 turns sleeping off. */
export function pageSleepAfterMs(value: string | undefined): number {
  const raw = value?.trim();
  if (raw === undefined || raw === "") return PAGE_SLEEP_AFTER_MS;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error("MIRROR_PAGE_SLEEP_MS must be a whole number of milliseconds, or 0 for off");
  return Number(raw);
}

export interface SleepingPage {
  /** The history entry the page was on, which waking returns to. */
  entryId: number;
  url: string;
}

export interface PageSleepDeps {
  /** Whether any viewer of the session is showing it right now. */
  watched(sid: string): boolean;
  /** The tab the session's viewers show. */
  activeTab(sid: string): string | undefined;
  /** The session's top-level pages. */
  pages(sid: string): string[];
  /**
   * False while a page must keep running: writing a reply, using the microphone, on picture,
   * playing sound.
   */
  canSleep(sid: string, tab: string): Promise<boolean>;
  /** Moves the page to the placeholder; null when it is not a page worth that. */
  sleep(sid: string, tab: string): Promise<SleepingPage | null>;
  wake(sid: string, tab: string, page: SleepingPage): Promise<void>;
  now?: () => number;
  afterMs?: number;
  onError?(error: unknown): void;
}

export function createPageSleep(deps: PageSleepDeps) {
  const now = deps.now ?? Date.now;
  const afterMs = deps.afterMs ?? PAGE_SLEEP_AFTER_MS;
  /** Per session, when each page was last seen. */
  const lastSeen = new Map<string, Map<string, number>>();
  /** Per session, the pages asleep and where each was. */
  const asleep = new Map<string, Map<string, SleepingPage>>();
  let sweeping: Promise<void> | undefined;

  const report = (error: unknown) => {
    try {
      deps.onError?.(error);
    } catch {
      // Reporting never stops the sweep.
    }
  };
  const seenTab = (sid: string) => (deps.watched(sid) ? deps.activeTab(sid) : undefined);
  const entries = <T>(map: Map<string, Map<string, T>>, sid: string) => {
    let inner = map.get(sid);
    if (!inner) map.set(sid, (inner = new Map()));
    return inner;
  };

  async function wakeTab(sid: string, tab: string): Promise<void> {
    const page = asleep.get(sid)?.get(tab);
    if (!page) return;
    asleep.get(sid)?.delete(tab);
    await deps.wake(sid, tab, page).catch((error: unknown) => report(error));
  }

  /** Someone may be looking at a page now: if it is asleep, wake it without waiting for a sweep. */
  async function look(sid: string): Promise<void> {
    const tab = seenTab(sid);
    if (tab === undefined) return;
    entries(lastSeen, sid).set(tab, now());
    await wakeTab(sid, tab);
  }

  async function sweepOnce(sids: readonly string[]): Promise<void> {
    const at = now();
    for (const sid of sids) {
      const pages = deps.pages(sid);
      const seen = entries(lastSeen, sid);
      const sleeping = entries(asleep, sid);
      // Pages that closed need neither timing nor waking.
      for (const tab of seen.keys()) if (!pages.includes(tab)) seen.delete(tab);
      for (const tab of sleeping.keys()) if (!pages.includes(tab)) sleeping.delete(tab);
      const shown = seenTab(sid);
      for (const tab of pages) {
        if (tab === shown) {
          seen.set(tab, at);
          await wakeTab(sid, tab);
          continue;
        }
        const since = seen.get(tab) ?? at;
        seen.set(tab, since);
        if (at - since < afterMs || sleeping.has(tab)) continue;
        try {
          if (!(await deps.canSleep(sid, tab))) continue;
          // Someone may have switched to it while it was being checked.
          if (seenTab(sid) === tab) continue;
          const page = await deps.sleep(sid, tab);
          if (!page) continue;
          sleeping.set(tab, page);
          // Or while it was going to sleep.
          if (seenTab(sid) === tab) await wakeTab(sid, tab);
        } catch (error) {
          report(error);
        }
      }
    }
    for (const sid of [...lastSeen.keys()])
      if (!sids.includes(sid)) {
        lastSeen.delete(sid);
        asleep.delete(sid);
      }
  }

  return {
    /** Checks every live session once; overlapping calls share the running sweep. */
    sweep(sids: readonly string[]): Promise<void> {
      sweeping ??= sweepOnce(sids).finally(() => {
        sweeping = undefined;
      });
      return sweeping;
    },
    /** A viewer came on screen, or switched tabs: wake what it shows now. */
    look,
    isAsleep(sid: string, tab: string): boolean {
      return asleep.get(sid)?.has(tab) ?? false;
    },
  };
}

/** The placeholder a sleeping page shows. It keeps the page's title for the tab strip. */
export function sleepPlaceholderUrl(title: string): string {
  const escaped = title
    .slice(0, 200)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html =
    `<!doctype html><meta charset="utf-8"><title>${escaped}</title>` +
    `<body style="font:15px system-ui,sans-serif;color:#666;margin:40px">` +
    `这个页面已休眠以节省服务器内存，回到这个窗口时会重新加载。</body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
