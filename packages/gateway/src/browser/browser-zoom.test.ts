import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createBrowserZoom,
  installZoomExtension,
  isZoomTitle,
  ZOOM_EXTENSION_WORKER,
  zoomLevelFor,
} from "./browser-zoom";

describe("zoom levels", () => {
  it("follows the display density without going over it", () => {
    expect(zoomLevelFor(1, 1440, 900)).toBe(1);
    expect(zoomLevelFor(1.25, 1920, 1080)).toBe(1.25);
    expect(zoomLevelFor(2, 1440, 900)).toBe(2);
    expect(zoomLevelFor(2.625, 400, 800)).toBe(2.5);
    expect(zoomLevelFor(3, 390, 780)).toBe(3);
    expect(zoomLevelFor(4, 390, 780)).toBe(3);
  });

  it("stops where the picture would get too large to encode", () => {
    expect(zoomLevelFor(2, 2560, 1440)).toBe(1.5);
    expect(zoomLevelFor(2, 3840, 2160)).toBe(1);
  });
});

describe("browser zoom through the extension", () => {
  const zoomFor = (page: { title: string }, sleep: () => Promise<void>) => {
    const context = vm.createContext({ document: page });
    return createBrowserZoom({
      evaluate: async (_session, expression) => vm.runInContext(expression, context) as unknown,
      sleep,
    });
  };

  it("names the level in the title, then puts the page's own title back", async () => {
    const page = { title: "Claude" };
    let seen = "";
    await zoomFor(page, async () => {
      seen = page.title;
    }).set({ sessionId: "s" }, 1.5);
    expect(seen).toMatch(/^mirror-zoom:1\.5:/);
    expect(isZoomTitle(seen)).toBe(true);
    expect(isZoomTitle("Claude")).toBe(false);
    expect(page.title).toBe("Claude");
  });

  it("keeps a title the page changed to meanwhile", async () => {
    const page = { title: "Claude" };
    await zoomFor(page, async () => {
      page.title = "New chat";
    }).set({ sessionId: "s" }, 2);
    expect(page.title).toBe("New chat");
  });

  it("zooms only the tab that asked, in the extension", async () => {
    const calls: unknown[][] = [];
    let listener: (tab: number, change: { title?: string }) => void = () => {};
    vm.runInNewContext(ZOOM_EXTENSION_WORKER, {
      chrome: {
        tabs: {
          onUpdated: { addListener: (callback: typeof listener) => (listener = callback) },
          setZoomSettings: async (...args: unknown[]) => void calls.push(["settings", ...args]),
          setZoom: async (...args: unknown[]) => void calls.push(["zoom", ...args]),
        },
      },
    });
    listener(7, { title: "Claude" });
    listener(8, {});
    listener(9, { title: "mirror-zoom:2:abc" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(JSON.stringify(calls))).toEqual([
      ["settings", 9, { mode: "automatic", scope: "per-tab" }],
      ["zoom", 9, 2],
    ]);
  });

  it("writes the extension and asks the browser to load it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoom-extension-"));
    try {
      const sendBrowser = vi.fn(async () => ({ id: "x" }));
      await installZoomExtension({ sendBrowser }, directory);
      expect(sendBrowser).toHaveBeenCalledWith("Extensions.loadUnpacked", { path: directory });
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
        permissions: string[];
      };
      expect(manifest.permissions).toEqual(["tabs"]);
      await expect(installZoomExtension({}, directory)).rejects.toThrow("no root session");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
