/**
 * Puts a client's browser window where the screen grab reads it.
 *
 * Copying frames out of Chromium slows the page down, while reading the X display does not. That
 * needs the page to really be on the display: the window takes the picture's size, with its tab strip
 * and address bar above the screen. One Chromium process uses one display, so the screen is one wide
 * strip: ordinary windows open at its left, and each picture has its own slot to the right of them.
 */
import { execFile } from "node:child_process";
import type { Up } from "@mirror/protocol";
import type { DisplayEnvironment } from "./display";

const LOCATE_TIMEOUT_MS = 1_000;
const LOCATE_POLL_MS = 25;
/** Keep in step with the Xvfb screen in claude-display.service: 12800x2880. */
const OPEN_WINDOW_AREA = 1280;
const SLOT_SIDE = 3840;
/** Every pixel of the screen takes four bytes whether used or not, so it is no taller than needed. */
export const GRAB_MAX_HEIGHT = 2880;
const SLOTS = 3;

export interface GrabSlots {
  /** The left edge of a free slot for this client, or null when all of them are taken. */
  acquire(sid: string): number | null;
  release(sid: string): void;
  available(): boolean;
}

export function createGrabSlots(count = SLOTS): GrabSlots {
  const taken = new Map<string, number>();
  return {
    acquire(sid) {
      if (taken.has(sid)) return null;
      for (let slot = 0; slot < count; slot++) {
        if ([...taken.values()].includes(slot)) continue;
        taken.set(sid, slot);
        return OPEN_WINDOW_AREA + slot * SLOT_SIDE;
      }
      return null;
    },
    release(sid) {
      taken.delete(sid);
    },
    available: () => taken.size < count,
  };
}

