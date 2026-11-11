/**
 * Puts the pages of a session nobody is looking at to sleep, and wakes them when someone looks.
 *
 * A viewer left open in a background tab keeps its session online, so the idle reaper never ends
 * it, yet nobody sees its pages. Hours later each can hold hundreds of megabytes. Asleep, a page
 * shows a tiny placeholder in a process of its own, and the site's renderer exits; waking returns
 * to the page's own history entry, which loads it again.
 */

/** How long every viewer of a session has been hidden, or gone, before its pages sleep. */
export const PAGE_SLEEP_AFTER_MS = 30 * 60_000;

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
  /** The session's top-level pages. */
  pages(sid: string): string[];
  /** False while a page must keep running: writing a reply, using the microphone, on picture. */
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
  const unwatchedSince = new Map<string, number>();
  const asleep = new Map<string, Map<string, SleepingPage>>();
  let sweeping: Promise<void> | undefined;

  const report = (error: unknown) => {
    try {
      deps.onError?.(error);
    } catch {
      // Reporting never stops the sweep.
    }
  };

  async function wake(sid: string): Promise<void> {
    const pages = asleep.get(sid);
    unwatchedSince.delete(sid);
    if (!pages) return;
    asleep.delete(sid);
    for (const [tab, page] of pages)
      await deps.wake(sid, tab, page).catch((error: unknown) => report(error));
  }

  async function sweepOnce(sids: readonly string[]): Promise<void> {
    const at = now();
    for (const sid of sids) {
      if (deps.watched(sid)) {
        await wake(sid);
        continue;
      }
      const since = unwatchedSince.get(sid) ?? at;
      unwatchedSince.set(sid, since);
      if (at - since < afterMs) continue;
      const sleeping = asleep.get(sid) ?? new Map<string, SleepingPage>();
      for (const tab of deps.pages(sid)) {
        if (sleeping.has(tab)) continue;
        try {
          if (!(await deps.canSleep(sid, tab))) continue;
          // Someone may have come back while the page was being checked.
          if (deps.watched(sid)) break;
          const page = await deps.sleep(sid, tab);
          if (page) sleeping.set(tab, page);
        } catch (error) {
          report(error);
        }
      }
      if (sleeping.size > 0) asleep.set(sid, sleeping);
    }
    for (const sid of [...unwatchedSince.keys()]) if (!sids.includes(sid)) forget(sid);
  }

  function forget(sid: string) {
    unwatchedSince.delete(sid);
    asleep.delete(sid);
  }

  return {
    /** Checks every live session once; overlapping calls share the running sweep. */
    sweep(sids: readonly string[]): Promise<void> {
      sweeping ??= sweepOnce(sids).finally(() => {
        sweeping = undefined;
      });
      return sweeping;
    },
    /** Someone is looking again: wake the session's pages now rather than at the next sweep. */
    wake,
    /** The session ended, or its pages were replaced. */
    forget,
    /** A page closed or navigated on its own; it no longer needs waking. */
    forgetPage(sid: string, tab: string) {
      asleep.get(sid)?.delete(tab);
    },
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
