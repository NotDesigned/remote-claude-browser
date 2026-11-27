// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inputModeOverride } from "./input-mode";

const memory = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

describe("input mode override", () => {
  it("never forces single-writer input on: ?input=proxy only drops a legacy choice", () => {
    const storage = memory({ "mirror.input-mode": "legacy" });
    expect(inputModeOverride("?input=proxy", storage)).toBeNull();
    expect(storage.items.has("mirror.input-mode")).toBe(false);
  });

  it("forgets a stored proxy choice from earlier builds", () => {
    const storage = memory({ "mirror.input-mode": "proxy" });
    expect(inputModeOverride("", storage)).toBeNull();
    expect(storage.items.has("mirror.input-mode")).toBe(false);
  });

  it("keeps ?input=legacy for the tab's session", () => {
    const storage = memory();
    expect(inputModeOverride("?input=legacy", storage)).toBe("legacy");
    expect(inputModeOverride("", storage)).toBe("legacy");
  });

  it("works without storage", () => {
    expect(inputModeOverride("?input=legacy", null)).toBe("legacy");
    expect(inputModeOverride("", null)).toBeNull();
    const blocked = () => {
      throw new Error("blocked");
    };
    expect(
      inputModeOverride("?input=legacy", {
        getItem: blocked,
        setItem: blocked,
        removeItem: blocked,
      }),
    ).toBe("legacy");
  });
});
