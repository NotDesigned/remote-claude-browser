/**
 * Claude's Appearance setting, which the viewer's own theme choice mirrors. Claude keeps it in
 * localStorage, which every client shares through the one browser profile, so each client's pages
 * keep their own copy instead: Claude reads and writes that copy as if it were the setting, here or
 * under Settings, and nothing reaches the other clients.
 */
import type { CdpSend, TargetRef } from "../types";

export type ClaudeTheme = "light" | "dark" | "auto";

const STORAGE_KEY = "LSS-userThemeMode";
const CLAUDE_ORIGIN = "https://claude.ai";

export function isClaudeTheme(value: unknown): value is ClaudeTheme {
  return value === "light" || value === "dark" || value === "auto";
}

/** Claude stores the mode as JSON, but only the word matters when reading it back. */
export function parseStoredTheme(stored: unknown): ClaudeTheme | null {
  if (typeof stored !== "string") return null;
  const found = /\b(light|dark|auto)\b/.exec(stored);
  return found ? (found[1] as ClaudeTheme) : null;
}

const onClaude = `location.origin === ${JSON.stringify(CLAUDE_ORIGIN)}`;

/** Also tells the running page, which otherwise only reads the setting when it starts. */
export function setThemeExpression(theme: ClaudeTheme): string {
  const key = JSON.stringify(STORAGE_KEY);
  const stored = JSON.stringify(JSON.stringify(theme));
  const mode = JSON.stringify(theme === "auto" ? "system" : theme);
  return `(() => {
    if (!(${onClaude})) return false;
    localStorage.setItem(${key}, ${stored});
    window.dispatchEvent(new StorageEvent("storage", { key: ${key}, newValue: ${stored} }));
    document.documentElement.dataset.mode = ${mode};
    return true;
  })()`;
}

export const READ_THEME_EXPRESSION = `(${onClaude}) ? localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) : undefined`;

/** Runs before the page's scripts, so that Claude starts in this client's mode. */
export function themeCopySource(theme: ClaudeTheme): string {
  return `(() => {
    if (!(${onClaude})) return;
    const key = ${JSON.stringify(STORAGE_KEY)};
    let value = ${JSON.stringify(JSON.stringify(theme))};
    const { getItem, setItem, removeItem } = Storage.prototype;
    const isSetting = (storage, name) => storage === window.localStorage && String(name) === key;
    Storage.prototype.getItem = function (name) {
      return isSetting(this, name) ? value : getItem.call(this, name);
    };
    Storage.prototype.setItem = function (name, next) {
      if (isSetting(this, name)) value = String(next);
      else setItem.call(this, name, next);
    };
    Storage.prototype.removeItem = function (name) {
      if (isSetting(this, name)) value = null;
      else removeItem.call(this, name);
    };
  })()`;
}

/** The copy each page starts every new document with, replaced when the client's choice changes. */
export function createThemeCopies(send: CdpSend) {
  const installed = new Map<string, string>();
  return {
    async install(sessionId: string, theme: ClaudeTheme, runImmediately = false): Promise<void> {
      const previous = installed.get(sessionId);
      installed.delete(sessionId);
      if (previous !== undefined) {
        await send(sessionId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: previous });
      }
      const { identifier } = (await send(sessionId, "Page.addScriptToEvaluateOnNewDocument", {
        source: themeCopySource(theme),
        runImmediately,
      })) as { identifier?: string };
      if (identifier !== undefined) installed.set(sessionId, identifier);
    },
    forget(sessionId: string): void {
      installed.delete(sessionId);
    },
  };
}

export interface ClaudeThemeDeps {
  send: CdpSend;
  pages(): TargetRef[];
  copies: ReturnType<typeof createThemeCopies>;
}

export function createClaudeTheme(deps: ClaudeThemeDeps) {
  const evaluate = async (target: TargetRef, expression: string): Promise<unknown> => {
    const result = (await deps.send(target.sessionId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      silent: true,
    })) as { result?: { value?: unknown } };
    return result.result?.value;
  };
  let systemDark: boolean | null = null;
  // The choice made before a Claude page was open, or before it had any setting of its own.
  let wanted: ClaudeTheme | null = null;
  const applyEverywhere = (theme: ClaudeTheme) =>
    Promise.allSettled(
      deps.pages().map(async (target) => {
        // "Follow the system" means the viewer's device, not this server's.
        await applyMedia(target);
        await deps.copies.install(target.sessionId, theme);
        return evaluate(target, setThemeExpression(theme));
      }),
    );
  const applyMedia = (target: TargetRef) =>
    systemDark === null
      ? Promise.resolve()
      : deps.send(target.sessionId, "Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: systemDark ? "dark" : "light" }],
        });
  return {
    /** A new page starts from the same device preference; its storage already has the setting. */
    applyMedia,
    /** What a page that is just starting should begin with. */
    current: (): ClaudeTheme | null => wanted,
    /** Resolves to whether a Claude page took the setting; there may not be one open yet. */
    async set(theme: ClaudeTheme, dark: boolean): Promise<boolean> {
      systemDark = dark;
      wanted = theme;
      const results = await applyEverywhere(theme);
      return results.some((result) => result.status === "fulfilled" && result.value === true);
    },
    /** What Claude has now, which the person may have changed under Settings in one of its pages. */
    async read(): Promise<ClaudeTheme | null> {
      let onClaudePage = false;
      for (const target of deps.pages()) {
        const stored = await evaluate(target, READ_THEME_EXPRESSION).catch(() => undefined);
        if (stored === undefined) continue;
        onClaudePage = true;
        const current = parseStoredTheme(stored);
        if (current !== null && current !== wanted) {
          wanted = current;
          await applyEverywhere(current);
          return current;
        }
      }
      return onClaudePage ? wanted : null;
    },
  };
}
