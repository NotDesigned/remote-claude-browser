// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_RELOAD_RETRY_MS,
  createBuildSkew,
  RELOADED_FOR_KEY,
  VIEWER_BUILD,
} from "./build-skew";

afterEach(() => vi.useRealTimers());

function setup(own = "1+a.1", busy = false) {
  vi.useFakeTimers();
  const stored = new Map<string, string>();
  const state = { busy };
  const reload = vi.fn();
  const stale = vi.fn();
  const skew = createBuildSkew({
    own,
    busy: () => state.busy,
    reload,
    onStale: stale,
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
    },
  });
  return { skew, stored, state, reload, stale };
}

describe("viewer build skew", () => {
  it("is a development build under test, which never reloads", () => {
    expect(VIEWER_BUILD).toBe("dev");
    const h = setup("dev");
    h.skew.observe("1+b.2");
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.stale).toHaveBeenLastCalledWith(false);
  });

  it("stays put for its own build or a gateway that names none", () => {
    const h = setup();
    h.skew.observe("1+a.1");
    h.skew.observe(undefined);
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.stale).not.toHaveBeenCalledWith(true);
  });

  it("reloads at once for another build when nobody is typing", () => {
    const h = setup();
    h.skew.observe("1+b.2");
    expect(h.stale).toHaveBeenLastCalledWith(true);
    expect(h.reload).toHaveBeenCalledOnce();
    expect(h.stored.get(RELOADED_FOR_KEY)).toBe("1+b.2");
  });

  it("waits for typing to stop before reloading", () => {
    const h = setup("1+a.1", true);
    h.skew.observe("1+b.2");
    vi.advanceTimersByTime(BUILD_RELOAD_RETRY_MS * 3);
    expect(h.reload).not.toHaveBeenCalled();
    h.state.busy = false;
    vi.advanceTimersByTime(BUILD_RELOAD_RETRY_MS);
    expect(h.reload).toHaveBeenCalledOnce();
    // Every reconnect repeats the hello; that does not reload again.
    h.skew.observe("1+b.2");
    vi.advanceTimersByTime(BUILD_RELOAD_RETRY_MS * 3);
    expect(h.reload).toHaveBeenCalledOnce();
  });

  it("does not loop when a reload still left it on another build", () => {
    const h = setup();
    h.stored.set(RELOADED_FOR_KEY, "1+b.2");
    h.skew.observe("1+b.2");
    expect(h.stale).toHaveBeenLastCalledWith(true);
    expect(h.reload).not.toHaveBeenCalled();
    h.skew.reloadNow();
    expect(h.reload).toHaveBeenCalledOnce();
    // A later deploy is a different build: that one is worth a reload.
    h.skew.observe("1+c.3");
    expect(h.reload).toHaveBeenCalledTimes(2);
  });
});