interface Bounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface XWindow {
  id: string;
  title: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The root window's children from `xwininfo -root -children`, topmost first. */
export function parseWindows(listing: string): XWindow[] {
  const windows: XWindow[] = [];
  for (const line of listing.split("\n")) {
    const found =
      /^\s+(0x[0-9a-f]+) (?:"(.*)"|\(has no name\)): .*\s(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s/.exec(
        line,
      );
    if (!found) continue;
    windows.push({
      id: found[1]!,
      title: found[2] ?? null,
      width: Number(found[3]),
      height: Number(found[4]),
      x: Number(found[5]),
      y: Number(found[6]),
    });
  }
  return windows;
}

/** Other browser windows, which belong to other clients. A page's own popups have no title. */
const isBrowserWindow = (window: XWindow): boolean =>
  / - (?:Google Chrome|Chromium)$/.test(window.title ?? "");

export interface PixelWindowDeps {
  display?: DisplayEnvironment;
  sendBrowser(method: string, params: Record<string, unknown>): Promise<unknown>;
  listWindows?(): Promise<string>;
  raiseWindow?(id: string): Promise<void>;
  windowType?(id: string): Promise<string>;
  input?(args: string[]): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

export interface PixelWindow {
  /** Shows exactly this many device pixels of the page from the top of the screen at `left`. */
  place(targetId: string, left: number, width: number, height: number): Promise<void>;
  /** Raises the window again if another browser window has opened over the picture. */
  keepOnTop(targetId: string): Promise<void>;
  restore(targetId: string): Promise<void>;
  /** Native select menus live outside the page and do not receive CDP pointer events. */
  pointer(message: Extract<Up, { t: "ptr" }>): Promise<boolean>;
}

const run = (
  display: DisplayEnvironment | undefined,
  command: string,
  ...args: string[]
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 4_000, ...(display ? { env: { ...process.env, ...display } } : {}) },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

export function createPixelWindow(deps: PixelWindowDeps): PixelWindow {
  const listWindows =
    deps.listWindows ?? (() => run(deps.display, "xwininfo", "-root", "-children"));
  const raiseWindow =
    deps.raiseWindow ??
    (async (id: string) => {
      await run(deps.display, "xdotool", "windowraise", String(Number(id)));
    });
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const windowType =
    deps.windowType ?? ((id) => run(deps.display, "xprop", "-id", id, "_NET_WM_WINDOW_TYPE"));
  const input = deps.input ?? (async (args) => void (await run(deps.display, "xdotool", ...args)));
  const nativePresses = new Set<string>();
  const wheelRemainders = new Map<string, number>();
  const placed = new Map<
    string,
    { windowId: number; saved: Bounds; id?: string; left: number; width: number; height: number }
  >();

  /** X applies a move a moment after the browser reports it. */
  const locate = async (
    left: number,
    width: number,
    height: number,
    top: number,
  ): Promise<string> => {
    for (let waited = 0; waited <= LOCATE_TIMEOUT_MS; waited += LOCATE_POLL_MS) {
      const found = parseWindows(await listWindows()).find(
        (window) =>
          isBrowserWindow(window) &&
          window.width === width &&
          window.height === height &&
          window.x === left &&
          window.y === top,
      );
      if (found) return found.id;
      await sleep(LOCATE_POLL_MS);
    }
    throw new Error(`The ${width}x${height} browser window was not found on the display`);
  };

  return {
    async pointer(message) {
      const entry = placed.get(message.tab);
      if (!entry?.id) return false;
      // The release opening a menu belongs to the original CDP press. Subsequent menu presses
      // use X11 for both halves, including the release if selecting an item already closed it.
      if (message.kind === "up" && !nativePresses.has(message.tab)) return false;
      if (!nativePresses.has(message.tab)) {
        const windows = parseWindows(await listWindows());
        const own = windows.findIndex((window) => window.id === entry.id);
        const popup = windows
          .slice(0, Math.max(0, own))
          .find(
            (window) =>
              window.title === null &&
              window.width > 1 &&
              window.height > 1 &&
              window.x < entry.left + entry.width &&
              window.x + window.width > entry.left &&
              window.y < entry.height &&
              window.y + window.height > 0,
          );
        if (!popup || !(await windowType(popup.id)).includes("_NET_WM_WINDOW_TYPE_MENU")) {
          wheelRemainders.delete(message.tab);
          return false;
        }
      }
      const args = [
        "mousemove",
        String(Math.round(entry.left + message.vx)),
        String(Math.round(message.vy)),
      ];
      if (message.kind === "wheel") {
        // X11 wheels have discrete steps; retain small trackpad/finger deltas between events.
        const distance = (wheelRemainders.get(message.tab) ?? 0) + (message.dy ?? 0);
        const steps = Math.trunc(distance / 40);
        wheelRemainders.set(message.tab, distance - steps * 40);
        if (steps !== 0)
          args.push(
            "click",
            "--repeat",
            String(Math.abs(steps)),
            "--delay",
            "0",
            steps < 0 ? "4" : "5",
          );
      } else if (message.kind === "down") {
        nativePresses.add(message.tab);
        args.push("mousedown", String((message.button ?? 0) + 1));
      } else if (message.kind === "up") {
        nativePresses.delete(message.tab);
        args.push("mouseup", String((message.button ?? 0) + 1));
      }
      await input(args);
      return true;
    },
    async place(targetId, left, width, height) {
      let entry = placed.get(targetId);
      if (!entry) {
        const { windowId, bounds } = (await deps.sendBrowser("Browser.getWindowForTarget", {
          targetId,
        })) as { windowId: number; bounds: Bounds };
        entry = { windowId, saved: bounds, left, width, height };
        placed.set(targetId, entry);
      }
      const { windowId } = entry;
      await deps.sendBrowser("Browser.setContentsSize", { windowId, width, height });
      const { bounds } = (await deps.sendBrowser("Browser.getWindowBounds", { windowId })) as {
        bounds: Required<Bounds>;
      };
      const top = -(bounds.height - height);
      await deps.sendBrowser("Browser.setWindowBounds", {
        windowId,
        bounds: { left, top },
      });
      entry.id = await locate(left, bounds.width, bounds.height, top);
      entry.left = left;
      entry.width = width;
      entry.height = height;
      await raiseWindow(entry.id);
    },
    async keepOnTop(targetId) {
      const entry = placed.get(targetId);
      if (!entry?.id) return;
      const windows = parseWindows(await listWindows());
      const own = windows.findIndex((window) => window.id === entry.id);
      if (own <= 0) return;
      const covered = windows
        .slice(0, own)
        .some(
          (window) =>
            isBrowserWindow(window) &&
            window.x < entry.left + entry.width &&
            window.y < entry.height &&
            window.x + window.width > entry.left &&
            window.y + window.height > 0,
        );
      if (covered) await raiseWindow(entry.id);
    },
    async restore(targetId) {
      const entry = placed.get(targetId);
      if (!entry) return;
      placed.delete(targetId);
      nativePresses.delete(targetId);
      wheelRemainders.delete(targetId);
      await deps.sendBrowser("Browser.setWindowBounds", {
        windowId: entry.windowId,
        bounds: {
          left: entry.saved.left,
          top: entry.saved.top,
          width: entry.saved.width,
          height: entry.saved.height,
        },
      });
    },
  };
}
