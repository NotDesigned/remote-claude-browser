import { afterEach, describe, expect, it, vi } from "vitest";
import type { Protocol } from "puppeteer-core";
import type { Down } from "@mirror/protocol";
import type { TargetRef } from "../types";
import { createRendererRecovery } from "./recovery";

function fixture() {
  let crashed: (event: Protocol.Target.TargetCrashedEvent) => void = () => {};
  let detached: (target: TargetRef) => void = () => {};
  const messages: Down[] = [];
  const send = vi.fn(async () => ({}));
  const invalidateDocument = vi.fn(),
    onCrash = vi.fn(),
    onError = vi.fn();
  const recovery = createRendererRecovery({
    browser: {
      send,
      onBrowserEvent: vi.fn((_method, callback) => {
        crashed = callback as typeof crashed;
        return vi.fn();
      }),
      onDetached: (callback) => {
        detached = callback;
      },
    },
    sessionFor: (tab) => (tab === "page" ? "session" : undefined),
    hubFor: (tab) => (tab === "page" ? ({ invalidateDocument } as never) : undefined),
    publish: (message) => messages.push(message),
    onCrash,
    onError,
    recoveryMs: 100,
  });
  return {
    recovery,
    messages,
    send,
    invalidateDocument,
    onCrash,
    onError,
    crash: () => crashed({ targetId: "page", status: "crashed", errorCode: 123 }),
    detach: () => detached({ targetId: "page", sessionId: "session", type: "page" }),
  };
}
describe("renderer recovery", () => {
  afterEach(() => vi.useRealTimers());
  it("invalidates a dead document and waits for a fresh snapshot before becoming ready", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.crash();
    expect(f.invalidateDocument).toHaveBeenCalledOnce();
    expect(f.onCrash).toHaveBeenCalledWith("page");
    expect(f.send).toHaveBeenCalledWith("session", "Page.reload", { ignoreCache: false });
    expect(f.recovery.isBlocked("page")).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.recovery.isBlocked("page")).toBe(true);
    f.recovery.noteSnapshot("page");
    expect(f.messages).toEqual([
      { t: "tab-state", tab: "page", state: "recovering" },
      { t: "tab-state", tab: "page", state: "ready" },
    ]);
    expect(f.recovery.isBlocked("page")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    f.recovery.dispose();
  });
  it("reports a hung reload without replaying inputs or restarting the browser", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.send.mockImplementation(() => new Promise(() => {}));
    f.crash();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.recovery.status()).toEqual([{ t: "tab-state", tab: "page", state: "failed" }]);
    expect(f.recovery.isBlocked("page")).toBe(true);
    expect(f.send).toHaveBeenCalledOnce();
    f.recovery.dispose();
  });
  it("stops automatic reloads after two crashes in a minute", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.crash();
    f.recovery.noteSnapshot("page");
    f.crash();
    f.recovery.noteSnapshot("page");
    f.crash();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.recovery.status()[0]?.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    f.recovery.dispose();
  });
  it("ignores a late reload failure after a new document is already ready", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let reject: (error: Error) => void = () => {};
    f.send.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    f.crash();
    f.recovery.noteSnapshot("page");
    reject(new Error("old command"));
    await Promise.resolve();
    expect(f.recovery.status()).toEqual([]);
    expect(f.messages.at(-1)).toMatchObject({ state: "ready" });
    f.recovery.dispose();
  });
  it("cancels recovery timers on detach and disposal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.crash();
    f.detach();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.recovery.status()).toEqual([]);
    expect(f.messages).toHaveLength(1);
    f.crash();
    f.recovery.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.messages).toHaveLength(2);
  });
});
