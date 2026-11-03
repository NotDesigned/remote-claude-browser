import { describe, expect, it, vi } from "vitest";
import type { TargetRef } from "../types";
import type {
  BrowserHandle,
  BrowserSessionEventMap,
  BrowserTargetInfo,
  FlatSessionEventMap,
} from "./launch";
import { createClientBrowserPool } from "./client-scope";

class FakeBrowser implements BrowserHandle {
  readonly refs = new Map<string, TargetRef>();
  readonly infos = new Map<string, BrowserTargetInfo>();
  readonly attached = new Set<(target: TargetRef) => void>();
  readonly detached = new Set<(target: TargetRef) => void>();
  readonly changed = new Set<(info: BrowserTargetInfo) => void>();
  readonly sessionEvents = new Map<string, Set<(session: string, event: unknown) => void>>();
  readonly browserEvents = new Map<string, Set<(event: unknown) => void>>();
  create: (params: Record<string, unknown>) => Promise<unknown> = async () => ({
    targetId: "created",
  });
  send = vi.fn(
    async (
      _session: string,
      _method: string,
      _params?: Record<string, unknown>,
    ): Promise<unknown> => ({}),
  );
  sendBrowser = vi.fn(
    async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === "Target.createTarget") return this.create(params);
      if (method === "Target.closeTarget") {
        const ref = this.refs.get(params.targetId as string);
        if (ref) this.detach(ref);
      }
      return { success: true };
    },
  );
  close = vi.fn(async () => {});
  kill = vi.fn(async () => {});
  isAlive = () => true;
  onAttached(callback: (target: TargetRef) => void) {
    this.attached.add(callback);
    for (const target of this.refs.values()) callback(target);
  }
  onDetached(callback: (target: TargetRef) => void) {
    this.detached.add(callback);
  }
  onTargetInfoChanged(callback: (info: BrowserTargetInfo) => void) {
    this.changed.add(callback);
    for (const info of this.infos.values()) callback(info);
  }
  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    callback: (session: string, event: FlatSessionEventMap[K]) => void,
  ) {
    const callbacks = this.sessionEvents.get(method) ?? new Set();
    this.sessionEvents.set(method, callbacks);
    callbacks.add(callback as (session: string, event: unknown) => void);
    return () => callbacks.delete(callback as (session: string, event: unknown) => void);
  }
  onBrowserEvent<K extends keyof BrowserSessionEventMap>(
    method: K,
    callback: (event: BrowserSessionEventMap[K]) => void,
  ) {
    const callbacks = this.browserEvents.get(method) ?? new Set();
    this.browserEvents.set(method, callbacks);
    callbacks.add(callback as (event: unknown) => void);
    return () => callbacks.delete(callback as (event: unknown) => void);
  }
  attach(target: TargetRef) {
    this.refs.set(target.targetId, target);
    for (const cb of this.attached) cb(target);
  }
  detach(target: TargetRef) {
    if (this.refs.get(target.targetId)?.sessionId === target.sessionId)
      this.refs.delete(target.targetId);
    for (const cb of this.detached) cb(target);
  }
  info(info: BrowserTargetInfo) {
    this.infos.set(info.targetId, info);
    for (const cb of this.changed) cb(info);
  }
  sessionEvent(session: string, event: unknown) {
    for (const cb of this.sessionEvents.get("Runtime.bindingCalled") ?? []) cb(session, event);
  }
  crash(targetId: string) {
    for (const cb of this.browserEvents.get("Target.targetCrashed") ?? [])
      cb({ targetId, status: "crashed", errorCode: 3 });
  }
}
const page = (id: string): TargetRef => ({ targetId: id, sessionId: `cdp-${id}`, type: "page" });
const frame = (id: string, parentTargetId: string, sessionId = `cdp-${id}`): TargetRef => ({
  targetId: id,
  sessionId,
  type: "iframe",
  parentTargetId,
});

