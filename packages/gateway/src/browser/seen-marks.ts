/**
 * Keeps Claude's "already shown" marks across sessions.
 *
 * A client's browser context is thrown away with its website storage, and Claude keeps these marks
 * there, so a notice dismissed once came back in every new session. Only marks are kept: a name that
 * says so and a value that is just true or a time, which rules out drafts and lists of conversations.
 * They go back in before Claude's scripts run, or the notice would already have been decided on.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { TargetRef } from "../types";
import type { BrowserHandle, FlatSessionEventMap } from "./launch";

const CLAUDE_ORIGIN = "https://claude.ai";
const MARK_NAME = /^LSS-.*(?:seen|dismiss|acknowledg)/i;
const MAX_MARK_LENGTH = 256;
const MAX_MARKS = 500;

export function isSeenMark(key: string, raw: string): boolean {
  if (!MARK_NAME.test(key) || raw.length > MAX_MARK_LENGTH) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    const value =
      typeof parsed === "object" && parsed !== null && "value" in parsed
        ? (parsed as { value: unknown }).value
        : parsed;
    return value === true || (typeof value === "number" && value > 0);
  } catch {
    return false;
  }
}

/** Never replaces a value the session already holds. */
export function seenMarksSource(marks: ReadonlyMap<string, string>): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(CLAUDE_ORIGIN)}) return;
  try {
    for (const [key, value] of ${JSON.stringify([...marks])})
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  } catch {}
})()`;
}

type StorageEvent = FlatSessionEventMap["DOMStorage.domStorageItemAdded"];

export interface SeenMarks {
  /** Run while the page is still paused, so its first document already has the marks. */
  prepare(target: TargetRef): Promise<void>;
  /** Resolves once everything noted so far is on disk. */
  flushed(): Promise<void>;
}

export async function createSeenMarks(browser: BrowserHandle, file: string): Promise<SeenMarks> {
  const marks = new Map<string, string>();
  try {
    const stored: unknown = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(stored))
      for (const entry of stored as [string, string][])
        if (isSeenMark(entry[0], entry[1])) marks.set(entry[0], entry[1]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("Could not read the seen marks:", (error as Error).message);
  }

  /** The script each open page runs on its next document, replaced as marks arrive. */
  const scripts = new Map<string, Promise<string | undefined>>();

  const register = async (sessionId: string): Promise<string | undefined> => {
    const added = (await browser.send(sessionId, "Page.addScriptToEvaluateOnNewDocument", {
      source: seenMarksSource(marks),
    })) as { identifier?: string };
    return added.identifier;
  };

  const refreshPages = (): void => {
    for (const [sessionId, previous] of scripts) {
      const next = previous.then(async (old) => {
        const identifier = await register(sessionId);
        if (old !== undefined)
          await browser.send(sessionId, "Page.removeScriptToEvaluateOnNewDocument", {
            identifier: old,
          });
        return identifier;
      });
      // A page that has gone only leaves the old script behind in a target that no longer exists.
      scripts.set(sessionId, next.catch(() => undefined));
    }
  };

  let saving = Promise.resolve();
  const save = (): void => {
    saving = saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = file + ".next";
        await writeFile(temporary, JSON.stringify([...marks]), { mode: 0o600 });
        await rename(temporary, file);
      })
      .catch((error: unknown) => {
        console.warn("Could not save the seen marks:", (error as Error).message);
      });
  };

  const note = (_sessionId: string, event: StorageEvent): void => {
    const { storageId, key, newValue } = event;
    if (!storageId.isLocalStorage) return;
    if (storageId.securityOrigin !== CLAUDE_ORIGIN && storageId.storageKey !== `${CLAUDE_ORIGIN}/`)
      return;
    if (!isSeenMark(key, newValue) || marks.has(key)) return;
    if (marks.size >= MAX_MARKS) return;
    marks.set(key, newValue);
    save();
    refreshPages();
  };
  browser.onSessionEvent("DOMStorage.domStorageItemAdded", note);
  browser.onSessionEvent("DOMStorage.domStorageItemUpdated", note);
  browser.onDetached((target) => scripts.delete(target.sessionId));

  return {
    async prepare(target) {
      if (target.type !== "page") return;
      // A notice coming back is not worth losing the page over.
      try {
        await browser.send(target.sessionId, "DOMStorage.enable");
        const script = register(target.sessionId);
        scripts.set(target.sessionId, script.catch(() => undefined));
        await script;
      } catch (error) {
        console.warn("Could not prepare the seen marks:", (error as Error).message);
      }
    },
    flushed: () => saving,
  };
}
