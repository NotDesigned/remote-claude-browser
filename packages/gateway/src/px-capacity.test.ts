import { describe, expect, it, vi } from "vitest";
import { createPixelCapacity } from "./px-capacity";

describe("global pixel capacity", () => {
  it("supports concurrent pixel workspaces and releases only the owning workspace", () => {
    const capacity = createPixelCapacity({ maxActive: Infinity });
    for (let i = 1; i <= 16; i++) expect(capacity.acquire(`client-${i}`, `tab-${i}`)).toBe(true);
    expect(capacity.count()).toBe(16);
    expect(capacity.available()).toBe(true);
    expect(capacity.acquire("client-1", "tab-1")).toBe(false);
    capacity.release("client-1", "tab-2");
    expect(capacity.count()).toBe(16);
    capacity.release("client-1", "tab-1");
    expect(capacity.count()).toBe(15);
    expect(capacity.holder("client-1")).toBeUndefined();
    expect(capacity.holder("client-2")).toEqual({ sid: "client-2", tab: "tab-2" });
    expect(capacity.acquire("client-1", "new-tab")).toBe(true);
  });

  it("reserves synchronously across clients and remains non-reentrant for the same tab", () => {
    const changed = vi.fn(),
      capacity = createPixelCapacity({ onChange: changed });
    expect(capacity.acquire("client-1", "tab-a")).toBe(true);
    expect(capacity.acquire("client-2", "tab-b")).toBe(false);
    expect(capacity.acquire("client-1", "tab-other")).toBe(false);
    expect(capacity.acquire("client-1", "tab-a")).toBe(false);
    expect(capacity.holder()).toEqual({ sid: "client-1", tab: "tab-a" });
    expect(Object.isFrozen(capacity.holder())).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ sid: "client-1", tab: "tab-a" });
  });

  it("ignores stale releases and admits the next client only after the actual owner releases", () => {
    const changed = vi.fn(),
      capacity = createPixelCapacity({ onChange: changed });
    capacity.acquire("client-1", "tab-a");
    capacity.release("client-2", "tab-a");
    capacity.release("client-1", "tab-b");
    expect(capacity.holder()).toEqual({ sid: "client-1", tab: "tab-a" });
    capacity.release("client-1", "tab-a");
    capacity.release("client-1", "tab-a");
    expect(capacity.holder()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenLastCalledWith(undefined);
    expect(capacity.acquire("client-2", "tab-b")).toBe(true);
    capacity.release("client-1", "tab-a");
    expect(capacity.holder()).toEqual({ sid: "client-2", tab: "tab-b" });
  });

  it("rejects missing client/target identifiers without occupying capacity", () => {
    const capacity = createPixelCapacity();
    expect(() => capacity.acquire("", "tab-a")).toThrow(TypeError);
    expect(() => capacity.acquire("client-1", "")).toThrow(TypeError);
    expect(capacity.holder()).toBeUndefined();
  });
});
