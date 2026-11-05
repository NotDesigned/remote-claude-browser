import { describe, expect, it, vi } from "vitest";
import type { TargetRef } from "../types";
import type {
  BrowserHandle,
  BrowserSessionEventMap,
  BrowserTargetInfo,
  FlatSessionEventMap,
} from "./launch";
import { afterSignInUrl, createClientBrowserPool } from "./client-scope";

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

  it("hands over a new window after every other listener has seen it attach", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    browser.attach(page("opener"));
    pool.adopt("a", "opener");
    const order: string[] = [];
    browser.onAttached((target) => order.push(`later listener ${target.targetId}`));
    a.onAttached((target) => order.push(`session ${target.targetId}`));

    browser.attach({ ...page("window"), openerTabId: "opener" });
    await Promise.resolve();

    expect(order.filter((entry) => entry.endsWith("window"))).toEqual([
      "later listener window",
      "session window",
    ]);
    expect(pool.ownerOf("window")).toBe("a");
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
      left: 0,
      top: 0,
      width: 1050,
      height: 980,
    });
    expect(new Set(a.targets().map((t) => t.targetId))).toEqual(
      new Set(["created", "child", "nested", "popup"]),
    );
    expect(attached).toHaveBeenCalledTimes(4);
    expect(b.targets()).toEqual([]);
    for (const id of ["created", "child", "nested", "popup"]) expect(pool.ownerOf(id)).toBe("a");
    pool.dispose();
  });

  it("opens each window where an edge of it stays visible, left of the picture slots", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a");
    let created = 0;
    browser.create = async () => {
      const targetId = `created-${created++}`;
      browser.attach(page(targetId));
      return { targetId };
    };
    await a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    await a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    expect(browser.sendBrowser).toHaveBeenLastCalledWith(
      "Target.createTarget",
      expect.objectContaining({ left: 10, top: 10 }),
    );
    pool.dispose();
  });

  it("lets a client move only its own window", async () => {
    const browser = new FakeBrowser(),
      pool = createClientBrowserPool(browser),
      a = pool.scope("a"),
      b = pool.scope("b");
    browser.create = async () => {
      browser.attach(page("created"));
      return { targetId: "created" };
    };
    await a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    browser.sendBrowser.mockResolvedValue({ windowId: 7 });
    await expect(
      b.sendBrowser!("Browser.getWindowForTarget", { targetId: "created" }),
    ).rejects.toThrow("does not belong");
    const move = { windowId: 7, bounds: { left: 0, top: 0 } };
    await expect(a.sendBrowser!("Browser.setWindowBounds", move)).rejects.toThrow(
      "does not belong",
    );
    await a.sendBrowser!("Browser.getWindowForTarget", { targetId: "created" });
    await a.sendBrowser!("Browser.setWindowBounds", move);
    expect(browser.sendBrowser).toHaveBeenCalledWith("Browser.setWindowBounds", move);
    await expect(b.sendBrowser!("Browser.setWindowBounds", move)).rejects.toThrow(
      "does not belong",
    );
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
  it("opens every window in the shared profile, so its website storage outlasts the session", async () => {
    const browser = new FakeBrowser();
    const original = browser.sendBrowser.getMockImplementation()!;
    let pageNumber = 0;
    browser.sendBrowser.mockImplementation(async (method, params = {}) => {
      if (method !== "Target.createTarget") return original(method, params);
      const targetId = `shared-page-${++pageNumber}`;
      browser.attach({ targetId, sessionId: `session-${pageNumber}`, type: "page" });
      return { targetId };
    });
    const pool = createClientBrowserPool(browser as never);
    const a = pool.scope("client-a");
    await a.sendBrowser!("Target.createTarget", { url: "about:blank" });
    await pool.scope("client-b").sendBrowser!("Target.createTarget", { url: "about:blank" });
    await a.close();
    const methods = browser.sendBrowser.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("Target.createBrowserContext");
    expect(methods).not.toContain("Target.disposeBrowserContext");
    expect(
      browser.sendBrowser.mock.calls.filter(([method]) => method === "Target.createTarget"),
    ).toSatisfy((calls: [string, Record<string, unknown>][]) =>
      calls.every(([, params]) => params.browserContextId === undefined),
    );
    pool.dispose();
  });
});

describe("noticing a sign-in", () => {
  const login = (value?: string) => ({
    cookies: value ? [{ name: "sessionKey", domain: ".claude.ai", value }] : [],
  });

  it("reports a new login once, and neither the first reading nor a sign-out", async () => {
    vi.useFakeTimers();
    try {
      const browser = new FakeBrowser();
      let current = login("first");
      browser.sendBrowser.mockImplementation(async (method) =>
        method === "Storage.getCookies" ? current : {},
      );
      const onSignedIn = vi.fn();
      const pool = createClientBrowserPool(browser as never, { onSignedIn });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onSignedIn).not.toHaveBeenCalled();
      current = login();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onSignedIn).not.toHaveBeenCalled();
      current = login("second");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onSignedIn).toHaveBeenCalledTimes(1);
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("leaving Claude's sign-in pages", () => {
  it("returns to the requested page, never to another site or sign-in page", () => {
    const login = "https://claude.ai/login?from=logout&reauth=1&returnTo=";
    expect(afterSignInUrl(login + "%2Fcode")).toBe("https://claude.ai/code");
    expect(afterSignInUrl(login + "%2Flogin%3Fa%3D1")).toBe("https://claude.ai/new");
    expect(afterSignInUrl(login + "%2F%2Fevil.example")).toBe("https://claude.ai/new");
    expect(afterSignInUrl(login + "https%3A%2F%2Fevil.example")).toBe("https://claude.ai/new");
    expect(afterSignInUrl("https://claude.ai/logout?involuntary=1")).toBe("https://claude.ai/new");
    expect(afterSignInUrl("https://claude.ai/chat/abc")).toBeNull();
    expect(afterSignInUrl("https://accounts.google.com/login")).toBeNull();
    expect(afterSignInUrl(undefined)).toBeNull();
  });
});
