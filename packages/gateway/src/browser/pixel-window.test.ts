import { describe, expect, it, vi } from "vitest";
import { createGrabSlots, createPixelWindow, parseWindows } from "./pixel-window";

const line = (id: string, title: string | null, geometry: string): string =>
  `     ${id} ${title === null ? "(has no name)" : `"${title}"`}: ("c" "C")  ${geometry}  +0+0`;

function setup() {
  const bounds = { left: 20, top: 20, width: 1050, height: 980, windowState: "normal" };
  const listing = { current: [] as string[] };
  const sendBrowser = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: { ...bounds } };
    if (method === "Browser.setContentsSize") {
      bounds.width = params.width as number;
      bounds.height = (params.height as number) + 87;
    }
    if (method === "Browser.getWindowBounds") return { bounds: { ...bounds } };
    return {};
  });
  const raiseWindow = vi.fn(async () => {});
  const window = createPixelWindow({
    sendBrowser,
    raiseWindow,
    listWindows: async () => listing.current.join("\n"),
    sleep: async () => {},
  });
  return { sendBrowser, raiseWindow, window, listing };
}

const OWN = line("0x200006", "Claude - Google Chrome", "1800x1287+1280+-87");

describe("parseWindows", () => {
  it("reads named, unnamed and off-screen windows in order", () => {
    const parsed = parseWindows(
      [line("0x1", 'a "b" - Google Chrome', "10x20+-3+-4"), line("0x2", null, "1x1+0+0")].join(
        "\n",
      ),
    );
    expect(parsed).toEqual([
      { id: "0x1", title: 'a "b" - Google Chrome', x: -3, y: -4, width: 10, height: 20 },
      { id: "0x2", title: null, x: 0, y: 0, width: 1, height: 1 },
    ]);
  });
});

describe("createGrabSlots", () => {
  it("gives each client its own strip of the screen until they run out", () => {
    const slots = createGrabSlots(2);
    expect(slots.acquire("a")).toBe(1280);
    expect(slots.acquire("a")).toBeNull();
    expect(slots.acquire("b")).toBe(5120);
    expect(slots.available()).toBe(false);
    expect(slots.acquire("c")).toBeNull();
    slots.release("a");
    expect(slots.acquire("c")).toBe(1280);
  });
});

describe("createPixelWindow", () => {
  it("hides the browser's own bars above the screen and raises the window", async () => {
    const { window, sendBrowser, raiseWindow, listing } = setup();
    listing.current = [OWN];
    await window.place("t", 1280, 1800, 1200);
    expect(sendBrowser).toHaveBeenCalledWith("Browser.setContentsSize", {
      windowId: 7,
      width: 1800,
      height: 1200,
    });
    expect(sendBrowser).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: { left: 1280, top: -87 },
    });
    expect(raiseWindow).toHaveBeenCalledWith("0x200006");
  });

  it("fails when the window never reaches the corner, so the caller can fall back", async () => {
    const { window, listing } = setup();
    listing.current = [line("0x200006", "Claude - Google Chrome", "1800x1287+20+20")];
    await expect(window.place("t", 1280, 1800, 1200)).rejects.toThrow("not found on the display");
  });

  it("raises over another client's window but leaves its own popups alone", async () => {
    const { window, raiseWindow, listing } = setup();
    listing.current = [OWN];
    await window.place("t", 1280, 1800, 1200);
    raiseWindow.mockClear();

    listing.current = [line("0x9", null, "300x200+50+50"), OWN];
    await window.keepOnTop("t");
    expect(raiseWindow).not.toHaveBeenCalled();

    listing.current = [line("0x9", "Other - Google Chrome", "3000x200+3200+0"), OWN];
    await window.keepOnTop("t");
    expect(raiseWindow).not.toHaveBeenCalled();

    listing.current = [line("0x9", "Other - Google Chrome", "1050x980+1000+30"), OWN];
    await window.keepOnTop("t");
    expect(raiseWindow).toHaveBeenCalledWith("0x200006");
  });

  it("returns the window to where it was, keeping the first position across resizes", async () => {
    const { window, sendBrowser, listing } = setup();
    listing.current = [OWN, line("0x200006", "Claude - Google Chrome", "900x687+1280+-87")];
    await window.place("t", 1280, 1800, 1200);
    await window.place("t", 1280, 900, 600);
    await window.restore("t");
    expect(sendBrowser).toHaveBeenLastCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: { left: 20, top: 20, width: 1050, height: 980 },
    });
  });
});
