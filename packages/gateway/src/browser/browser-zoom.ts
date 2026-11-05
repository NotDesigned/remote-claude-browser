/**
 * Browser-level page zoom, which is what lets the screencast reach device resolution.
 *
 * Chromium's screencast stops at CSS pixels of the window. A window twice as wide at 200% zoom shows
 * the page exactly as a 2x display does (same layout, same devicePixelRatio) while the screencast
 * sees twice the pixels. Zoom normally belongs to a site across the whole profile, which would
 * reshape every other session's page. Only an extension can limit it to one tab, and CDP has no
 * command for that, so the page's title carries the request to a small extension.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Chromium's zoom steps. */
export const ZOOM_LEVELS = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const MAX_ZOOMED_SIDE = 3840;
const TITLE_PREFIX = "mirror-zoom:";
/** Long enough for the title to reach the browser process, which tells the extension. */
const TITLE_HOLD_MS = 150;

/** The largest step not above the viewer's density that keeps the picture encodable. */
export function zoomLevelFor(dpr: number, w: number, h: number): number {
  let chosen = 1;
  for (const level of ZOOM_LEVELS)
    if (level <= dpr + 0.01 && w * level <= MAX_ZOOMED_SIDE && h * level <= MAX_ZOOMED_SIDE)
      chosen = level;
  return chosen;
}

export const ZOOM_EXTENSION_WORKER = `chrome.tabs.onUpdated.addListener((tab, change) => {
  const found = /^${TITLE_PREFIX}([0-9.]+):/.exec(change.title ?? "");
  if (!found) return;
  chrome.tabs
    .setZoomSettings(tab, { mode: "automatic", scope: "per-tab" })
    .then(() => chrome.tabs.setZoom(tab, Number(found[1])))
    .catch(() => {});
});
`;

export function isZoomTitle(title: string): boolean {
  return title.startsWith(TITLE_PREFIX);
}

/** Rejects where the browser cannot load one, as on a remote browser. */
export async function installZoomExtension(
  browser: { sendBrowser?: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  directory: string,
): Promise<void> {
  if (!browser.sendBrowser) throw new Error("This browser has no root session");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Mirror picture zoom",
      version: "1",
      permissions: ["tabs"],
      background: { service_worker: "worker.js" },
    }),
  );
  await writeFile(join(directory, "worker.js"), ZOOM_EXTENSION_WORKER);
  await browser.sendBrowser("Extensions.loadUnpacked", { path: directory });
}

export interface BrowserZoomDeps {
  /** Runs an expression in the page and returns its value. */
  evaluate(sessionId: string, expression: string): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
}

export interface BrowserZoom {
  /** Asks for this zoom in this page's tab alone. The page's density shows when it has applied. */
  set(target: { sessionId: string }, level: number): Promise<void>;
}

export function createBrowserZoom(deps: BrowserZoomDeps): BrowserZoom {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    async set({ sessionId }, level) {
      const quoted = JSON.stringify(`${TITLE_PREFIX}${level}:${randomUUID()}`);
      const title = await deps.evaluate(
        sessionId,
        `(() => { const title = document.title; document.title = ${quoted}; return title; })()`,
      );
      await sleep(TITLE_HOLD_MS);
      await deps.evaluate(
        sessionId,
        `if (document.title === ${quoted}) document.title = ${JSON.stringify(title ?? "")};`,
      );
    },
  };
}
