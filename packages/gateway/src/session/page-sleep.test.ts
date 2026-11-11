import { describe, expect, it, vi } from "vitest";
import {
  createPageSleep,
  PAGE_SLEEP_AFTER_MS,
  pageSleepAfterMs,
  sleepPlaceholderUrl,
  type SleepingPage,
} from "./page-sleep";

function setup(options: { busy?: Set<string>; pages?: string[] } = {}) {
  let clock = 0;
  const watched = new Set<string>();
  const sleep = vi.fn(async (_sid: string, tab: string): Promise<SleepingPage | null> => ({
    entryId: tab.length,
    url: `https://example.com/${tab}`,
  }));
  const wake = vi.fn(async (_sid: string, _tab: string, _page: SleepingPage) => {});
  const pageSleep = createPageSleep({
    watched: (sid) => watched.has(sid),
    pages: () => options.pages ?? ["tab-a", "tab-b"],
    canSleep: async (_sid, tab) => !(options.busy?.has(tab) ?? false),
    sleep,
    wake,
    now: () => clock,
    afterMs: 1000,
  });
  return {
    pageSleep,
    watched,
    sleep,
    wake,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("sleeping pages nobody looks at", () => {
  it("waits the whole time with nobody watching before a page sleeps", async () => {
    const { pageSleep, sleep, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(999);
    await pageSleep.sweep(["client-1"]);
    expect(sleep).not.toHaveBeenCalled();
    advance(1);
    await pageSleep.sweep(["client-1"]);
    expect(sleep.mock.calls.map((call) => call[1])).toEqual(["tab-a", "tab-b"]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(true);
    // Already asleep: not put to sleep again.
    await pageSleep.sweep(["client-1"]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("a viewer that looks even briefly restarts the wait", async () => {
    const { pageSleep, watched, sleep, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(900);
    watched.add("client-1");
    await pageSleep.sweep(["client-1"]);
    watched.delete("client-1");
    advance(900);
    await pageSleep.sweep(["client-1"]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps a page running while it is busy", async () => {
    const { pageSleep, sleep, advance } = setup({ busy: new Set(["tab-a"]) });
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    expect(sleep.mock.calls.map((call) => call[1])).toEqual(["tab-b"]);
  });

  it("wakes each sleeping page, back to the entry it was on, when someone looks", async () => {
    const { pageSleep, watched, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    watched.add("client-1");
    await pageSleep.wake("client-1");
    expect(wake.mock.calls).toEqual([
      ["client-1", "tab-a", { entryId: 5, url: "https://example.com/tab-a" }],
      ["client-1", "tab-b", { entryId: 5, url: "https://example.com/tab-b" }],
    ]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(false);
    // The next sweep has nothing more to wake.
    await pageSleep.sweep(["client-1"]);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("does not wake a page that closed or left the placeholder on its own", async () => {
    const { pageSleep, watched, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    pageSleep.forgetPage("client-1", "tab-a");
    watched.add("client-1");
    await pageSleep.sweep(["client-1"]);
    expect(wake.mock.calls.map((call) => call[1])).toEqual(["tab-b"]);
  });

  it("forgets sessions that have ended", async () => {
    const { pageSleep, wake, advance } = setup();
    await pageSleep.sweep(["client-1"]);
    advance(1000);
    await pageSleep.sweep(["client-1"]);
    await pageSleep.sweep([]);
    expect(pageSleep.isAsleep("client-1", "tab-a")).toBe(false);
    await pageSleep.wake("client-1");
    expect(wake).not.toHaveBeenCalled();
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
