// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createInFlightGuard } from "./async-action";
import { safeDownloadHref } from "./auto-download";
import { isCpaBrowserAuthorization } from "./network-api";
import { tabForKey } from "./network-panel";
import { createBackdropDismiss } from "./panel";
import { readItem, readJson, removePrefixed, writeItem, type StorageArea } from "./storage";

describe("createInFlightGuard", () => {
  it("ignores a second start while the first action runs", async () => {
    const guard = createInFlightGuard();
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = guard.run(action);
    // A double click: the second press arrives before the re-render disables the button.
    await expect(guard.run(action)).resolves.toBe(false);
    expect(guard.busy).toBe(true);
    finish();
    await expect(first).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(guard.busy).toBe(false);
  });

  it("is free again after a failure", async () => {
    const guard = createInFlightGuard();
    await expect(guard.run(() => Promise.reject(new Error("失败")))).rejects.toThrow("失败");
    const action = vi.fn(async () => undefined);
    await expect(guard.run(action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("createBackdropDismiss", () => {
  const backdrop = {} as EventTarget;
  const field = {} as EventTarget;
  const on = (target: EventTarget) => ({ target, currentTarget: backdrop });

  it("closes on a press that starts and ends on the backdrop", () => {
    const close = vi.fn();
    const dismiss = createBackdropDismiss(close);
    dismiss.onPointerDown(on(backdrop));
    dismiss.onClick(on(backdrop));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stays open after selecting text in a field and letting go over the backdrop", () => {
    const close = vi.fn();
    const dismiss = createBackdropDismiss(close);
    dismiss.onPointerDown(on(field));
    dismiss.onClick(on(backdrop));
    expect(close).not.toHaveBeenCalled();
    // Nor does a later click without its own press on the backdrop count.
    dismiss.onClick(on(backdrop));
    expect(close).not.toHaveBeenCalled();
  });

  it("stays open for a press that starts on the backdrop but ends inside", () => {
    const close = vi.fn();
    const dismiss = createBackdropDismiss(close);
    dismiss.onPointerDown(on(backdrop));
    dismiss.onClick(on(field));
    expect(close).not.toHaveBeenCalled();
  });
});

function memory(values: Record<string, string> = {}): StorageArea {
  const map = new Map(Object.entries(values));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
}

const blocked: StorageArea = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("storage guards", () => {
  const authorization = { userId: "u", instanceId: "i", state: "s", proxyId: "p" };

  it("reads a valid stored authorization", () => {
    const area = memory({ "mirror-cpa-browser": JSON.stringify(authorization) });
    expect(readJson(area, "mirror-cpa-browser", isCpaBrowserAuthorization)).toEqual(authorization);
  });

  it("ignores unparsable, wrongly shaped and missing values instead of crashing", () => {
    for (const raw of ["{not json", "null", '"text"', '{"userId":"u"}', "[]"]) {
      const area = memory({ "mirror-cpa-browser": raw });
      expect(readJson(area, "mirror-cpa-browser", isCpaBrowserAuthorization)).toBeNull();
    }
    expect(readJson(memory(), "mirror-cpa-browser", isCpaBrowserAuthorization)).toBeNull();
  });

  it("fails soft when storage itself throws", () => {
    expect(readItem(blocked, "key")).toBeNull();
    expect(() => writeItem(blocked, "key", "value")).not.toThrow();
    expect(readJson(blocked, "key", isCpaBrowserAuthorization)).toBeNull();
    expect(() => removePrefixed(blocked, "mirror-cpa-")).not.toThrow();
  });

  it("removes only the prefixed keys", () => {
    const area = memory({ "mirror-cpa-browser": "1", "mirror-cpa-callback:x": "2", other: "3" });
    removePrefixed(area, "mirror-cpa-");
    expect(area.length).toBe(1);
    expect(area.getItem("other")).toBe("3");
  });
});

describe("safeDownloadHref", () => {
  const origin = "https://rcb.example";

  it("keeps the gateway's same-origin session links", () => {
    expect(safeDownloadHref("/s/client-1/d/key-4", origin)).toBe("/s/client-1/d/key-4");
    expect(safeDownloadHref(`${origin}/s/client-1/d/key?x=1`, origin)).toBe(
      "/s/client-1/d/key?x=1",
    );
  });

  it("refuses anything else", () => {
    for (const href of [
      undefined,
      "",
      "https://evil.example/s/client-1/d/key",
      "//evil.example/s/x",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/api/users",
      "/gate",
      "/s",
    ])
      expect(safeDownloadHref(href, origin), String(href)).toBeNull();
  });
});

describe("network tabs keyboard", () => {
  it("moves with the arrows (wrapping), Home and End", () => {
    expect(tabForKey("proxies", "ArrowRight")).toBe("cpa");
    expect(tabForKey("remote-cc", "ArrowRight")).toBe("proxies");
    expect(tabForKey("proxies", "ArrowLeft")).toBe("remote-cc");
    expect(tabForKey("cpa", "Home")).toBe("proxies");
    expect(tabForKey("cpa", "End")).toBe("remote-cc");
    expect(tabForKey("cpa", "Enter")).toBeNull();
  });
});