describe("shared-browser client scopes", () => {
  it("adopts only the selected page and replays its target and metadata to subscribers", () => {
    const browser = new FakeBrowser();
    browser.attach(page("first"));
    browser.attach(page("second"));
    browser.info({
      targetId: "first",
      type: "page",
      url: "https://fixture.test/one",
      title: "First",
    });
    const pool = createClientBrowserPool(browser),
      a = pool.scope("a"),
      b = pool.scope("b");
    const attach = vi.fn(),
      metadata = vi.fn();
    a.onAttached(attach);
    a.onTargetInfoChanged(metadata);
    pool.adopt("a", "first");
    expect(attach).toHaveBeenCalledExactlyOnceWith(page("first"));
    expect(metadata).toHaveBeenCalledExactlyOnceWith(browser.infos.get("first"));
    expect(a.targets()).toEqual([page("first")]);
    expect(b.targets()).toEqual([]);
    expect(pool.unownedPages()).toEqual([page("second")]);
    const late = vi.fn();
    a.onAttached(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(page("first"));
    expect(() => pool.adopt("b", "first")).toThrow("another client");
    pool.dispose();
  });

  it("rejects cross-client sessions and global browser commands before raw CDP dispatch", async () => {
    const browser = new FakeBrowser();
    browser.attach(page("one"));
    browser.attach(page("two"));
    const pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    pool.scope("b");
    pool.adopt("a", "one");
    pool.adopt("b", "two");
    await expect(a.send("cdp-two", "Input.insertText", { text: "other client" })).rejects.toThrow(
      "does not belong",
    );
    await expect(a.send("cdp-one", "Browser.close")).rejects.toThrow("Browser-level");
    await expect(a.send("cdp-one", "Target.activateTarget", { targetId: "two" })).rejects.toThrow(
      "Browser-level",
    );
    await expect(a.sendBrowser!("Target.closeTarget", { targetId: "two" })).rejects.toThrow(
      "does not belong",
    );
    await expect(a.sendBrowser!("Target.activateTarget", { targetId: "two" })).rejects.toThrow(
      "does not belong",
    );
    await expect(
      a.sendBrowser!("Browser.setDownloadBehavior", { downloadPath: "/tmp/other" }),
    ).rejects.toThrow("not available");
    expect(browser.send).not.toHaveBeenCalled();
    expect(browser.sendBrowser).not.toHaveBeenCalled();
    await a.send("cdp-one", "Input.insertText", { text: "own client" });
    await a.sendBrowser!("Target.activateTarget", { targetId: "one" });
    expect(browser.send).toHaveBeenCalledExactlyOnceWith("cdp-one", "Input.insertText", {
      text: "own client",
    });
    expect(browser.sendBrowser).toHaveBeenCalledExactlyOnceWith("Target.activateTarget", {
      targetId: "one",
    });
    pool.dispose();
  });

  it("claims attach-before-create results and all pending popup/iframe descendants", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a"),
      b = pool.scope("b");
    const attached = vi.fn();
    a.onAttached(attached);
    browser.create = async () => {
      browser.attach(frame("nested", "child"));
      browser.attach(frame("child", "created"));
      browser.attach({ ...page("popup"), openerTabId: "created" });
      browser.attach(page("created"));
      return { targetId: "created" };
    };
    await a.sendBrowser!("Target.createTarget", { url: "https://fixture.test", newWindow: false });
    expect(browser.sendBrowser).toHaveBeenCalledWith("Target.createTarget", {
      url: "https://fixture.test",
      newWindow: true,
    });
    expect(new Set(a.targets().map((t) => t.targetId))).toEqual(
      new Set(["created", "child", "nested", "popup"]),
    );
    expect(attached).toHaveBeenCalledTimes(4);
    expect(b.targets()).toEqual([]);
    for (const id of ["created", "child", "nested", "popup"]) expect(pool.ownerOf(id)).toBe("a");
    pool.dispose();
  });

  it("claims create-ack-before-attach and late parent metadata without another client's events", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a"),
      b = pool.scope("b");
    const aa = vi.fn(),
      bb = vi.fn();
    a.onAttached(aa);
    b.onAttached(bb);
    let settled = false;
    const creating = a.sendBrowser!("Target.createTarget", { url: "about:blank" }).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(pool.ownerOf("created")).toBe("a"));
    expect(aa).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    browser.attach(page("created"));
    await creating;
    await expect(a.sendBrowser!("Target.activateTarget", { targetId: "created" })).resolves.toEqual(
      { success: true },
    );
    browser.attach({ targetId: "late-child", sessionId: "cdp-child", type: "iframe" });
    browser.info({
      targetId: "late-child",
      type: "iframe",
      url: "https://frame.test",
      title: "",
      parentTargetId: "created",
    });
    expect(aa).toHaveBeenCalledTimes(2);
    expect(bb).not.toHaveBeenCalled();
    expect(pool.ownerOf("late-child")).toBe("a");
    await expect(
      a.sendBrowser!("Target.createTarget", { url: "about:blank", browserContextId: "escape" }),
    ).rejects.toThrow("shared browser profile");
    pool.dispose();
  });

  it("filters session and crash events and leaves download events for the shared router", () => {
    const browser = new FakeBrowser();
    browser.attach(page("one"));
    browser.attach(page("two"));
    browser.attach(frame("iframe-one", "one"));
    const pool = createClientBrowserPool(browser),
      a = pool.scope("a"),
      b = pool.scope("b");
    pool.adopt("a", "one");
    pool.adopt("b", "two");
    const ae = vi.fn(),
      be = vi.fn(),
      ac = vi.fn(),
      bc = vi.fn();
    const off = a.onSessionEvent("Runtime.bindingCalled", ae);
    b.onSessionEvent("Runtime.bindingCalled", be);
    a.onBrowserEvent!("Target.targetCrashed", ac);
    b.onBrowserEvent!("Target.targetCrashed", bc);
    browser.sessionEvent("cdp-iframe-one", { payload: "one" });
    browser.sessionEvent("cdp-two", { payload: "two" });
    expect(ae).toHaveBeenCalledExactlyOnceWith("cdp-iframe-one", { payload: "one" });
    expect(be).toHaveBeenCalledExactlyOnceWith("cdp-two", { payload: "two" });
    browser.crash("one");
    expect(ac).toHaveBeenCalledOnce();
    expect(bc).not.toHaveBeenCalled();
    expect(() => a.onBrowserEvent!("Browser.downloadWillBegin", vi.fn())).toThrow(
      "shared browser download manager",
    );
    off();
    browser.sessionEvent("cdp-one", {});
    expect(ae).toHaveBeenCalledOnce();
    a.dispose();
    browser.crash("one");
    expect(ac).toHaveBeenCalledOnce();
    pool.dispose();
  });

  it("keeps ownership on process swap and ignores the old session's delayed detach", async () => {
    const browser = new FakeBrowser();
    browser.attach(page("one"));
    const pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    pool.adopt("a", "one");
    const old = frame("child", "one", "old"),
      next = frame("child", "one", "new");
    browser.attach(old);
    browser.attach(next);
    browser.detach(old);
    expect(pool.ownerOf("child")).toBe("a");
    await expect(a.send("old", "Page.getLayoutMetrics")).rejects.toThrow("does not belong");
    await expect(a.send("new", "Page.getLayoutMetrics")).resolves.toEqual({});
    pool.dispose();
  });

  it("closes only its own windows and cannot recreate pages during shutdown", async () => {
    const browser = new FakeBrowser();
    browser.attach(page("one"));
    browser.attach(page("two"));
    const pool = createClientBrowserPool(browser),
      a = pool.scope("a"),
      b = pool.scope("b");
    pool.adopt("a", "one");
    pool.adopt("b", "two");
    const recreation: Promise<unknown>[] = [];
    a.onDetached(() => {
      const pending = a.sendBrowser!("Target.createTarget", { url: "about:blank" });
      void pending.catch(() => {});
      recreation.push(pending);
    });
    await a.close();
    await expect(recreation[0]).rejects.toThrow("closed");
    expect(browser.sendBrowser).toHaveBeenCalledExactlyOnceWith("Target.closeTarget", {
      targetId: "one",
    });
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.kill).not.toHaveBeenCalled();
    expect(b.isAlive?.()).toBe(true);
    expect(b.targets()).toEqual([page("two")]);
    expect(a.isAlive?.()).toBe(false);
    pool.dispose();
  });

  it("closes a target created after its facade was disposed, without claiming it", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    let complete!: (value: unknown) => void;
    browser.create = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const creating = a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    a.dispose();
    browser.attach(page("late"));
    complete({ targetId: "late" });
    await expect(creating).rejects.toThrow("closed while creating");
    expect(browser.sendBrowser).toHaveBeenCalledWith("Target.closeTarget", { targetId: "late" });
    expect(pool.ownerOf("late")).toBeUndefined();
    expect(pool.scope("a").targets()).toEqual([]);
    pool.dispose();
  });

  it("closes an acknowledged target whose flat session never arrived when disposed", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    const creating = a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    // Observe the rejection immediately because dispose synchronously rejects the attach wait.
    void creating.catch(() => {});
    await vi.waitFor(() => expect(pool.ownerOf("created")).toBe("a"));
    a.dispose();
    await expect(creating).rejects.toThrow("closed while creating");
    expect(browser.sendBrowser).toHaveBeenCalledWith("Target.closeTarget", { targetId: "created" });
    expect(pool.ownerOf("created")).toBeUndefined();
    pool.dispose();
  });

  it("waits for an in-flight create acknowledgement before allowing the SID to close", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    let complete!: (value: unknown) => void;
    browser.create = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const creating = a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    void creating.catch(() => {});
    let closed = false;
    const closing = a.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    complete({ targetId: "late" });
    await expect(creating).rejects.toThrow("closed while creating");
    await closing;
    expect(browser.sendBrowser).toHaveBeenCalledWith("Target.closeTarget", { targetId: "late" });
    expect(closed).toBe(true);
    const replacement = pool.scope("a"),
      attached = vi.fn();
    replacement.onAttached(attached);
    // Even an attach already queued behind the close response cannot become the new owner's tab.
    browser.attach(page("late"));
    expect(attached).not.toHaveBeenCalled();
    expect(replacement.targets()).toEqual([]);
    expect(pool.unownedPages()).toEqual([]);
    pool.dispose();
  });

  it("hides a disposed facade's late page while cleanup is pending and its SID is reused", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    let complete!: (value: unknown) => void, finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    browser.create = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    browser.sendBrowser.mockImplementation(async (method, params = {}) => {
      if (method === "Target.createTarget") return browser.create(params);
      if (method === "Target.closeTarget") {
        await closeGate;
        const target = browser.refs.get(params.targetId as string);
        if (target) browser.detach(target);
      }
      return { success: true };
    });
    const creating = a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    void creating.catch(() => {});
    a.dispose();
    const replacement = pool.scope("a"),
      attached = vi.fn(),
      metadata = vi.fn(),
      event = vi.fn();
    replacement.onAttached(attached);
    replacement.onTargetInfoChanged(metadata);
    replacement.onSessionEvent("Runtime.bindingCalled", event);
    complete({ targetId: "late" });
    await vi.waitFor(() =>
      expect(browser.sendBrowser).toHaveBeenCalledWith("Target.closeTarget", { targetId: "late" }),
    );
    browser.attach(page("late"));
    browser.info({
      targetId: "late",
      type: "page",
      url: "https://private.fixture.test",
      title: "Old owner",
    });
    browser.sessionEvent("cdp-late", { payload: "private" });
    expect(attached).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(replacement.targets()).toEqual([]);
    expect(pool.ownerOf("late")).toBeUndefined();
    finishClose();
    await expect(creating).rejects.toThrow("closed while creating");
    pool.dispose();
  });
  it("creates private website storage and clones saved login cookies for each workspace", async () => {
    const browser = new FakeBrowser();
    let contextNumber = 0,
      pageNumber = 0;
    const original = browser.sendBrowser.getMockImplementation()!;
    browser.sendBrowser.mockImplementation(async (method, params = {}) => {
      if (method === "Target.createBrowserContext")
        return { browserContextId: `private-${++contextNumber}` };
      if (method === "Storage.getCookies")
        return {
          cookies: [
            {
              name: "sessionKey",
              value: params.browserContextId ? "fixture-refreshed" : "fixture-only",
              domain: ".claude.ai",
              path: "/",
              httpOnly: true,
              session: true,
              size: 10,
            },
          ],
        };
      return original(method, params);
    });
    browser.create = async () => {
      const target = page(`private-page-${++pageNumber}`);
      browser.attach(target);
      return { targetId: target.targetId };
    };
    const pool = createClientBrowserPool(browser, {
      isolatedStorage: true,
      downloadDir: "/fixture/downloads",
    });
    const a = pool.scope("a"),
      b = pool.scope("b");
    await Promise.all([
      a.sendBrowser!("Target.createTarget", { url: "https://claude.ai/new" }),
      b.sendBrowser!("Target.createTarget", { url: "https://claude.ai/new" }),
    ]);
    const createdPages = browser.sendBrowser.mock.calls.filter(
      ([method]) => method === "Target.createTarget",
    );
    expect(new Set(createdPages.map(([, params]) => params?.browserContextId)).size).toBe(2);
    const setCookies = browser.sendBrowser.mock.calls.filter(
      ([method]) => method === "Storage.setCookies",
    );
    expect(setCookies).toHaveLength(2);
    expect(setCookies[0]?.[1]?.cookies).toEqual([
      {
        name: "sessionKey",
        value: "fixture-only",
        domain: ".claude.ai",
        path: "/",
        httpOnly: true,
      },
    ]);
    expect(
      browser.sendBrowser.mock.calls.filter(([method]) => method === "Browser.setDownloadBehavior"),
    ).toHaveLength(2);
    await a.close();
    expect(browser.sendBrowser).toHaveBeenCalledWith("Target.disposeBrowserContext", {
      browserContextId: "private-1",
    });
    expect(browser.sendBrowser).toHaveBeenCalledWith("Storage.setCookies", {
      cookies: [
        {
          name: "sessionKey",
          value: "fixture-refreshed",
          domain: ".claude.ai",
          path: "/",
          httpOnly: true,
        },
      ],
    });
    expect(b.isAlive?.()).toBe(true);
    await b.close();
    pool.dispose();
  });
});

