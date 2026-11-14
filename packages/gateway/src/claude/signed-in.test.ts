// @vitest-environment node
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHandle } from "../browser/launch";
import { createClaudeLoginTracker, profileSignedIn, readClaudeLogin } from "./signed-in";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function fixture(
  fetcher = vi.fn(async () => Response.json({ email_address: "work@example.com" })),
  origin = "https://claude.ai",
) {
  const send = vi.fn(async (_session: string, method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate")
      return {
        result: {
          value: await runInNewContext(params!.expression as string, {
            fetch: fetcher,
            AbortSignal,
            location: { origin },
          }),
        },
      };
    throw new Error(method);
  });
  const browser = {
    send,
    sendBrowser: vi.fn(async () => ({
      targetInfos: [{ targetId: "tab", type: "page", url: "https://claude.ai/new" }],
    })),
  } as unknown as BrowserHandle;
  return { browser, send, fetcher, targets: new Map([["session", "tab"]]) };
}

describe("Claude account identity", () => {
  it("does not request account data if the tab navigated to another site after discovery", async () => {
    const { browser, targets, fetcher } = fixture(undefined, "https://other.example");
    await expect(readClaudeLogin(browser, targets)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads through the browser's main frame in a private world, even when its id differs from the target", async () => {
    const { browser, send, fetcher, targets } = fixture();
    await expect(readClaudeLogin(browser, targets)).resolves.toEqual({
      signedIn: true,
      email: "work@example.com",
    });
    expect(send).toHaveBeenCalledWith(
      "session",
      "Page.createIsolatedWorld",
      expect.objectContaining({ frameId: "main-frame" }),
    );
    expect(send).toHaveBeenCalledWith(
      "session",
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 7, timeout: 10_000 }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/account",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it.each([
    [401, {}, { signedIn: false, email: null }],
    [
      403,
      { error: { message: "account_banned" } },
      { signedIn: false, email: null, unavailable: true },
    ],
    [403, { error: { message: "challenge_required" } }, undefined],
    [503, {}, undefined],
  ])(
    "distinguishes account rejection from transient HTTP %s errors",
    async (status, body, expected) => {
      const { browser, targets } = fixture(vi.fn(async () => Response.json(body, { status })));
      await expect(readClaudeLogin(browser, targets)).resolves.toEqual(expected);
    },
  );

  it("never restores an old email when its request finishes after logout or a different login", async () => {
    let complete!: (response: Response) => void;
    const { browser, targets, fetcher } = fixture(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const save = vi.fn(async () => {});
    const tracker = createClaudeLoginTracker(browser, targets, { email: "old@example.com", save });
    tracker.observe(true, true);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    tracker.observe(false, true);
    tracker.observe(true, true);
    expect(tracker.current()).toEqual({ signedIn: true, email: null });
    complete(Response.json({ email_address: "old@example.com" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ email: "old@example.com" }));
    expect(tracker.current()).toEqual({ signedIn: true, email: null });
    tracker.dispose();
  });

  it("keeps cached identity through network failures and ignores a response after disposal", async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    }) as ReturnType<typeof vi.fn<() => Promise<Response>>>;
    const { browser, targets } = fixture(fetcher);
    const save = vi.fn(async () => {});
    const tracker = createClaudeLoginTracker(browser, targets, {
      email: "cached@example.com",
      save,
    });
    tracker.observe(true, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(tracker.current()?.email).toBe("cached@example.com");
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    tracker.observe(true, false);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    tracker.dispose();
    complete(Response.json({ email_address: "late@example.com" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(save).not.toHaveBeenCalled();
  });

  it("reads Chromium's 64-bit cookie expiry without starting the stopped browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-cookie-"));
    directories.push(dir);
    expect(profileSignedIn(dir)).toBe(false);
    await mkdir(join(dir, "Default"));
    const db = new DatabaseSync(join(dir, "Default", "Cookies"));
    try {
      db.exec("CREATE TABLE cookies (name TEXT, host_key TEXT, expires_utc INTEGER)");
      const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?)");
      const now = BigInt(Date.now()) * 1000n + 11_644_473_600_000_000n;
      insert.run("sessionKey", ".claude.ai", now - 1000n);
      insert.run("sessionKey", "notclaude.ai", now + 100_000_000n);
      expect(profileSignedIn(dir)).toBe(false);
      insert.run("sessionKey", ".claude.ai", now + 100_000_000n);
      expect(profileSignedIn(dir)).toBe(true);
    } finally {
      db.close();
    }
  });
});
