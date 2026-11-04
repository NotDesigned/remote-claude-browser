import { describe, expect, it, vi } from "vitest";
import { createBrowserZoom, zoomKeys, zoomLevelFor } from "./browser-zoom";

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

  it("presses from a known starting point", () => {
    expect(zoomKeys(1)).toEqual(["ctrl+0"]);
    expect(zoomKeys(2)).toEqual(["ctrl+0", ...Array(5).fill("ctrl+equal")]);
    expect(() => zoomKeys(1.3)).toThrow("Unsupported");
  });
});

describe("browser zoom", () => {
  const target = { targetId: "tab", sessionId: "session" };
  const setup = (focused: () => string = () => "42") => {
    const evaluate = vi.fn(async (_session: string, expression: string) =>
      expression.includes("return title") ? "Claude" : undefined,
    );
    const xdotool = vi.fn(async (...args: string[]) => {
      if (args[0] === "search") return "41\n42";
      if (args[0] === "getwindowfocus") return focused();
      return "";
    });
    return {
      evaluate,
      xdotool,
      zoom: createBrowserZoom({ evaluate, xdotool, sleep: async () => {} }),
    };
  };

  it("finds the window by a temporary title, restores it and presses the keys", async () => {
    const { zoom, evaluate, xdotool } = setup();
    await zoom.press(target, 1.25);
    expect(evaluate.mock.calls[1]![1]).toContain('document.title = "Claude"');
    expect(xdotool).toHaveBeenCalledWith("windowfocus", "--sync", "42");
    expect(xdotool).toHaveBeenLastCalledWith(
      "key",
      "--delay",
      "25",
      "ctrl+0",
      "ctrl+equal",
      "ctrl+equal",
    );
  });

  it("remembers the window afterwards", async () => {
    const { zoom, evaluate } = setup();
    await zoom.press(target, 2);
    evaluate.mockClear();
    await zoom.press(target, 1);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("never presses keys while another window has focus", async () => {
    const { zoom, xdotool } = setup(() => "99");
    await expect(zoom.press(target, 2)).rejects.toThrow("focused");
    expect(xdotool.mock.calls.some(([command]) => command === "key")).toBe(false);
  });

  it("still restores the title when the window cannot be found", async () => {
    const { zoom, evaluate, xdotool } = setup();
    xdotool.mockImplementation(async () => "");
    await expect(zoom.press(target, 2)).rejects.toThrow("not found");
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
