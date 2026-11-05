import {
  EventType,
  IncrementalSource,
  type AgentMsg,
  type Down,
  type eventWithTime,
} from "@mirror/protocol";
import { openAssetToken } from "../assets/token";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserHandle, BrowserTargetInfo } from "../browser/launch";
import type { Protocol } from "puppeteer-core";
import type { AgentLink, CdpSend, TargetRef } from "../types";
import { ViewportInputGate } from "../hub/viewport";
import { createTabLifecycle } from "./tabs";

class MessageQueue implements AsyncIterable<AgentMsg>, AsyncIterator<AgentMsg> {
  private readonly queued: AgentMsg[] = [];
  private readonly waiting: ((result: IteratorResult<AgentMsg>) => void)[] = [];

  push(message: AgentMsg): void {
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(message);
    else waiter({ done: false, value: message });
  }

  next(): Promise<IteratorResult<AgentMsg>> {
    const message = this.queued.shift();
    if (message !== undefined) return Promise.resolve({ done: false, value: message });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentMsg> {
    return this;
  }
}

class MockBrowser {
  readonly browserCalls: { method: string; params?: Record<string, unknown> }[] = [];
  readonly sessionCalls: {
    sessionId: string;
    method: string;
    params?: Record<string, unknown>;
  }[] = [];
  private readonly attached = new Set<(target: TargetRef) => void>();
  private readonly detached = new Set<(target: TargetRef) => void>();
  private readonly infoChanged = new Set<(info: BrowserTargetInfo) => void>();
  private readonly bindings = new Set<
    (session: string, event: Protocol.Runtime.BindingCalledEvent) => void
  >();
  readonly onSessionEvent: BrowserHandle["onSessionEvent"] = (method, callback) => {
    if (method !== "Runtime.bindingCalled") return () => {};
    const handler = callback as (
      session: string,
      event: Protocol.Runtime.BindingCalledEvent,
    ) => void;
    this.bindings.add(handler);
    return () => this.bindings.delete(handler);
  };
  binding(session: string, name: string, payload: string) {
    for (const callback of this.bindings)
      callback(session, { name, payload, executionContextId: 42 });
  }
  autoAttachCreatedTarget = false;
  nextCreatedTarget = "created-tab";
  evaluate?: () => Promise<unknown>;
  frameTreeAvailable = false;

  readonly send: CdpSend = async (sessionId, method, params) => {
    this.sessionCalls.push({ sessionId, method, ...(params === undefined ? {} : { params }) });
    if (method === "Page.getFrameTree" && this.frameTreeAvailable)
      return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    if (method === "Runtime.evaluate") {
      if (this.evaluate !== undefined) return this.evaluate();
      return { result: { value: `https://icons.test/${sessionId}.png` } };
    }
    return {};
  };

  readonly sendBrowser = async (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> => {
    this.browserCalls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "Target.createTarget") {
      if (this.autoAttachCreatedTarget) {
        this.attach({
          targetId: this.nextCreatedTarget,
          sessionId: `cdp-${this.nextCreatedTarget}`,
          type: "page",
        });
      }
      return { targetId: this.nextCreatedTarget };
    }
    if (method === "Target.closeTarget") return { success: true };
    return {};
  };

  onAttached(callback: (target: TargetRef) => void): void {
    this.attached.add(callback);
  }

  onDetached(callback: (target: TargetRef) => void): void {
    this.detached.add(callback);
  }

  onTargetInfoChanged(callback: (info: BrowserTargetInfo) => void): void {
    this.infoChanged.add(callback);
  }

  attach(target: TargetRef): void {
    for (const callback of this.attached) callback(target);
  }

  detach(target: TargetRef): void {
    for (const callback of this.detached) callback(target);
  }