describe("shared login cookie write-back", () => {
  function setup(contextCookie: { value: string } | null, canPersist: () => boolean) {
    const browser = new FakeBrowser();
    let contextNumber = 0,
      pageNumber = 0;
    const original = browser.sendBrowser.getMockImplementation()!;
    browser.sendBrowser.mockImplementation(async (method, params = {}) => {
      if (method === "Target.createBrowserContext")
        return { browserContextId: `private-${++contextNumber}` };
      if (method === "Storage.getCookies") {
        const shared = { name: "sessionKey", value: "shared", domain: ".claude.ai", path: "/" };
        if (!params.browserContextId) return { cookies: [shared] };
        return {
          cookies:
            contextCookie === null
              ? [{ name: "other", value: "x", domain: ".claude.ai", path: "/" }]
              : [{ ...shared, value: contextCookie.value }],
        };
      }
      return original(method, params);
    });
    browser.create = async () => {
      const target = page(`cookie-page-${++pageNumber}`);
      browser.attach(target);
      return { targetId: target.targetId };
    };
    const pool = createClientBrowserPool(browser, {
      isolatedStorage: true,
      canPersistCookies: canPersist,
      cookieSyncIntervalMs: 1_000,
    });
    const writeBacks = () =>
      browser.sendBrowser.mock.calls.filter(
        ([method, params]) => method === "Storage.setCookies" && !params?.browserContextId,
      );
    return { browser, pool, writeBacks };
  }

  it("does not write back a session that is on a sign-in page when it closes", async () => {
    const { pool, writeBacks } = setup({ value: "refreshed" }, () => false);
    const a = pool.scope("a");
    await a.sendBrowser!("Target.createTarget", { url: "https://claude.ai/login" });
    await a.close();
    expect(writeBacks()).toHaveLength(0);
    pool.dispose();
  });

  it("never spreads a forced logout that cleared the login cookie", async () => {
    for (const lost of [null, { value: "" }]) {
      const { pool, writeBacks } = setup(lost, () => true);
      const a = pool.scope("a");
      await a.sendBrowser!("Target.createTarget", { url: "https://claude.ai/new" });
      await a.close();
      expect(writeBacks()).toHaveLength(0);
      pool.dispose();
    }
  });

  it("shares a refreshed login token periodically, without waiting for the session to end", async () => {
    vi.useFakeTimers();
    try {
      const { pool, writeBacks } = setup({ value: "rotated" }, () => true);
      const a = pool.scope("a");
      await a.sendBrowser!("Target.createTarget", { url: "https://claude.ai/new" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(writeBacks()).toEqual([
        [
          "Storage.setCookies",
          { cookies: [{ name: "sessionKey", value: "rotated", domain: ".claude.ai", path: "/" }] },
        ],
      ]);
      // Already shared: the next round and the final close have nothing new to write.
      await vi.advanceTimersByTimeAsync(1_000);
      await a.close();
      expect(writeBacks()).toHaveLength(1);
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
