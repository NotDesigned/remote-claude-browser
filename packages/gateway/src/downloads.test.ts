import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mintInvite } from "./auth/invite";
import { createSessionGuard, SESSION_COOKIE } from "./auth/middleware";
import type { BrowserHandle, BrowserSessionEventMap, FlatSessionEventMap } from "./browser/launch";
import { createDownloadManager, registerDownloadRoutes } from "./downloads";
import type { TargetRef } from "./types";

const KEY = Buffer.from("download-route-test-key");
const NOW = 20_000;

class DownloadBrowser implements BrowserHandle {
  readonly send = vi.fn(async () => ({}));
  readonly sendBrowser = vi.fn(async () => ({}));
  private readonly browserCallbacks = new Map<string, Set<(event: never) => void>>();

  onSessionEvent<K extends keyof FlatSessionEventMap>(
    _method: K,
    _callback: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void {
    return () => undefined;
  }

  onBrowserEvent<K extends keyof BrowserSessionEventMap>(
    method: K,
    callback: (event: BrowserSessionEventMap[K]) => void,
  ): () => void {
    let callbacks = this.browserCallbacks.get(method);
    if (callbacks === undefined) {
      callbacks = new Set();
      this.browserCallbacks.set(method, callbacks);
    }
    const stored = callback as (event: never) => void;
    callbacks.add(stored);
    return () => callbacks?.delete(stored);
  }

  emit<K extends keyof BrowserSessionEventMap>(method: K, event: BrowserSessionEventMap[K]): void {
    for (const callback of this.browserCallbacks.get(method) ?? []) callback(event as never);
  }

  onAttached(_callback: (target: TargetRef) => void): void {}
  onDetached(_callback: (target: TargetRef) => void): void {}
  onTargetInfoChanged(_callback: Parameters<BrowserHandle["onTargetInfoChanged"]>[0]): void {}
  async close(): Promise<void> {}
}

const managers: Array<{ close(): void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("download flow", () => {
  it("revokes old completed links and in-progress GUIDs before a SID is reused", async () => {
    const browser = new DownloadBrowser();
    const publish = vi.fn();
    let nextKey = 0;
    const manager = await createDownloadManager({
      sessionId: "shared-browser",
      browser,
      downloadDir: "/shared/downloads",
      sessionForFrame: (frame) => (frame === "b" ? "client-2" : "client-1"),
      publish,
      createKey: () => `key-${++nextKey}`,
    });
    managers.push(manager);
    const begin = (guid: string, frameId = "a") =>
      browser.emit("Browser.downloadWillBegin", {
        frameId,
        guid,
        url: "https://files.test/file",
        suggestedFilename: `${guid}.txt`,
      });
    const finish = (guid: string) =>
      browser.emit("Browser.downloadProgress", {
        guid,
        totalBytes: 1,
        receivedBytes: 1,
        state: "completed",
      });
    begin("old-done");
    finish("old-done");
    begin("old-pending");
    begin("b-download", "b");
    finish("b-download");
    manager.revokeSession("client-1");
    expect(manager.claim("key-1", "client-1")).toBeUndefined();
    const sentBeforeOldProgress = publish.mock.calls.length;
    finish("old-done");
    finish("old-pending");
    expect(publish).toHaveBeenCalledTimes(sentBeforeOldProgress);
    expect(manager.claim("key-2", "client-2")).toMatchObject({ name: "b-download.txt" });
    begin("new-owner");
    finish("new-owner");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "new-owner",
        href: "/s/client-1/d/key-3",
      }),
      "client-1",
    );
    expect(manager.claim("key-3", "client-1")).toMatchObject({ name: "new-owner.txt" });
  });

