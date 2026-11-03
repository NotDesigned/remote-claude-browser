/**
 * Gateway side of the download flow.
 * (Viewer half P3-DOWNLOADS-V = viewer/src/chrome/downloads.tsx, viewer domain.)
 *
 * Browser.setDownloadBehavior({behavior:"allowAndName", downloadPath, eventsEnabled:true});
 * map GUID -> suggestedFilename from downloadWillBegin (downloads from OOPIF subframes emit on
 * the BROWSER session, not the page session); `download` progress msgs; expiring random link
 * /s/:sid/d/:key — cookie-guarded via auth/middleware.ts (SEC-2), retryable range reads, filename
 * only ever used in Content-Disposition (path traversal via suggestedFilename is a bug even in
 * a trusted-viewer tool). Files expire after 30 minutes or when the session ends.
 */
import type { Down } from "@mirror/protocol";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";

import type { SessionGuard } from "./auth/middleware";
import type { BrowserHandle, BrowserSessionEventMap } from "./browser/launch";

type DownloadMsg = Extract<Down, { t: "download" }>;

interface DownloadRecord {
  guid: string;
  sessionId: string;
  name: string;
  href?: string;
  message?: DownloadMsg;
  expiresAt?: number;
}

interface DownloadClaim {
  filePath: string;
  name: string;
}

export interface DownloadManagerOptions {
  sessionId: string;
  browser: BrowserHandle;
  /** Shared browser download spool; ownership is retained separately for each recorded GUID. */
  downloadDir: string;
  /** When set, unknown frames are ignored instead of using the legacy sessionId fallback. */
  sessionForFrame?(frameId: string): string | undefined;
  publish(message: DownloadMsg, sessionId: string): void;
  /** Test seam; production keys are 192 random bits encoded for URLs. */
  createKey?: () => string;
  onError?: (error: unknown) => void;
}

export interface DownloadManager {
  readonly sessionId: string;
  /** Returns an owner-guarded link until expiry so interrupted transfers can retry. */
  list(sessionId: string): DownloadMsg[];
  cancel(id: string, sessionId: string): Promise<void>;
  claim(key: string, sessionId?: string): DownloadClaim | undefined;
  /** Forget all in-progress GUIDs and completed links before a workspace SID is reassigned. */
  revokeSession(sessionId: string): void;
  close(): void;
}

export interface DownloadRouteOptions {
  /** SEC-2's exact session-cookie guard; intentionally required with no permissive fallback. */
  preHandler: SessionGuard["preHandler"];
  managerFor(sessionId: string): DownloadManager | undefined;
}

interface DownloadRouteParams {
  sid: string;
  key: string;
}

