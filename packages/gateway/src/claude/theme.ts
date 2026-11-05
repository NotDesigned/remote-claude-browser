/**
 * Claude's Appearance setting, which the viewer's own theme choice mirrors. Claude keeps it in
 * localStorage, which every client shares through the one browser profile, so each client's pages
 * keep their own copy instead: Claude reads and writes that copy as if it were the setting, here or
 * under Settings, and nothing reaches the other clients.
 */
import type { CdpSend, TargetRef } from "../types";

export type ClaudeTheme = "light" | "dark" | "auto";

const STORAGE_KEY = "LSS-userThemeMode";
/** Writing here is this gateway's change. Writing the setting itself is the page's. */
const PUSH_KEY = `${STORAGE_KEY}:mirror-push`;
/** Reads back what the page itself last chose, if it has chosen since the last push. */
const CHOSEN_KEY = `${STORAGE_KEY}:mirror-chosen`;
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
    localStorage.setItem(${JSON.stringify(PUSH_KEY)}, ${stored});
    window.dispatchEvent(new StorageEvent("storage", { key: ${key}, newValue: ${stored} }));
    document.documentElement.dataset.mode = ${mode};
    return true;
  })()`;
}

/** [the page's copy, what the page itself chose, what it is showing]; undefined off Claude. */
export const READ_THEME_EXPRESSION = `(${onClaude}) ? [localStorage.getItem(${JSON.stringify(STORAGE_KEY)}), localStorage.getItem(${JSON.stringify(CHOSEN_KEY)}), document.documentElement.dataset.mode ?? null] : undefined`;

/** Runs before the page's scripts, so that Claude starts in this client's mode. */
export function themeCopySource(theme: ClaudeTheme): string {
  return `(() => {
    if (!(${onClaude})) return;
    const key = ${JSON.stringify(STORAGE_KEY)};
    const pushKey = ${JSON.stringify(PUSH_KEY)};
    const chosenKey = ${JSON.stringify(CHOSEN_KEY)};
    let value = ${JSON.stringify(JSON.stringify(theme))};
    let chosen = null;
    const { getItem, setItem, removeItem } = Storage.prototype;
    const isLocal = (storage) => storage === window.localStorage;
    Storage.prototype.getItem = function (name) {
      if (isLocal(this) && String(name) === key) return value;
      if (isLocal(this) && String(name) === chosenKey) return chosen;
      return getItem.call(this, name);
    };
    Storage.prototype.setItem = function (name, next) {
      if (isLocal(this) && String(name) === pushKey) {
        value = String(next);
        chosen = null;
      } else if (isLocal(this) && String(name) === key) {
        value = String(next);
        chosen = value;
      } else setItem.call(this, name, next);
    };
    Storage.prototype.removeItem = function (name) {
      if (isLocal(this) && String(name) === key) {
        value = null;
        chosen = null;
      } else removeItem.call(this, name);
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
    /**
     * This client's mode, or null when this gateway has not been told it, as after a restart. Only
     * what a page itself chose counts as a change, so a page that has merely not caught up, or a
     * read that overlaps a change, cannot undo the person's choice. Such a page is put right.
     */
    async read(): Promise<ClaudeTheme | null> {
      if (wanted === null) return null;
      for (const target of deps.pages()) {
        const seen = await evaluate(target, READ_THEME_EXPRESSION).catch(() => undefined);
        if (!Array.isArray(seen)) continue;
        const chosen = parseStoredTheme(seen[1]);
        if (chosen !== null && chosen !== wanted) {
          wanted = chosen;
          await applyEverywhere(chosen);
          return chosen;
        }
        const showsWrongMode = wanted !== "auto" && seen[2] !== wanted;
        if (parseStoredTheme(seen[0]) !== wanted || showsWrongMode) {
          await evaluate(target, setThemeExpression(wanted)).catch(() => undefined);
        }
      }
      return wanted;
    },
  };
}
