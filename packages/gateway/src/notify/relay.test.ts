import type { Down, NotifyAgentIn } from "@mirror/protocol";
import { describe, expect, it } from "vitest";
import {
  ASK_TIMEOUT_MS,
  createNotifyRelay,
  MAX_FEEDS,
  MAX_PENDING_ASKS,
  NOTIFY_BURST,
  NOTIFY_REFILL_MS,
  type NotifyFeed,
} from "./relay";

function setup(options: { looking?: boolean } = {}) {
  let clock = 1_000;
  let ids = 0;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const agent: Array<{ sid: string; tab: string; value: NotifyAgentIn }> = [];
  const activated: Array<[string, string]> = [];
  let looking = options.looking ?? false;
  const relay = createNotifyRelay({
    sendAgent: (sid, tab, value) => agent.push({ sid, tab, value }),
    looking: () => looking,
    iconUrl: (sid, url) => `/s/${sid}/a/${encodeURIComponent(url)}`,
    activate: (sid, tab) => activated.push([sid, tab]),
    now: () => clock,
    setTimer(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (timer) => timers.delete(timer as number),
    newId: () => `g${++ids}`,
  });
  const feed = (authorized = true) => {
    const received: Down[] = [];
    const value: NotifyFeed & { received: Down[]; closed: boolean } = {
      received,
      closed: false,
      send: (message) => received.push(message),
      close() {
        value.closed = true;
      },
      authorized: () => authorized,
    };
    return value;
  };
  return {
    relay,
    agent,
    activated,
    feed,
    timers,
    advance: (ms: number) => (clock += ms),
    setLooking: (value: boolean) => (looking = value),
  };
}

const granted = {
  t: "notify-permission",
  state: "granted",
  origins: { "https://claude.ai": "granted" },
} as const;

describe("notification relay", () => {
  it("tells a document its origin's permission when it says hello and when the policy changes", () => {
    const { relay, agent } = setup();
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    expect(agent.pop()).toEqual({
      sid: "s1",
      tab: "T1",
      value: { permission: "default", away: true },
    });
    relay.onViewer("s1", granted);
    expect(agent.pop()?.value).toEqual({ permission: "granted", away: true });
    relay.onViewer("s1", { t: "notify-permission", state: "denied", origins: {} });
    expect(agent.pop()?.value).toEqual({ permission: "denied", away: true });
  });

  it("does not leak a session's policy or notifications to another session", () => {
    const { relay, agent, feed } = setup();
    const other = feed();
    relay.addFeed("s2", other);
    relay.onViewer("s1", granted);
    relay.onAgent("s2", "T2", { op: "hello", origin: "https://claude.ai" });
    expect(agent.pop()?.value).toMatchObject({ permission: "default" });
    relay.onAgent("s2", "T2", { op: "show", id: 1, title: "x" });
    expect(agent.pop()?.value).toEqual({ event: 1, type: "error" });
    expect(other.received).toEqual([]);
  });

  it("relays a notification with capped text and a proxied icon, and routes its click back", () => {
    const { relay, agent, activated, feed } = setup();
    const device = feed();
    relay.addFeed("s1", device);
    relay.onViewer("s1", granted);
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    relay.onAgent("s1", "T1", {
      op: "show",
      id: 7,
      origin: "https://evil.test",
      title: "t".repeat(1000),
      body: "Done",
      icon: "https://claude.ai/icon.png",
      tag: "chat",
      silent: true,
      requireInteraction: true,
    });
    expect(device.received).toEqual([
      {
        t: "notify",
        id: "g1",
        tab: "T1",
        // The gateway's record of the document, not what the message claims.
        origin: "https://claude.ai",
        title: "t".repeat(256),
        body: "Done",
        icon: `/s/s1/a/${encodeURIComponent("https://claude.ai/icon.png")}`,
        tag: "chat",
        silent: true,
        requireInteraction: true,
      },
    ]);
    agent.length = 0;
    relay.onViewer("s1", { t: "notify-event", id: "g1", type: "click" });
    expect(activated).toEqual([["s1", "T1"]]);
    expect(agent).toEqual([{ sid: "s1", tab: "T1", value: { event: 7, type: "click" } }]);
    relay.onViewer("s1", { t: "notify-event", id: "nope", type: "click" });
    expect(agent).toHaveLength(1);
  });

  it("keeps small data-URL icons and drops other schemes", () => {
    const { relay, feed } = setup();
    const device = feed();
    relay.addFeed("s1", device);
    relay.onViewer("s1", granted);
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    const small = "data:image/png;base64,AAAA";
    relay.onAgent("s1", "T1", { op: "show", id: 1, title: "a", icon: small });
    relay.onAgent("s1", "T1", {
      op: "show",
      id: 2,
      title: "b",
      icon: `data:image/png;base64,${"A".repeat(70_000)}`,
    });
    relay.onAgent("s1", "T1", { op: "show", id: 3, title: "c", icon: "javascript:alert(1)" });
    relay.onAgent("s1", "T1", { op: "show", id: 4, title: "d", icon: "data:text/html,x" });
    const icons = device.received.map((message) =>
      message.t === "notify" ? message.icon : undefined,
    );
    expect(icons).toEqual([small, undefined, undefined, undefined]);
  });

  it("refuses notifications without permission, without a device, or past the rate limit", () => {
    const { relay, agent, feed, advance } = setup();
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    relay.onAgent("s1", "T1", { op: "show", id: 1, title: "a" });
    expect(agent.pop()?.value).toEqual({ event: 1, type: "error" });
    relay.onViewer("s1", granted);
    relay.onAgent("s1", "T1", { op: "show", id: 2, title: "a" });
    expect(agent.pop()?.value).toEqual({ event: 2, type: "error" });
    const device = feed();
    relay.addFeed("s1", device);
    agent.length = 0;
    for (let id = 10; id < 10 + NOTIFY_BURST + 2; id++)
      relay.onAgent("s1", "T1", { op: "show", id, title: "a" });
    expect(device.received).toHaveLength(NOTIFY_BURST);
    expect(agent.map((entry) => entry.value)).toEqual([
      { event: 10 + NOTIFY_BURST, type: "error" },
      { event: 11 + NOTIFY_BURST, type: "error" },
    ]);
    advance(NOTIFY_REFILL_MS);
    relay.onAgent("s1", "T1", { op: "show", id: 99, title: "a" });
    expect(device.received).toHaveLength(NOTIFY_BURST + 1);
  });

  it("replaces a notification with the same tag and closes what the page closes", () => {
    const { relay, feed } = setup();
    const device = feed();
    relay.addFeed("s1", device);
    relay.onViewer("s1", granted);
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    relay.onAgent("s1", "T1", { op: "show", id: 1, title: "a", tag: "x" });
    relay.onAgent("s1", "T1", { op: "show", id: 2, title: "b", tag: "x" });
    expect(relay.inspect("s1")?.shown).toBe(1);
    relay.onAgent("s1", "T1", { op: "close", id: 2 });
    expect(device.received.at(-1)).toEqual({ t: "notify-close", id: "g2" });
    expect(relay.inspect("s1")?.shown).toBe(0);
  });

  it("asks the session's devices and answers the page", () => {
    const { relay, agent, feed } = setup();
    const device = feed();
    relay.addFeed("s1", device);
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    agent.length = 0;
    relay.onAgent("s1", "T1", { op: "ask", req: 3 });
    expect(device.received).toEqual([
      { t: "notify-ask", id: "g1", tab: "T1", origin: "https://claude.ai" },
    ]);
    // A device that opens its feed later still sees the open question.
    const late = feed();
    relay.addFeed("s1", late);
    expect(late.received).toEqual([device.received[0]]);
    // The person allowed it: the device reports its policy, then the answer.
    relay.onViewer("s1", granted);
    expect(agent).toContainEqual({
      sid: "s1",
      tab: "T1",
      value: { answer: 3, permission: "granted" },
    });
    expect(device.received.at(-1)).toEqual({ t: "notify-ask-end", id: "g1" });
    expect(relay.inspect("s1")?.asks).toBe(0);
  });

  it("answers denied, and a granted answer the policy does not back stays default", () => {
    const { relay, agent, feed } = setup();
    relay.addFeed("s1", feed());
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    relay.onAgent("s1", "T1", { op: "ask", req: 1 });
    relay.onViewer("s1", { t: "notify-answer", id: "g1", state: "granted" });
    expect(agent.pop()?.value).toEqual({ answer: 1, permission: "default" });
    relay.onAgent("s1", "T1", { op: "ask", req: 2 });
    relay.onViewer("s1", { t: "notify-answer", id: "g2", state: "denied" });
    expect(agent.pop()?.value).toEqual({ answer: 2, permission: "denied" });
  });

  it("bounds pending requests and times them out", () => {
    const { relay, agent, feed, timers } = setup();
    relay.addFeed("s1", feed());
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    agent.length = 0;
    for (let req = 1; req <= MAX_PENDING_ASKS + 1; req++)
      relay.onAgent("s1", "T1", { op: "ask", req });
    expect(agent.map((entry) => entry.value)).toEqual([
      { answer: MAX_PENDING_ASKS + 1, permission: "default" },
    ]);
    expect(ASK_TIMEOUT_MS).toBeGreaterThan(0);
    for (const callback of [...timers.values()]) callback();
    expect(relay.inspect("s1")?.asks).toBe(0);
    expect(agent).toHaveLength(MAX_PENDING_ASKS + 1);
  });

  it("forgets a document's state when another loads or the tab closes", () => {
    const { relay, agent, feed } = setup();
    const device = feed();
    relay.addFeed("s1", device);
    relay.onViewer("s1", granted);
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    relay.onAgent("s1", "T1", { op: "show", id: 1, title: "a" });
    relay.onAgent("s1", "T1", { op: "ask", req: 1 });
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    expect(relay.inspect("s1")?.shown).toBe(0);
    // A click on the old document's notification goes nowhere.
    agent.length = 0;
    relay.onViewer("s1", { t: "notify-event", id: "g1", type: "click" });
    expect(agent).toEqual([]);
    relay.forgetTab("s1", "T1");
    relay.onAgent("s1", "T1", { op: "show", id: 2, title: "a" });
    expect(agent.pop()?.value).toEqual({ event: 2, type: "error" });
  });

  it("caps feeds, ends unauthorized ones and closes all with the session", () => {
    const { relay, feed } = setup();
    const feeds = Array.from({ length: MAX_FEEDS + 1 }, () => feed());
    for (const each of feeds) relay.addFeed("s1", each);
    expect(feeds[0].closed).toBe(true);
    expect(relay.inspect("s1")?.feeds).toBe(MAX_FEEDS);
    const revoked = feed(false);
    relay.addFeed("s2", revoked);
    relay.closeUnauthorized();
    expect(revoked.closed).toBe(true);
    expect(relay.inspect("s2")?.feeds).toBe(0);
    relay.forgetSession("s1");
    expect(feeds.every((each) => each.closed)).toBe(true);
    expect(relay.inspect("s1")).toBeUndefined();
  });

  it("tells pages whether anyone is looking", () => {
    const { relay, agent, setLooking } = setup({ looking: true });
    relay.onAgent("s1", "T1", { op: "hello", origin: "https://claude.ai" });
    expect(agent.pop()?.value).toEqual({ permission: "default", away: false });
    setLooking(false);
    relay.presenceChanged("s1");
    expect(agent.pop()?.value).toEqual({ permission: "default", away: true });
  });

  it("ignores malformed agent and viewer messages", () => {
    const { relay, agent } = setup();
    relay.onAgent("s1", "T1", null);
    relay.onAgent("s1", "T1", { op: "hello", origin: "javascript:x" });
    relay.onAgent("s1", "T1", { op: "ask", req: "1" });
    relay.onViewer("s1", { t: "notify-permission", state: "maybe", origins: {} } as never);
    relay.onViewer("s1", { t: "notify-event", id: "x", type: "boom" } as never);
    expect(agent).toEqual([]);
  });
});