export async function createDownloadManager(
  options: DownloadManagerOptions,
): Promise<DownloadManager> {
  const sessionId = nonEmpty(options.sessionId, "sessionId");
  const downloadDir = nonEmpty(options.downloadDir, "downloadDir");
  const sendBrowser = options.browser.sendBrowser;
  if (sendBrowser === undefined || options.browser.onBrowserEvent === undefined) {
    throw new Error("download flow requires browser/root CDP commands and events");
  }

  const report = options.onError ?? (() => undefined);
  const createKey = options.createKey ?? (() => randomBytes(24).toString("base64url"));
  const downloads = new Map<string, DownloadRecord>();
  const links = new Map<string, DownloadRecord>();
  let closed = false;
  const lifetimeMs = 30 * 60 * 1000;
  const removeRecord = (record: DownloadRecord) => {
    downloads.delete(record.guid);
    for (const [key, link] of links) if (link === record) links.delete(key);
    void rm(join(downloadDir, record.guid), { force: true }).catch(report);
  };
  const sweep = setInterval(() => {
    for (const record of downloads.values()) {
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) removeRecord(record);
    }
  }, 60_000);
  sweep.unref?.();

  const offWillBegin = options.browser.onBrowserEvent(
    "Browser.downloadWillBegin",
    (event: BrowserSessionEventMap["Browser.downloadWillBegin"]) => {
      if (closed) return;
      try {
        assertFileComponent(event.guid, "download GUID");
        const ownerSessionId =
          options.sessionForFrame === undefined
            ? sessionId
            : options.sessionForFrame(event.frameId);
        if (ownerSessionId === undefined) return;
        nonEmpty(ownerSessionId, "download sessionId");
        downloads.set(event.guid, {
          guid: event.guid,
          sessionId: ownerSessionId,
          name: event.suggestedFilename || "download",
        });
      } catch (error) {
        report(error);
      }
    },
  );
  const offProgress = options.browser.onBrowserEvent(
    "Browser.downloadProgress",
    (event: BrowserSessionEventMap["Browser.downloadProgress"]) => {
      if (closed) return;
      try {
        const record = downloads.get(event.guid);
        if (record === undefined) return;
        const state = wireState(event.state);
        if (state === "done" && record.href === undefined) {
          const key = uniqueKey(createKey, links);
          record.href = `/s/${encodeURIComponent(record.sessionId)}/d/${key}`;
          links.set(key, record);
        }
        record.message = {
          t: "download",
          id: event.guid,
          name: record.name,
          recv: event.receivedBytes,
          total: event.totalBytes,
          state,
          ...(record.href === undefined ? {} : { href: record.href }),
        };
        if (state !== "active") record.expiresAt = Date.now() + lifetimeMs;
        options.publish(record.message, record.sessionId);
        if (state === "canceled") removeRecord(record);
      } catch (error) {
        report(error);
      }
    },
  );

  try {
    await sendBrowser("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
  } catch (error) {
    offWillBegin();
    offProgress();
    clearInterval(sweep);
    throw error;
  }

  return {
    sessionId,
    list(requestedSessionId) {
      return [...downloads.values()]
        .filter((record) => record.sessionId === requestedSessionId)
        .flatMap((record) => (record.message ? [record.message] : []));
    },
    async cancel(id, requestedSessionId) {
      const record = downloads.get(id);
      if (!record || record.sessionId !== requestedSessionId) return;
      if (record.message?.state !== "done")
        await sendBrowser("Browser.cancelDownload", { guid: record.guid });
      options.publish(
        {
          t: "download",
          id,
          name: record.name,
          recv: record.message?.recv ?? 0,
          total: record.message?.total ?? 0,
          state: "canceled",
        },
        record.sessionId,
      );
      removeRecord(record);
    },
    claim(key, requestedSessionId) {
      if (closed) return undefined;
      const record = links.get(key);
      if (record === undefined) return undefined;
      const ownerSessionId =
        requestedSessionId ?? (options.sessionForFrame === undefined ? sessionId : undefined);
      if (record.sessionId !== ownerSessionId) return undefined;
      if ((record.expiresAt ?? 0) <= Date.now()) {
        removeRecord(record);
        return undefined;
      }
      return {
        // allowAndName writes the GUID. The suggested filename never participates in this path.
        filePath: join(downloadDir, record.guid),
        name: record.name,
      };
    },
    revokeSession(revokedSessionId) {
      nonEmpty(revokedSessionId, "sessionId");
      for (const [guid, record] of downloads) {
        if (record.sessionId === revokedSessionId) {
          if (record.message?.state !== "done")
            void sendBrowser("Browser.cancelDownload", { guid }).catch(report);
          removeRecord(record);
        }
      }
      for (const [key, record] of links) {
        if (record.sessionId === revokedSessionId) links.delete(key);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      offWillBegin();
      offProgress();
      clearInterval(sweep);
      for (const record of downloads.values()) {
        if (record.message?.state !== "done")
          void sendBrowser("Browser.cancelDownload", { guid: record.guid }).catch(report);
        removeRecord(record);
      }
      links.clear();
    },
  };
}

export function registerDownloadRoutes(app: FastifyInstance, options: DownloadRouteOptions): void {
  if (typeof options.preHandler !== "function") {
    throw new TypeError("download route requires the SEC-2 session preHandler");
  }

  app.get<{ Params: { sid: string } }>(
    "/s/:sid/downloads",
    { preHandler: options.preHandler },
    async (request, reply) =>
      reply
        .header("cache-control", "no-store")
        .send(options.managerFor(request.params.sid)?.list(request.params.sid) ?? []),
  );
  app.delete<{ Params: { sid: string; id: string } }>(
    "/s/:sid/downloads/:id",
    { preHandler: options.preHandler },
    async (request, reply) => {
      await options.managerFor(request.params.sid)?.cancel(request.params.id, request.params.sid);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: DownloadRouteParams }>(
    "/s/:sid/d/:key",
    { preHandler: options.preHandler },
    async (request, reply) => {
      const claim = options
        .managerFor(request.params.sid)
        ?.claim(request.params.key, request.params.sid);
      if (claim === undefined) {
        return reply.code(404).send({ error: "Download not found" });
      }
      const file = await stat(claim.filePath).catch(() => undefined);
      if (!file?.isFile()) return reply.code(404).send({ error: "Download not found" });
      reply.header("cache-control", "private, no-store");
      reply.header("content-disposition", contentDisposition(claim.name));
      reply.header("accept-ranges", "bytes");
      reply.type("application/octet-stream");
      const range = request.headers.range;
      if (range === undefined) {
        reply.header("content-length", file.size);
        return reply.send(createReadStream(claim.filePath));
      }
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0,
        end = file.size - 1;
      if (match) {
        if (match[1]) {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        } else if (match[2]) start = Math.max(0, file.size - Number(match[2]));
      }
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        end < 0 ||
        start >= file.size
      ) {
        return reply.code(416).header("content-range", `bytes */${file.size}`).send();
      }
      reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${file.size}`)
        .header("content-length", end - start + 1);
      return reply.send(createReadStream(claim.filePath, { start, end }));
    },
  );
}

function wireState(
  state: BrowserSessionEventMap["Browser.downloadProgress"]["state"],
): DownloadMsg["state"] {
  if (state === "inProgress") return "active";
  return state === "completed" ? "done" : "canceled";
}

function uniqueKey(createKey: () => string, links: Map<string, DownloadRecord>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const key = createKey();
    if (key !== "" && /^[A-Za-z0-9_-]+$/.test(key) && !links.has(key)) return key;
  }
  throw new Error("could not mint a unique download key");
}

function assertFileComponent(value: string, name: string): void {
  if (
    value === "" ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`${name} must be one path component`);
  }
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encode5987(name)}`;
}

function encode5987(value: string): string {
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") throw new TypeError(`${name} must not be empty`);
  return value;
}
