// @vitest-environment node
import { describe, expect, it } from "vitest";
import { firstInView, loadPageLook, savePageLook, type PageLook } from "./page-look";

describe("firstInView", () => {
  const boxes = [
    { name: "above", top: -200, bottom: -10 },
    { name: "across", top: -10, bottom: 40 },
    { name: "below", top: 40, bottom: 90 },
  ];

  it("takes the first box that reaches below the top of the view", () => {
    expect(firstInView(boxes, 0)?.name).toBe("across");
    expect(firstInView(boxes, 40)?.name).toBe("below");
  });

  it("has nothing when the view is past every box", () => {
    expect(firstInView(boxes, 100)).toBeNull();
  });
});

describe("the stored look", () => {
  const look = { fonts: "@font-face {}", rows: [] } as unknown as PageLook;

  it("comes back as it was saved", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    savePageLook(storage, look);
    expect(loadPageLook(storage)).toEqual(look);
  });

  it("is simply missing when storage fails or holds something else", () => {
    const failing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => savePageLook(failing, look)).not.toThrow();
    expect(loadPageLook(failing)).toBeNull();
    expect(loadPageLook({ getItem: () => "{broken", setItem: () => undefined })).toBeNull();
  });
});
