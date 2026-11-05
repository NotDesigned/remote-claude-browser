/**
 * Browser-level page zoom, which is what lets the screencast reach device resolution.
 *
 * Chromium's screencast stops at CSS pixels of the window. A window twice as wide at 200% zoom shows
 * the page exactly as a 2x display does (same layout, same devicePixelRatio) while the screencast
 * sees twice the pixels. CDP has no zoom command and its key events skip browser shortcuts, so the
 * shortcuts are pressed through X11 on the Xvfb display that the headful browser runs on.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Chromium's zoom steps, reached by pressing Ctrl+= that many times from 100%. */
export const ZOOM_LEVELS = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const MAX_ZOOMED_SIDE = 3840;
const WINDOW_LOOKUP_MS = 2_000;

/** The largest step not above the viewer's density that keeps the picture encodable. */
export function zoomLevelFor(dpr: number, w: number, h: number): number {
  let chosen = 1;
  for (const level of ZOOM_LEVELS)
    if (level <= dpr + 0.01 && w * level <= MAX_ZOOMED_SIDE && h * level <= MAX_ZOOMED_SIDE)
      chosen = level;
  return chosen;
}

/** A restart forgets which picture was zoomed, but the profile would keep the page zoomed. */
export async function clearSavedZoom(profile: string): Promise<void> {
  const file = join(profile, "Default", "Preferences");
  try {
    const preferences = JSON.parse(await readFile(file, "utf8")) as {
      partition?: { per_host_zoom_levels?: unknown };
    };
    if (!preferences.partition?.per_host_zoom_levels) return;
    delete preferences.partition.per_host_zoom_levels;
    await writeFile(`${file}.next`, JSON.stringify(preferences), { mode: 0o600 });
    await rename(`${file}.next`, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("Could not clear the saved zoom:", (error as Error).message);
  }
}

export function zoomKeys(level: number): string[] {
  const presses = ZOOM_LEVELS.findIndex((candidate) => candidate === level);
  if (presses < 0) throw new RangeError(`Unsupported zoom level ${level}`);
  return ["ctrl+0", ...Array<string>(presses).fill("ctrl+equal")];
}

export interface BrowserZoomDeps {
  /** Runs an expression in the page and returns its value. */
  evaluate(sessionId: string, expression: string): Promise<unknown>;
  xdotool?(...args: string[]): Promise<string>;
  sleep?(ms: number): Promise<void>;
}

export interface BrowserZoom {
  /** Presses the shortcuts in this page's window. Rejects when that window cannot be reached. */
  press(target: { targetId: string; sessionId: string }, level: number): Promise<void>;
  forget(targetId: string): void;
}

const runXdotool = (...args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("xdotool", args, { timeout: 4_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });

export function createBrowserZoom(deps: BrowserZoomDeps): BrowserZoom {
  const xdotool = deps.xdotool ?? runXdotool;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const windows = new Map<string, string>();
  // X11 focus is one global resource across every client's window.
  let queue: Promise<unknown> = Promise.resolve();

  /** Nothing maps a CDP target to an X11 window, so the page briefly names its own window. */
  const findWindow = async (sessionId: string): Promise<string> => {
    const marker = `mirror-zoom-${randomUUID()}`;
    const quoted = JSON.stringify(marker);
    const title = await deps.evaluate(
      sessionId,
      `(() => { const title = document.title; document.title = ${quoted}; return title; })()`,
    );
    try {
      for (let waited = 0; waited < WINDOW_LOOKUP_MS; waited += 100) {
        await sleep(100);
        const found = await xdotool("search", "--name", marker).catch(() => "");
        const id = found.split("\n").at(-1);
        if (id) return id;
      }
      throw new Error("Browser window was not found");
    } finally {
      await deps.evaluate(
        sessionId,
        `if (document.title === ${quoted}) document.title = ${JSON.stringify(title ?? "")};`,
      );
    }
  };
  const focus = async (win: string): Promise<boolean> => {
    await xdotool("windowfocus", "--sync", win).catch(() => "");
    return (await xdotool("getwindowfocus").catch(() => "")) === win;
  };

  return {
    press(target, level) {
      const run = queue.then(async () => {
        let win = windows.get(target.targetId);
        if (!win || !(await focus(win))) {
          win = await findWindow(target.sessionId);
          windows.set(target.targetId, win);
          // Keys go to whichever window has focus, which could be another client's page.
          if (!(await focus(win))) throw new Error("Browser window could not be focused");
        }
        await xdotool("key", "--delay", "25", ...zoomKeys(level));
      });
      queue = run.catch(() => undefined);
      return run;
    },
    forget(targetId) {
      windows.delete(targetId);
    },
  };
}