  it("freezes frame ownership, directs progress by SID, and never lets a wrong SID consume a link", async () => {
    const browser = new DownloadBrowser();
    const owners = new Map([
      ["frame-a", "client-1"],
      ["frame-b", "client-2"],
    ]);
    const publish = vi.fn();
    let nextKey = 0;
    const manager = await createDownloadManager({
      sessionId: "shared-browser",
      browser,
      downloadDir: "/shared/downloads",
      sessionForFrame: (frame) => owners.get(frame),
      publish,
      createKey: () => `key-${++nextKey}`,
    });
    managers.push(manager);
    for (const [frameId, guid] of [
      ["frame-a", "guid-a"],
      ["frame-b", "guid-b"],
      ["unknown", "guid-unknown"],
    ]) {
      browser.emit("Browser.downloadWillBegin", {
        frameId: frameId!,
        guid: guid!,
        url: "https://files.test/file",
        suggestedFilename: `${guid}.txt`,
      });
    }
    owners.set("frame-a", "client-2");
    browser.emit("Browser.downloadProgress", {
      guid: "guid-a",
      totalBytes: 100,
      receivedBytes: 20,
      state: "inProgress",
    });
    for (const guid of ["guid-a", "guid-b", "guid-unknown"]) {
      browser.emit("Browser.downloadProgress", {
        guid,
        totalBytes: 100,
        receivedBytes: 100,
        state: "completed",
      });
    }

    expect(browser.sendBrowser).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls).toEqual([
      [
        { t: "download", id: "guid-a", name: "guid-a.txt", recv: 20, total: 100, state: "active" },
        "client-1",
      ],
      [
        {
          t: "download",
          id: "guid-a",
          name: "guid-a.txt",
          recv: 100,
          total: 100,
          state: "done",
          href: "/s/client-1/d/key-1",
        },
        "client-1",
      ],
      [
        {
          t: "download",
          id: "guid-b",
          name: "guid-b.txt",
          recv: 100,
          total: 100,
          state: "done",
          href: "/s/client-2/d/key-2",
        },
        "client-2",
      ],
    ]);
    expect(manager.claim("key-1", "client-2")).toBeUndefined();
    expect(manager.claim("key-1")).toBeUndefined();
    expect(manager.claim("key-1", "client-1")).toEqual({
      filePath: "/shared/downloads/guid-a",
      name: "guid-a.txt",
    });
    expect(manager.claim("key-1", "client-1")).toMatchObject({ name: "guid-a.txt" });
    expect(manager.claim("key-2", "client-1")).toBeUndefined();
    expect(manager.claim("key-2", "client-2")).toEqual({
      filePath: "/shared/downloads/guid-b",
      name: "guid-b.txt",
    });
  });

  it("checks the route SID before consuming a shared manager's completed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-shared-download-test-"));
    tempDirs.push(root);
    await writeFile(join(root, "guid-a"), "client one only");
    const browser = new DownloadBrowser();
    const manager = await createDownloadManager({
      sessionId: "shared-browser",
      browser,
      downloadDir: root,
      sessionForFrame: (frame) => (frame === "owned-frame" ? "client-1" : undefined),
      publish: () => undefined,
      createKey: () => "owned-key",
    });
    managers.push(manager);
    browser.emit("Browser.downloadWillBegin", {
      frameId: "owned-frame",
      guid: "guid-a",
      url: "https://files.test/file",
      suggestedFilename: "private.txt",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-a",
      totalBytes: 15,
      receivedBytes: 15,
      state: "completed",
    });
    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    registerDownloadRoutes(app, { preHandler: guard.preHandler, managerFor: () => manager });
    const headers = (sid: string) => ({
      cookie: `${SESSION_COOKIE}=${mintInvite({ sid, role: "driver", exp: NOW + 60 }, KEY)}`,
    });
    try {
      const wrong = await app.inject({
        url: "/s/client-2/d/owned-key",
        headers: headers("client-2"),
      });
      expect(wrong.statusCode).toBe(404);
      const own = await app.inject({
        url: "/s/client-1/d/owned-key",
        headers: headers("client-1"),
      });
      expect(own.statusCode).toBe(200);
      expect(own.body).toBe("client one only");
      expect(
        (await app.inject({ url: "/s/client-1/d/owned-key", headers: headers("client-1") }))
          .statusCode,
      ).toBe(200);
      const partial = await app.inject({
        url: "/s/client-1/d/owned-key",
        headers: { ...headers("client-1"), range: "bytes=7-9" },
      });
      expect(partial.statusCode).toBe(206);
      expect(partial.body).toBe("one");
      expect(partial.headers["content-range"]).toBe("bytes 7-9/15");
      expect(
        (
          await app.inject({
            url: "/s/client-1/d/owned-key",
            headers: { ...headers("client-1"), range: "bytes=999-" },
          })
        ).statusCode,
      ).toBe(416);
      manager.revokeSession("client-1");
      expect(
        (await app.inject({ url: "/s/client-1/d/owned-key", headers: headers("client-1") }))
          .statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("keeps a fully delivered file only for a short retry window", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-delivered-download-test-"));
    tempDirs.push(root);
    await writeFile(join(root, "guid-d"), "delivered body");
    const browser = new DownloadBrowser();
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const manager = await createDownloadManager({
      sessionId: "client-1",
      browser,
      downloadDir: root,
      publish: () => undefined,
      createKey: () => "delivered-key",
    });
    managers.push(manager);
    browser.emit("Browser.downloadWillBegin", {
      frameId: "frame",
      guid: "guid-d",
      url: "https://files.test/file",
      suggestedFilename: "report.txt",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-d",
      totalBytes: 14,
      receivedBytes: 14,
      state: "completed",
    });
    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    registerDownloadRoutes(app, { preHandler: guard.preHandler, managerFor: () => manager });
    const headers = {
      cookie: `${SESSION_COOKIE}=${mintInvite({ sid: "client-1", role: "driver", exp: NOW + 60 }, KEY)}`,
    };
    try {
      // A partial range that stops before the end is not a delivery.
      await app.inject({
        url: "/s/client-1/d/delivered-key",
        headers: { ...headers, range: "bytes=0-3" },
      });
      clock += 5 * 60 * 1000;
      expect(manager.claim("delivered-key", "client-1")).toBeDefined();
      const full = await app.inject({ url: "/s/client-1/d/delivered-key", headers });
      expect(full.body).toBe("delivered body");
      clock += 60 * 1000;
      expect(manager.claim("delivered-key", "client-1")).toBeDefined();
      clock += 61 * 1000;
      expect(manager.claim("delivered-key", "client-1")).toBeUndefined();
    } finally {
      now.mockRestore();
      await app.close();
    }
  });

  it("configures the browser root and maps GUID filenames into progress messages", async () => {
    const browser = new DownloadBrowser();
    const published: unknown[] = [];
    const manager = await createDownloadManager({
      sessionId: "s1",
      browser,
      downloadDir: "/session/downloads",
      publish: (message) => published.push(message),
      createKey: () => "one-time-key",
    });
    managers.push(manager);

    expect(browser.sendBrowser).toHaveBeenCalledWith("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: "/session/downloads",
      eventsEnabled: true,
    });

    browser.emit("Browser.downloadWillBegin", {
      frameId: "oopif-frame",
      guid: "guid-1",
      url: "https://files.test/origin-name",
      suggestedFilename: "report.pdf",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-1",
      totalBytes: 100,
      receivedBytes: 35,
      state: "inProgress",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-1",
      totalBytes: 100,
      receivedBytes: 100,
      state: "completed",
    });

    expect(published).toEqual([
      {
        t: "download",
        id: "guid-1",
        name: "report.pdf",
        recv: 35,
        total: 100,
        state: "active",
      },
      {
        t: "download",
        id: "guid-1",
        name: "report.pdf",
        recv: 100,
        total: 100,
        state: "done",
        href: "/s/s1/d/one-time-key",
      },
    ]);
  });

  it("streams a retryable completed GUID file, guards it by cookie, and never uses the name as a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirror-download-test-"));
    tempDirs.push(root);
    const downloadDir = join(root, "downloads");
    await mkdir(downloadDir);
    await writeFile(join(downloadDir, "guid-safe"), "download bytes");

    const browser = new DownloadBrowser();
    const manager = await createDownloadManager({
      sessionId: "s1",
      browser,
      downloadDir,
      publish: () => undefined,
      createKey: () => "single-use",
    });
    managers.push(manager);
    browser.emit("Browser.downloadWillBegin", {
      frameId: "frame-1",
      guid: "guid-safe",
      url: "https://files.test/file",
      suggestedFilename: "../../outside.txt",
    });
    browser.emit("Browser.downloadProgress", {
      guid: "guid-safe",
      totalBytes: 14,
      receivedBytes: 14,
      state: "completed",
    });

    const app = Fastify();
    const guard = createSessionGuard({ key: KEY, now: () => NOW });
    registerDownloadRoutes(app, {
      preHandler: guard.preHandler,
      managerFor: (sessionId) => (sessionId === "s1" ? manager : undefined),
    });

    expect((await app.inject({ url: "/s/s1/d/single-use" })).statusCode).toBe(403);

    const token = mintInvite({ sid: "s1", role: "viewer", exp: NOW + 60 }, KEY);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    const first = await app.inject({ url: "/s/s1/d/single-use", headers });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("download bytes");
    expect(first.headers["content-disposition"]).toBe(
      "attachment; filename=\"../../outside.txt\"; filename*=UTF-8''..%2F..%2Foutside.txt",
    );
    expect((await app.inject({ url: "/s/s1/d/single-use", headers })).statusCode).toBe(200);

    await app.close();
  });
});