  info(info: BrowserTargetInfo): void {
    for (const callback of this.infoChanged) callback(info);
  }
}

function hello(docId: number): AgentMsg {
  return { kind: "hello", docId, url: `https://doc-${docId}.test/`, isTop: true, ts: docId };
}

function event(type: EventType, data: eventWithTime["data"], timestamp: number): AgentMsg {
  return { kind: "rrweb", docId: 1, e: { type, data, timestamp } as eventWithTime };
}

describe("createTabLifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("uses observed page titles without waiting for the next navigation or a stale browser title", async () => {
    const browser = new MockBrowser();
    browser.frameTreeAvailable = true;
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: { msgs: () => new MessageQueue(), sendCmd: async () => ({ reqId: 1, ok: true }) },
      sessionId: "session",
      assetTokenKey: Buffer.alloc(32, 1),
      publish: () => {},
    });
    try {
      browser.attach({ targetId: "tab", sessionId: "cdp-tab", type: "page" });
      const info = {
        targetId: "tab",
        type: "page",
        url: "https://page.test/chat/new",
        title: "Previous conversation",
      };
      browser.info(info);
      await vi.waitFor(() =>
        expect(browser.sessionCalls.some((call) => call.method === "Runtime.addBinding")).toBe(
          true,
        ),
      );
      const binding = browser.sessionCalls.find((call) => call.method === "Runtime.addBinding")!
        .params!.name as string;
      const pending = lifecycle.tabsMessage();
      browser.binding(
        "cdp-tab",
        binding,
        JSON.stringify({ url: info.url, title: "Current conversation" }),
      );
      expect((await pending).tabs[0]!.title).toBe("Current conversation");
      browser.info(info);
      expect((await lifecycle.tabsMessage()).tabs[0]!.title).toBe("Current conversation");
      browser.binding(
        "another-session",
        binding,
        JSON.stringify({ url: info.url, title: "Other client" }),
      );
      expect((await lifecycle.tabsMessage()).tabs[0]!.title).toBe("Current conversation");
      browser.info({ ...info, url: "https://page.test/new", title: "New page" });
      expect((await lifecycle.tabsMessage()).tabs[0]!.title).toBe("New page");
    } finally {
      lifecycle.dispose();
    }
  });

  it("bounds metadata waits and shares a hung favicon evaluation while retaining target metadata", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser();
    browser.evaluate = () => new Promise(() => undefined);
    const key = Buffer.alloc(32, 13);
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: {
        msgs: () => new MessageQueue(),
        sendCmd: async () => ({ reqId: 1, ok: true }),
      },
      sessionId: "session",
      assetTokenKey: key,
      publish: () => undefined,
    });
    try {
      browser.attach({ targetId: "tab", sessionId: "cdp-tab", type: "page" });
      browser.info({
        targetId: "tab",
        type: "page",
        url: "https://page.test/conversation",
        title: "Current page",
      });
      const metadata = lifecycle.tabsMessage();
      let settled = false;
      void metadata.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const message = await metadata;
      expect(message.tabs[0]).toMatchObject({
        id: "tab",
        url: "https://page.test/conversation",
        title: "Current page",
        active: true,
      });
      expect(openAssetToken(message.tabs[0]!.favicon!.split("/").at(-1)!, key)).toEqual({
        url: "https://page.test/favicon.ico",
        sessionId: "session",
        tabId: "tab",
      });

      const again = lifecycle.tabsMessage();
      await vi.advanceTimersByTimeAsync(250);
      const next = await again;
      expect(next.tabs[0]).toMatchObject({
        id: "tab",
        url: "https://page.test/conversation",
        title: "Current page",
        active: true,
      });
      expect(openAssetToken(next.tabs[0]!.favicon!.split("/").at(-1)!, key)).toEqual({
        url: "https://page.test/favicon.ico",
        sessionId: "session",
        tabId: "tab",
      });
      expect(
        browser.sessionCalls.filter((call) => call.method === "Runtime.evaluate"),
      ).toHaveLength(1);
      expect(browser.sessionCalls.find((call) => call.method === "Runtime.evaluate")).toMatchObject(
        {
          sessionId: "cdp-tab",
          method: "Runtime.evaluate",
          params: { returnByValue: true, timeout: 200 },
        },
      );
    } finally {
      lifecycle.dispose();
    }
  });

  it("keeps pixel viewport acknowledgements working without publishing DOM updates or background snapshots", async () => {
    const browser = new MockBrowser();
    const streams = new Map<string, MessageQueue>();
    const gate = new ViewportInputGate();
    const published: Down[] = [];
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: {
        msgs(tabId) {
          const stream = new MessageQueue();
          streams.set(tabId, stream);
          return stream;
        },
        sendCmd: async () => ({ reqId: 1, ok: true }),
      },
      sessionId: "session",
      assetTokenKey: Buffer.alloc(32, 12),
      publish(message) {
        published.push(message);
        if (message.t === "snapshot") gate.noteSnapshot(message);
      },
    });
    const pushSnapshot = (stream: MessageQueue, timestamp: number) => {
      stream.push(
        event(EventType.Meta, { href: "https://login.test/", width: 1024, height: 768 }, timestamp),
      );
      stream.push(
        event(
          EventType.FullSnapshot,
          { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
          timestamp + 1,
        ),
      );
    };

    try {
      browser.attach({ targetId: "active", sessionId: "cdp-active", type: "page" });
      browser.attach({ targetId: "background", sessionId: "cdp-background", type: "page" });
      const activeHub = lifecycle.hubFor("active")!;
      const backgroundHub = lifecycle.hubFor("background")!;
      activeHub.mode = "px";
      backgroundHub.mode = "px";
      const activeStream = streams.get("active")!;
      const backgroundStream = streams.get("background")!;
      activeStream.push(hello(1));
      backgroundStream.push(hello(1));
      pushSnapshot(activeStream, 1);
      pushSnapshot(backgroundStream, 1);
      await vi.waitFor(() => {
        expect(activeHub.seq).toBe(1);
        expect(backgroundHub.seq).toBe(1);
      });
      expect(published.filter((message) => "tab" in message)).toEqual([]);

      gate.beginViewportChange("active");
      expect(gate.allowsInput("driver", "active")).toBe(false);
      activeHub.requestSnapshot("viewport");
      backgroundHub.requestSnapshot("viewport");
      pushSnapshot(activeStream, 3);
      pushSnapshot(backgroundStream, 3);
      activeStream.push(
        event(
          EventType.IncrementalSnapshot,
          { source: IncrementalSource.Scroll, id: 0, x: 0, y: 20 },
          5,
        ),
      );
      await vi.waitFor(() => {
        expect(activeHub.seq).toBe(3);
        expect(backgroundHub.seq).toBe(2);
      });
      const snapshots = published.filter((message) => message.t === "snapshot");
      expect(snapshots).toHaveLength(1);
      const viewportSnapshot = snapshots[0]!;
      expect(viewportSnapshot).toMatchObject({ tab: "active", reason: "viewport" });
      expect(gate.acknowledge("driver", "active", viewportSnapshot.epoch)).toBe(true);
      expect(gate.allowsInput("driver", "active")).toBe(true);
      expect(published.some((message) => message.t === "delta")).toBe(false);
      expect(published.some((message) => "tab" in message && message.tab === "background")).toBe(
        false,
      );

      activeHub.requestSnapshot("resync");
      pushSnapshot(activeStream, 6);
      await vi.waitFor(() => expect(activeHub.seq).toBe(4));
      expect(published.filter((message) => message.t === "snapshot")).toHaveLength(1);
      expect(activeHub.mode).toBe("px");
    } finally {
      lifecycle.dispose();
    }
  });

  describe("a page's new window", () => {
    const setup = () => {
      const browser = new MockBrowser();
      const agentLink: AgentLink = {
        msgs: () => new MessageQueue(),
        sendCmd: vi.fn(async () => ({ reqId: 1, ok: true })),
      };
      const lifecycle = createTabLifecycle({
        browser,
        agentLink,
        sessionId: "session/a",
        assetTokenKey: Buffer.alloc(32, 7),
        publish: () => {},
      });
      const active = () =>
        lifecycle.tabsMessage().then((message) => message.tabs.find((tab) => tab.active)?.id);
      return { browser, active };
    };

    it("comes to the front, and a page opened without an opener stays behind", async () => {
      const { browser, active } = setup();
      browser.attach({ targetId: "opener", sessionId: "cdp-opener", type: "page" });
      browser.attach({ targetId: "behind", sessionId: "cdp-behind", type: "page" });
      expect(await active()).toBe("opener");

      browser.attach({
        targetId: "window",
        sessionId: "cdp-window",
        type: "page",
        openerTabId: "opener",
      });

      await vi.waitFor(async () => expect(await active()).toBe("window"));
    });

    it("tells viewers it is active before sending what it shows, which they would otherwise drop", async () => {
      const browser = new MockBrowser();
      const published: Down[] = [];
      createTabLifecycle({
        browser,
        agentLink: {
          msgs: () => new MessageQueue(),
          sendCmd: vi.fn(async () => ({ reqId: 1, ok: true })),
        },
        sessionId: "session/a",
        assetTokenKey: Buffer.alloc(32, 7),
        publish: (message) => published.push(message),
      });
      browser.attach({ targetId: "opener", sessionId: "cdp-opener", type: "page" });

      browser.attach({
        targetId: "window",
        sessionId: "cdp-window",
        type: "page",
        openerTabId: "opener",
      });

      await vi.waitFor(() =>
        expect(
          published.some((message) => message.t === "resync" && message.tab === "window"),
        ).toBe(true),
      );
      const announced = published.findIndex(
        (message) =>
          message.t === "tabs" && message.tabs.some((tab) => tab.id === "window" && tab.active),
      );
      const caughtUp = published.findIndex(
        (message) => message.t === "resync" && message.tab === "window",
      );
      expect(announced).toBeGreaterThanOrEqual(0);
      expect(announced).toBeLessThan(caughtUp);
    });

    it("returns to its opener when it closes itself, as one that starts a download does", async () => {
      const { browser, active } = setup();
      const window: TargetRef = {
        targetId: "window",
        sessionId: "cdp-window",
        type: "page",
        openerTabId: "opener",
      };
      browser.attach({ targetId: "opener", sessionId: "cdp-opener", type: "page" });
      browser.attach({ targetId: "other", sessionId: "cdp-other", type: "page" });
      browser.attach(window);
      await vi.waitFor(async () => expect(await active()).toBe("window"));

      browser.detach(window);

      await vi.waitFor(async () => expect(await active()).toBe("opener"));
    });
  });

  it("creates per-page hubs, debounces proxied tab metadata, buffers background tabs, and activates a neighbor on close", async () => {
    vi.useFakeTimers();
    const browser = new MockBrowser();
    const streams = new Map<string, MessageQueue>();
    const agentLink: AgentLink = {
      msgs(tabId) {
        const stream = streams.get(tabId) ?? new MessageQueue();
        streams.set(tabId, stream);
        return stream;
      },
      sendCmd: vi.fn(async (_tabId, _cmd) => ({ reqId: 1, ok: true })),
    };
    const published: Down[] = [];
    const key = Buffer.alloc(32, 7);
    const lifecycle = createTabLifecycle({
      browser,
      agentLink,
      sessionId: "session/a",
      assetTokenKey: key,
      debounceMs: 25,
      publish: (message) => published.push(message),
    });
    const first: TargetRef = { targetId: "tab-1", sessionId: "cdp-1", type: "page" };
    const popup: TargetRef = {
      targetId: "tab-2",
      sessionId: "cdp-2",
      type: "page",
    };

    browser.attach(first);
    browser.attach(popup);
    expect(lifecycle.size).toBe(2);
    expect(lifecycle.hubFor("tab-1")).toBeDefined();
    expect(lifecycle.hubFor("tab-2")).toBeDefined();
    expect(lifecycle.activeTabId).toBe("tab-1");

    const background = streams.get("tab-2")!;
    background.push(hello(1));
    background.push(
      event(EventType.Meta, { href: "https://popup.test", width: 900, height: 600 }, 1),
    );
    background.push(
      event(
        EventType.FullSnapshot,
        { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } },
        2,
      ),
    );
    background.push(
      event(
        EventType.IncrementalSnapshot,
        { source: IncrementalSource.Scroll, id: 0, x: 0, y: 10 },
        3,
      ),
    );
    await vi.waitFor(() => expect(lifecycle.hubFor("tab-2")?.seq).toBe(2));
    expect(published.some((message) => "tab" in message && message.tab === "tab-2")).toBe(false);

    browser.info({
      targetId: "tab-1",
      type: "page",
      url: "https://one.test/first",
      title: "old title",
    });
    browser.info({
      targetId: "tab-1",
      type: "page",
      url: "https://one.test/latest",
      title: "One latest",
    });
    browser.info({
      targetId: "tab-2",
      type: "page",
      url: "https://popup.test/",
      title: "Popup",
      openerTabId: "tab-1",
    });
    const broadcastsBeforeDebounce = published.filter((message) => message.t === "tabs").length;
    await vi.advanceTimersByTimeAsync(24);
    expect(published.filter((message) => message.t === "tabs")).toHaveLength(
      broadcastsBeforeDebounce,
    );
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(published.filter((message) => message.t === "tabs")).toHaveLength(
        broadcastsBeforeDebounce + 1,
      ),
    );

    const tabsMessage = published.filter((message) => message.t === "tabs").at(-1);
    expect(tabsMessage?.t).toBe("tabs");
    if (tabsMessage?.t !== "tabs") throw new Error("tabs message missing");
    expect(tabsMessage.tabs.map(({ id, title, active }) => ({ id, title, active }))).toEqual([
      { id: "tab-1", title: "One latest", active: true },
      { id: "tab-2", title: "Popup", active: false },
    ]);
    const proxied = new URL(tabsMessage.tabs[1]!.favicon!, "https://gateway.test");
    expect(proxied.pathname).toMatch(/^\/s\/session%2Fa\/a\//);
    expect(openAssetToken(proxied.pathname.split("/").at(-1)!, key)).toEqual({
      url: "https://icons.test/cdp-2.png",
      sessionId: "session/a",
      tabId: "tab-2",
    });
    expect(
      browser.sessionCalls.find(
        ({ sessionId, method }) => sessionId === "cdp-2" && method === "Runtime.evaluate",
      ),
    ).toMatchObject({
      method: "Runtime.evaluate",
      params: { returnByValue: true, timeout: 200 },
    });

    await lifecycle.handle({ t: "nav", tab: "tab-1", action: "close" });
    expect(lifecycle.hubFor("tab-1")).toBeUndefined();
    expect(lifecycle.activeTabId).toBe("tab-2");
    expect(browser.browserCalls.slice(-2)).toEqual([
      { method: "Target.closeTarget", params: { targetId: "tab-1" } },
      { method: "Target.activateTarget", params: { targetId: "tab-2" } },
    ]);
    expect(published.some((message) => message.t === "snapshot" && message.tab === "tab-2")).toBe(
      true,
    );
    expect(published.some((message) => message.t === "delta" && message.tab === "tab-2")).toBe(
      true,
    );
    lifecycle.dispose();
  });

  it("maps new-tab and activate actions to browser-level Target commands", async () => {
    const browser = new MockBrowser();
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: {
        msgs: () => new MessageQueue(),
        sendCmd: async () => ({ reqId: 1, ok: true }),
      },
      sessionId: "session",
      assetTokenKey: Buffer.alloc(32, 9),
      publish: () => undefined,
    });
    browser.attach({ targetId: "tab-1", sessionId: "cdp-1", type: "page" });

    await lifecycle.handle({
      t: "nav",
      tab: "tab-1",
      action: "newtab",
      url: "https://new.test/",
    });
    browser.attach({ targetId: "created-tab", sessionId: "cdp-new", type: "page" });
    await lifecycle.handle({ t: "nav", tab: "tab-1", action: "activate" });

    expect(browser.browserCalls).toEqual([
      {
        method: "Target.createTarget",
        params: { url: "https://new.test/" },
      },
      { method: "Target.activateTarget", params: { targetId: "created-tab" } },
      { method: "Target.activateTarget", params: { targetId: "tab-1" } },
    ]);
    lifecycle.dispose();
  });

  it("creates and activates a replacement before closing the sole tab", async () => {
    const browser = new MockBrowser();
    browser.autoAttachCreatedTarget = true;
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: {
        msgs: () => new MessageQueue(),
        sendCmd: async () => ({ reqId: 1, ok: true }),
      },
      sessionId: "session",
      assetTokenKey: Buffer.alloc(32, 10),
      publish: () => undefined,
    });
    browser.attach({ targetId: "old-tab", sessionId: "cdp-old", type: "page" });

    await lifecycle.handle({ t: "nav", tab: "old-tab", action: "close" });

    expect(browser.browserCalls).toEqual([
      { method: "Target.createTarget", params: { url: "https://claude.ai/new" } },
      { method: "Target.activateTarget", params: { targetId: "created-tab" } },
      { method: "Target.closeTarget", params: { targetId: "old-tab" } },
    ]);
    const message = await lifecycle.tabsMessage();
    expect(message.tabs.map(({ id, active }) => ({ id, active }))).toEqual([
      { id: "created-tab", active: true },
    ]);
    lifecycle.dispose();
  });

  it("always rewrites images in the real lifecycle without optional entrypoint wiring", async () => {
    const browser = new MockBrowser();
    const stream = new MessageQueue();
    const key = Buffer.alloc(32, 8);
    const lifecycle = createTabLifecycle({
      browser,
      assetTokenKey: key,
      sessionId: "session",
      agentLink: { msgs: () => stream, sendCmd: async () => ({ reqId: 1, ok: true }) },
      publish: () => undefined,
    });
    browser.attach({ targetId: "tab", sessionId: "cdp", type: "page" });
    stream.push(hello(1));
    stream.push(event(EventType.Meta, { href: "https://reader.example/chapter/" }, 1));
    stream.push(
      event(
        EventType.FullSnapshot,
        {
          node: { type: 2, id: 1, tagName: "img", attributes: { src: "page.png" }, childNodes: [] },
          initialOffset: { top: 0, left: 0 },
        },
        2,
      ),
    );
    try {
      await vi.waitFor(() => expect(lifecycle.hubFor("tab")?.snapshot).not.toBeNull());
      const snapshot = lifecycle.hubFor("tab")!.snapshot!;
      const src = (snapshot.data as any).node.attributes.src as string;
      expect(src).toMatch(/^\/s\/session\/a\//);
      expect(openAssetToken(src.split("/").at(-1)!, key)).toEqual({
        url: "https://reader.example/chapter/page.png",
        sessionId: "session",
        tabId: "*",
      });
    } finally {
      lifecycle.dispose();
    }
  });

  it("reactively creates a tab when detaching the final page leaves none", async () => {
    const browser = new MockBrowser();
    browser.autoAttachCreatedTarget = true;
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: {
        msgs: () => new MessageQueue(),
        sendCmd: async () => ({ reqId: 1, ok: true }),
      },
      sessionId: "session",
      assetTokenKey: Buffer.alloc(32, 11),
      publish: () => undefined,
    });
    const only = { targetId: "only-tab", sessionId: "cdp-only", type: "page" } as const;
    browser.attach(only);

    browser.detach(only);

    await vi.waitFor(() =>
      expect(browser.browserCalls).toEqual([
        { method: "Target.createTarget", params: { url: "https://claude.ai/new" } },
        { method: "Target.activateTarget", params: { targetId: "created-tab" } },
      ]),
    );
    expect(lifecycle.size).toBe(1);
    expect(lifecycle.activeTabId).toBe("created-tab");
    lifecycle.dispose();
  });

  it("creates the first tab before building a tabs message from empty state", async () => {
    const browser = new MockBrowser();
    browser.autoAttachCreatedTarget = true;
    const lifecycle = createTabLifecycle({
      browser,
      agentLink: {
        msgs: () => new MessageQueue(),
        sendCmd: async () => ({ reqId: 1, ok: true }),
      },
      sessionId: "session",
      assetTokenKey: Buffer.alloc(32, 12),
      publish: () => undefined,
    });

    const message = await lifecycle.tabsMessage();

    expect(browser.browserCalls).toEqual([
      { method: "Target.createTarget", params: { url: "https://claude.ai/new" } },
      { method: "Target.activateTarget", params: { targetId: "created-tab" } },
    ]);
    expect(message.tabs.map(({ id, active }) => ({ id, active }))).toEqual([
      { id: "created-tab", active: true },
    ]);
    lifecycle.dispose();
  });
});
