/**
 * A page loaded before a deploy keeps running the old viewer against the new gateway. Every
 * `hello` names the build the gateway serves; when it is not this page's own, the page says so
 * and reloads itself as soon as that interrupts nothing.
 */

declare const __VIEWER_BUILD__: string | undefined;

/** This bundle's build, set by vite.config.ts; "dev" for the development server and tests. */
export const VIEWER_BUILD: string = typeof __VIEWER_BUILD__ === "string" ? __VIEWER_BUILD__ : "dev";

/** Remembers which build a reload was for, so a page that still differs after it does not loop. */
export const RELOADED_FOR_KEY = "rcb-reloaded-for-build";
/** How often a busy page looks again for a moment to reload. */
export const BUILD_RELOAD_RETRY_MS = 2_000;

export interface BuildSkewOptions {
  own?: string;
  /** Someone is typing or uploading: reloading now would lose it. */
  busy(): boolean;
  reload(): void;
  onStale(stale: boolean): void;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface BuildSkew {
  /** The build the gateway's `hello` named, if any. */
  observe(served: string | undefined): void;
  /** Reload now, for the notice's button. */
  reloadNow(): void;
  dispose(): void;
}

export function createBuildSkew(options: BuildSkewOptions): BuildSkew {
  const own = options.own ?? VIEWER_BUILD;
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let target: string | null = null;
  let disposed = false;

  const read = (): string | null => {
    try {
      return options.storage?.getItem(RELOADED_FOR_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const reload = () => {
    if (target === null) return;
    try {
      options.storage?.setItem(RELOADED_FOR_KEY, target);
    } catch {
      // Without storage a page that still differs after reloading would reload again; it
      // only can when the gateway keeps serving another build, which a deploy does not.
    }
    options.reload();
  };
  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const attempt = () => {
    timer = null;
    if (disposed || target === null) return;
    if (!options.busy()) {
      reload();
      return;
    }
    timer = schedule(attempt, BUILD_RELOAD_RETRY_MS);
  };

  return {
    observe(served) {
      if (disposed) return;
      if (served === undefined || own === "dev" || served === own) {
        stop();
        target = null;
        options.onStale(false);
        return;
      }
      if (target === served) return;
      stop();
      target = served;
      options.onStale(true);
      // Reloaded for this build already and still not running it: say so, but do not loop.
      if (read() === served) return;
      attempt();
    },
    reloadNow: reload,
    dispose() {
      disposed = true;
      stop();
    },
  };
}
