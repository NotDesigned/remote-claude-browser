/**
 * Claude's Appearance setting, which the viewer's own theme choice mirrors. It lives in the page's
 * storage for each client, so setting it there is the same as choosing it under Settings.
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
    if (!(${onClaude})) return;
    localStorage.setItem(${key}, ${stored});
    window.dispatchEvent(new StorageEvent("storage", { key: ${key}, newValue: ${stored} }));
    document.documentElement.dataset.mode = ${mode};
  })()`;
}

export const READ_THEME_EXPRESSION = `(${onClaude}) ? localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) : undefined`;

export interface ClaudeThemeDeps {
  send: CdpSend;
  pages(): TargetRef[];
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
  const applyMedia = (target: TargetRef) =>
    systemDark === null
      ? Promise.resolve()
      : deps.send(target.sessionId, "Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: systemDark ? "dark" : "light" }],
        });
  return {
    /** A new page starts from the same device preference; its storage already has the setting. */
    applyMedia,
    async set(theme: ClaudeTheme, dark: boolean): Promise<void> {
      systemDark = dark;
      wanted = theme;
      await Promise.allSettled(
        deps.pages().flatMap((target) => [
          // "Follow the system" means the viewer's device, not this server's.
          applyMedia(target),
          evaluate(target, setThemeExpression(theme)),
        ]),
      );
    },
    /** What Claude has now, which the person may have changed under Settings. */
    async read(): Promise<ClaudeTheme | null> {
      for (const target of deps.pages()) {
        const stored = await evaluate(target, READ_THEME_EXPRESSION).catch(() => undefined);
        if (stored === undefined) continue;
        const current = parseStoredTheme(stored);
        if (current) return current;
        if (wanted) await evaluate(target, setThemeExpression(wanted)).catch(() => undefined);
        return wanted;
      }
      return null;
    },
  };
}
