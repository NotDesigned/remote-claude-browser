import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createPageSleep,
  PAGE_PLAYING_EXPRESSION,
  PAGE_SLEEP_AFTER_MS,
  pageSleepAfterMs,
  sleepPlaceholderUrl,
  type SleepingPage,
} from "./page-sleep";

function setup(options: { busy?: Set<string>; pages?: string[] } = {}) {
  let clock = 0;
  const watched = new Set<string>();
  const active = new Map<string, string>();
  const pages = options.pages ?? ["tab-a", "tab-b"];
  const sleep = vi.fn(async (_sid: string, tab: string): Promise<SleepingPage | null> => ({
    entryId: tab.length,
    url: `https://example.com/${tab}`,
  }));
  const wake = vi.fn(async (_sid: string, _tab: string, _page: SleepingPage) => {});
  const pageSleep = createPageSleep({
    watched: (sid) => watched.has(sid),
    activeTab: (sid) => active.get(sid),
    pages: () => pages,
    canSleep: async (_sid, tab) => !(options.busy?.has(tab) ?? false),
    sleep,
    wake,
    now: () => clock,
    afterMs: 1000,
  });
  return {
    pageSleep,
    watched,
    active,
    pages,
    sleep,
    wake,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const slept = (sleep: { mock: { calls: unknown[][] } }) => sleep.mock.calls.map((call) => call[1]);

describe("sleeping pages nobody looks at", () => {
  it("waits the whole time with nobody watching before a page sleeps", async () => {
    const { pageSleep, sleep, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(999);
    await pageSleep.sweep(["client-1"]);
    expect(sleep).not.toHaveBeenCalled();
    advance(1);
    await pageSleep.sweep(["client-1"]);
    expect(slept(sleep)).toEqual(["tab-a", "tab-b"]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(true);
    // Already asleep: not put to sleep again.
    await pageSleep.sweep(["client-1"]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("a viewer that looks even briefly restarts the wait for the tab it shows", async () => {
    const { pageSleep, watched, active, sleep, advance } = setup();
    active.set("client-1", "tab-a");
    await pageSleep.sweep(["client-1"]);
    advance(900);
    watched.add("client-1");
    await pageSleep.sweep(["client-1"]);
    watched.delete("client-1");
    advance(900);
    await pageSleep.sweep(["client-1"]);
    // The tab behind it was not seen in all that time.
    expect(slept(sleep)).toEqual(["tab-b"]);
  });

  it("sleeps a tab left behind the one in use, while the one in use keeps running", async () => {
    const { pageSleep, watched, active, sleep, advance } = setup();
    watched.add("client-1");
    active.set("client-1", "tab-a");
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    expect(slept(sleep)).toEqual(["tab-b"]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(false);
  });

  it("keeps a page running while it is busy", async () => {
    const { pageSleep, sleep, advance } = setup({ busy: new Set(["tab-a"]) });
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    expect(slept(sleep)).toEqual(["tab-b"]);
  });

  it("wakes only the tab someone looks at, back to the entry it was on", async () => {
    const { pageSleep, watched, active, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    watched.add("client-1");
    active.set("client-1", "tab-a");
    await pageSleep.look("client-1");
    expect(wake.mock.calls).toEqual([
      ["client-1", "tab-a", { entryId: 5, url: "https://example.com/tab-a" }],
    ]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(false);
    expect(pageSleep.isAsleep("client-1", "tab-b")).toBe(true);
    // Switching to the other tab wakes that one too.
    active.set("client-1", "tab-b");
    await pageSleep.look("client-1");
    expect(wake.mock.calls.map((call) => call[1])).toEqual(["tab-a", "tab-b"]);
    await pageSleep.sweep(["client-1"]);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("a sweep wakes the tab on screen if nothing else did", async () => {
    const { pageSleep, watched, active, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    watched.add("client-1");
    active.set("client-1", "tab-b");
    await pageSleep.sweep(["client-1"]);
    expect(wake.mock.calls.map((call) => call[1])).toEqual(["tab-b"]);
  });

  it("does not wake a page that closed", async () => {
    const { pageSleep, watched, active, pages, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    pages.splice(0, 1);
    await pageSleep.sweep(["client-1"]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(false);
    watched.add("client-1");
    active.set("client-1", "tab-a");
    await pageSleep.look("client-1");
    expect(wake).not.toHaveBeenCalled();
  });

  it("forgets sessions that have ended", async () => {
    const { pageSleep, watched, active, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    await pageSleep.sweep([]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(false);
    watched.add("client-1");
    active.set("client-1", "tab-a");
    await pageSleep.look("client-1");
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("pages that play", () => {
  it("counts only media that is playing and can be heard", () => {
    const media = (props: Partial<Record<"paused" | "ended" | "muted", boolean>>, volume = 1) => ({
      paused: false,
      ended: false,
      muted: false,
      volume,
      ...props,
    });
    const run = (elements: unknown[]) =>
      vm.runInNewContext(PAGE_PLAYING_EXPRESSION, {
        document: { querySelectorAll: () => elements },
      }) as boolean;
    expect(run([])).toBe(false);
    expect(run([media({ paused: true }), media({ muted: true }), media({}, 0)])).toBe(false);
    expect(run([media({ paused: true }), media({})])).toBe(true);
  });
});

describe("the placeholder", () => {
  it("keeps the title, escaped, and fits in a data URL", () => {
    const url = sleepPlaceholderUrl('Claude <script>alert("x")</script> & co');
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    expect(html).toContain(
      '<title>Claude &lt;script&gt;alert("x")&lt;/script&gt; &amp; co</title>',
    );
    expect(html).not.toContain("<script>");
  });
});

describe("the setting", () => {
  it("defaults to half an hour, takes milliseconds, and 0 means off", () => {
    expect(pageSleepAfterMs(undefined)).toBe(PAGE_SLEEP_AFTER_MS);
    expect(pageSleepAfterMs(" ")).toBe(PAGE_SLEEP_AFTER_MS);
    expect(pageSleepAfterMs("4000")).toBe(4000);
    expect(pageSleepAfterMs("0")).toBe(0);
    expect(() => pageSleepAfterMs("30m")).toThrow(/MIRROR_PAGE_SLEEP_MS/);
  });
});
