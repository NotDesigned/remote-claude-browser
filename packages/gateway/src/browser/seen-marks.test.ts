import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TargetRef } from "../types";
import type { BrowserHandle } from "./launch";
import { createSeenMarks, isSeenMark, seenMarksSource } from "./seen-marks";

const MARK = "LSS-persisted.epitaxy-auto-default-notice-seen.account";
const SEEN = JSON.stringify({ value: true, tabId: "tab", timestamp: 1 });
const page: TargetRef = { targetId: "page", sessionId: "s1", type: "page" };
const origin = { securityOrigin: "https://claude.ai", isLocalStorage: true };

function fakeBrowser() {
  const calls: [string, string, Record<string, unknown> | undefined][] = [];
  const listeners = new Map<string, (sessionId: string, event: unknown) => void>();
  let scripts = 0;
  const browser = {
    send(sessionId: string, method: string, params?: Record<string, unknown>) {
      calls.push([sessionId, method, params]);
      return Promise.resolve(
        method === "Page.addScriptToEvaluateOnNewDocument"
          ? { identifier: `script-${++scripts}` }
          : {},
      );
    },
    onSessionEvent(method: string, callback: (sessionId: string, event: unknown) => void) {
      listeners.set(method, callback);
      return () => undefined;
    },
    onDetached() {},
  } as unknown as BrowserHandle;
  const write = (key: string, newValue: string, storageId: object = origin) =>
    listeners.get("DOMStorage.domStorageItemAdded")!("s1", { storageId, key, newValue });
  return { browser, calls, write };
}

describe("isSeenMark", () => {
  it("takes marks that only say a notice was seen", () => {
    expect(isSeenMark(MARK, SEEN)).toBe(true);
    expect(isSeenMark("LSS-persisted.banner-dismissed:x", "true")).toBe(true);
    expect(isSeenMark("LSS-chalkOnboardingLastSeen", "1793638852000")).toBe(true);
  });

  it("leaves everything else in the session", () => {
    expect(isSeenMark("LSS-draft", SEEN)).toBe(false);
    expect(isSeenMark(MARK, JSON.stringify({ value: false }))).toBe(false);
    expect(isSeenMark(MARK, "not json")).toBe(false);
    expect(isSeenMark("LSS-limit-dismissed-conversation-ids", '["a"]')).toBe(false);
    expect(isSeenMark("LSS-seen-text", JSON.stringify({ value: "my private draft" }))).toBe(false);
    expect(isSeenMark("other-seen", "true")).toBe(false);
  });
});

describe("seenMarksSource", () => {
  const run = (href: string, stored: Record<string, string>) => {
    const localStorage = {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => void (stored[key] = value),
    };
    vm.runInNewContext(seenMarksSource(new Map([[MARK, SEEN]])), {
      location: new URL(href),
      localStorage,
    });
    return stored;
  };

  it("restores a mark on Claude only and keeps what the session holds", () => {
    expect(run("https://claude.ai/code", {})).toEqual({ [MARK]: SEEN });
    expect(run("https://claude.ai/code", { [MARK]: "true" })).toEqual({ [MARK]: "true" });
    expect(run("https://example.com/", {})).toEqual({});
  });
});

describe("createSeenMarks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seen-marks-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("saves a mark, keeps it private and gives it to the next session", async () => {
    const file = join(dir, "seen-marks.json");
    const first = fakeBrowser();
    const marks = await createSeenMarks(first.browser, file);
    await marks.prepare(page);
    first.write(MARK, SEEN);
    await marks.flushed();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([[MARK, SEEN]]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const later = fakeBrowser();
    await (await createSeenMarks(later.browser, file)).prepare(page);
    expect(later.calls.at(-1)?.[2]?.source).toContain(JSON.stringify(MARK));
  });

  it("replaces an open page's script so its next document has the mark", async () => {
    const { browser, calls, write } = fakeBrowser();
    const marks = await createSeenMarks(browser, join(dir, "seen-marks.json"));
    await marks.prepare(page);
    write(MARK, SEEN);
    await marks.flushed();
    await new Promise((resolve) => setImmediate(resolve));
    const added = calls.filter(([, method]) => method.startsWith("Page.addScript"));
    expect(added).toHaveLength(2);
    expect(added[1]?.[2]?.source).toContain(JSON.stringify(MARK));
    expect(calls.at(-1)?.[1]).toBe("Page.removeScriptToEvaluateOnNewDocument");
    expect(calls.at(-1)?.[2]).toEqual({ identifier: "script-1" });
  });

  it("ignores other sites, frames and unreadable stores", async () => {
    const file = join(dir, "seen-marks.json");
    await writeFile(file, "{broken");
    const { browser, calls, write } = fakeBrowser();
    const marks = await createSeenMarks(browser, file);
    await marks.prepare({ targetId: "frame", sessionId: "s2", type: "iframe" });
    expect(calls).toEqual([]);
    write(MARK, SEEN, { securityOrigin: "https://example.com", isLocalStorage: true });
    write(MARK, SEEN, { securityOrigin: "https://claude.ai", isLocalStorage: false });
    await marks.flushed();
    expect(await readFile(file, "utf8")).toBe("{broken");
  });
});
