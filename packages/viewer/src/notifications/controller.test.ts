// @vitest-environment node
import type { Down, NotifyEventType, Up } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import {
  createNotifyController,
  FEED_RETRY_MS,
  type FeedSource,
  type NotifyEnv,
  type NotifyShowOptions,
  type NotifyState,
} from "./controller";
import type { DevicePermission, NotifySettings } from "./policy";

function setup(
  options: {
    permission?: DevicePermission;
    grant?: NotificationPermission;
    pageWorks?: boolean;
    settings?: NotifySettings;
    device?: string;
  } = {},
) {
  let permission: DevicePermission = options.permission ?? "granted";
  const posted: Up[] = [];
  const page: Array<{
    title: string;
    options: NotifyShowOptions;
    on: (type: NotifyEventType) => void;
    closed: boolean;
  }> = [];
  const worker: Array<{ title: string; options: NotifyShowOptions }> = [];
  const workerClosed: string[] = [];
  const feeds: Array<FeedSource & { readyState: number; closed: boolean }> = [];
  const feedUrls: string[] = [];
  const timers: Array<() => void> = [];
  let focused = 0;
  let requested = 0;
  const saved: NotifySettings[] = [];
  const states: NotifyState[] = [];
  const env: NotifyEnv = {
    permission: () => permission,
    async requestPermission() {
      requested++;
      permission = options.grant ?? "granted";
      return permission;
    },
    showPage(title, showOptions, on) {
      if (options.pageWorks === false) throw new TypeError("Illegal constructor");
      const entry = { title, options: showOptions, on, closed: false };
      page.push(entry);
      return { close: () => void (entry.closed = true) };
    },
    showWorker: async (title, showOptions) => void worker.push({ title, options: showOptions }),
    closeWorker: (id) => void workerClosed.push(id),
    focus: () => void focused++,
    openFeed(url) {
      feedUrls.push(url);
      const feed = {
        onopen: null,
        onmessage: null,
        onerror: null,
        readyState: 1,
        closed: false,
        close() {
          feed.closed = true;
          feed.readyState = 2;
        },
      } as FeedSource & { readyState: number; closed: boolean };
      feeds.push(feed);
      return feed;
    },
    post: async (_url, message) => void posted.push(message),
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => undefined,
  };
  const controller = createNotifyController({
    sid: "s1",
    ...(options.device === undefined ? {} : { device: options.device }),
    env,
    settings: options.settings ?? { enabled: true, origins: {} },
    save: (settings) => void saved.push(settings),
    onChange: (state) => void states.push(state),
  });
  const deliver = (message: Down) => feeds.at(-1)!.onmessage!({ data: JSON.stringify(message) });
  return {
    controller,
    feedUrls,
    posted,
    page,
    worker,
    workerClosed,
    feeds,
    timers,
    saved,
    states,
    deliver,
    focused: () => focused,
    requested: () => requested,
    setPermission: (value: DevicePermission) => (permission = value),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const claude = { "https://claude.ai": "granted" as const };
const notification = (id: string, extra: Partial<Extract<Down, { t: "notify" }>> = {}) =>
  ({
    t: "notify",
    id,
    tab: "T1",
    origin: "https://claude.ai",
    title: "Claude",
    body: "Task done",
    ...extra,
  }) as const;

describe("notification controller", () => {
  it("reports this device's policy each time the feed opens", async () => {
    const { feeds, posted } = setup({ settings: { enabled: true, origins: claude } });
    feeds[0]!.onopen!();
    feeds[0]!.onopen!();
    await flush();
    expect(posted).toEqual([
      { t: "notify-permission", state: "granted", origins: claude },
      { t: "notify-permission", state: "granted", origins: claude },
    ]);
  });

  it("names its workbench on the feed and in its policy", async () => {
    const { feeds, feedUrls, posted } = setup({
      settings: { enabled: true, origins: claude },
      device: "laptop-0001",
    });
    expect(feedUrls).toEqual(["/s/s1/notify?device=laptop-0001"]);
    feeds[0]!.onopen!();
    await flush();
    expect(posted).toEqual([
      { t: "notify-permission", state: "granted", origins: claude, device: "laptop-0001" },
    ]);
  });

  it("says nothing when the browser has no Notification API", async () => {
    const { feeds, posted } = setup({ permission: "unsupported" });
    feeds[0]!.onopen!();
    await flush();
    expect(posted).toEqual([]);
  });

  it("shows a notification with the page API and reports its events", async () => {
    const { deliver, page, posted, focused } = setup({
      settings: { enabled: true, origins: claude },
    });
    deliver(notification("g1", { tag: "chat", icon: "/s/s1/a/x", silent: true }));
    expect(page).toHaveLength(1);
    expect(page[0]!.title).toBe("Claude");
    expect(page[0]!.options).toEqual({
      body: "Task done",
      tag: "mirror:https://claude.ai:chat",
      icon: "/s/s1/a/x",
      silent: true,
      data: { sid: "s1", id: "g1" },
    });
    page[0]!.on("show");
    page[0]!.on("click");
    await flush();
    expect(focused()).toBe(1);
    expect(page[0]!.closed).toBe(true);
    expect(posted).toEqual([
      { t: "notify-event", id: "g1", type: "show" },
      { t: "notify-event", id: "g1", type: "click" },
    ]);
  });

  it("falls back to the service worker where the constructor throws (Android)", async () => {
    const { deliver, worker, posted, workerClosed } = setup({
      pageWorks: false,
      settings: { enabled: true, origins: claude },
    });
    deliver(notification("g1"));
    deliver(notification("g2"));
    await flush();
    expect(worker.map((entry) => entry.options.data)).toEqual([
      { sid: "s1", id: "g1" },
      { sid: "s1", id: "g2" },
    ]);
    expect(posted).toEqual([
      { t: "notify-event", id: "g1", type: "show" },
      { t: "notify-event", id: "g2", type: "show" },
    ]);
    deliver({ t: "notify-close", id: "g1" });
    expect(workerClosed).toEqual(["g1"]);
  });

  it("refuses notifications for sites or devices that are not allowed", async () => {
    const { deliver, page, posted, controller } = setup({
      settings: { enabled: true, origins: { "https://other.test": "granted" } },
    });
    deliver(notification("g1"));
    await controller.setEnabled(false);
    deliver(notification("g2", { origin: "https://other.test" }));
    await flush();
    expect(page).toEqual([]);
    expect(posted.filter((message) => message.t === "notify-event")).toEqual([
      { t: "notify-event", id: "g1", type: "error" },
      { t: "notify-event", id: "g2", type: "error" },
    ]);
  });

  it("closes what the page closes", () => {
    const { deliver, page } = setup({ settings: { enabled: true, origins: claude } });
    deliver(notification("g1"));
    deliver({ t: "notify-close", id: "g1" });
    expect(page[0]!.closed).toBe(true);
  });

  it("asks the person, and an allow asks the browser and reports the policy before the answer", async () => {
    const { deliver, controller, posted, requested, saved } = setup({ permission: "default" });
    deliver({ t: "notify-ask", id: "a1", tab: "T1", origin: "https://claude.ai" });
    deliver({ t: "notify-ask", id: "a1", tab: "T1", origin: "https://claude.ai" });
    expect(controller.state().asks).toEqual([{ id: "a1", tab: "T1", origin: "https://claude.ai" }]);
    await controller.answer("a1", true);
    expect(requested()).toBe(1);
    expect(controller.state().asks).toEqual([]);
    expect(saved.at(-1)).toEqual({ enabled: true, origins: claude });
    expect(posted).toEqual([
      { t: "notify-permission", state: "granted", origins: claude },
      { t: "notify-answer", id: "a1", state: "granted" },
    ]);
  });

  it("answers default when the browser refuses, and denied when the person does", async () => {
    const browserSaysNo = setup({ permission: "default", grant: "denied" });
    browserSaysNo.deliver({ t: "notify-ask", id: "a1", tab: "T1", origin: "https://claude.ai" });
    await browserSaysNo.controller.answer("a1", true);
    expect(browserSaysNo.posted.at(-1)).toEqual({ t: "notify-answer", id: "a1", state: "default" });
    expect(browserSaysNo.saved).toEqual([]);

    const personSaysNo = setup();
    personSaysNo.deliver({ t: "notify-ask", id: "a2", tab: "T1", origin: "https://x.test" });
    await personSaysNo.controller.answer("a2", false);
    expect(personSaysNo.requested()).toBe(0);
    expect(personSaysNo.posted).toEqual([
      { t: "notify-permission", state: "granted", origins: { "https://x.test": "denied" } },
      { t: "notify-answer", id: "a2", state: "denied" },
    ]);
  });

  it("drops a request answered elsewhere, and a dismissed one answers default", async () => {
    const { deliver, controller, posted } = setup();
    deliver({ t: "notify-ask", id: "a1", tab: "T1", origin: "https://claude.ai" });
    deliver({ t: "notify-ask-end", id: "a1" });
    expect(controller.state().asks).toEqual([]);
    deliver({ t: "notify-ask", id: "a2", tab: "T1", origin: "https://claude.ai" });
    controller.dismiss("a2");
    await flush();
    expect(posted).toEqual([{ t: "notify-answer", id: "a2", state: "default" }]);
  });

  it("turning the setting on asks the browser; resetting forgets the sites", async () => {
    const { controller, posted, requested } = setup({
      permission: "default",
      settings: { enabled: false, origins: claude },
    });
    await controller.setEnabled(true);
    expect(requested()).toBe(1);
    controller.resetSites();
    await flush();
    expect(posted).toEqual([
      { t: "notify-permission", state: "granted", origins: claude },
      { t: "notify-permission", state: "granted", origins: {} },
    ]);
  });

  it("notices a permission changed in the browser's settings", async () => {
    const { controller, posted, setPermission } = setup();
    setPermission("denied");
    controller.recheck();
    await flush();
    expect(controller.state().device).toBe("denied");
    expect(posted).toEqual([{ t: "notify-permission", state: "denied", origins: {} }]);
  });

  it("opens a refused feed again later, and stops on dispose", () => {
    const { feeds, timers, controller, deliver, page } = setup({
      settings: { enabled: true, origins: claude },
    });
    feeds[0]!.readyState = 2;
    feeds[0]!.onerror!();
    expect(timers).toHaveLength(1);
    expect(FEED_RETRY_MS).toBeGreaterThan(1000);
    timers[0]!();
    expect(feeds).toHaveLength(2);
    deliver(notification("g1"));
    controller.dispose();
    expect(feeds[1]!.closed).toBe(true);
    expect(page[0]!.closed).toBe(true);
  });
});
