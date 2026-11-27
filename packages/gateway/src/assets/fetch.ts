/**
 * Asset fetch lanes.
 *
 * Lane A is the default and reads CDP's base64 IO stream in bounded chunks. Lane B, the gateway's own
 * HTTP client, is used for Range requests and, only with MIRROR_ASSET_DIRECT_FALLBACK=all, when Lane
 * A cannot be established (see AssetDirectFallback).
 * Browser-plane access is injected through CdpSend; this module never imports the browser.
 *
 * Content-Type is copied only from response headers. No URL-based inference happens here.
 */
import { Readable } from "node:stream";
import { ProxyAgent, request as undiciRequest, type Agent, type Dispatcher } from "undici";

import type { CdpSend } from "../types";
import type { AssetRef } from "./token";
import { normalizeAssetHeaders } from "./headers";
import { createPublicOnlyAgent } from "../net/public-target";

const IO_CHUNK_BYTES = 64 * 1024;

type HeaderValue = string | readonly string[] | undefined;

export interface AssetFetchRequest {
  ref: AssetRef;
  /** Forwarded byte-for-byte to Lane B. Its presence selects Lane B immediately. */
  range?: string;
}

export interface AssetFetchResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Readable;
  lane: "cdp" | "direct";
}

export interface DirectResponse {
  statusCode: number;
  headers: Record<string, HeaderValue>;
  body: AsyncIterable<Uint8Array>;
}

export type DirectRequest = (
  url: string,
  options: { headers: Record<string, string>; dispatcher?: Dispatcher },
) => Promise<DirectResponse>;

export interface AssetFetcherDeps {
  send: CdpSend;
  /** Resolve the token's stable tab id to its current flat CDP session. */
  sessionFor(ref: AssetRef): string | undefined | Promise<string | undefined>;
  /** Optional integration override; otherwise Page.getFrameTree supplies the valid frame id. */
  frameFor?: (ref: AssetRef, cdpSessionId: string) => string | Promise<string>;
  /** Optional integration override for a session-specific UA. */
  userAgentFor?: (ref: AssetRef, cdpSessionId: string) => string | Promise<string>;
  /** The profile's local Mihomo endpoint, shared by every direct/range request for this workspace. */
  proxyFor?: (ref: AssetRef) => string | undefined;
  /** Test seam around undici.request. */
  directRequest?: DirectRequest;
  /** Test seam for the proxy-less direct dispatcher (default: public addresses only). */
  directDispatcher?: () => Agent;
  /** Defaults to MIRROR_ASSET_DIRECT_FALLBACK (see assetDirectFallback). */
  directFallback?: AssetDirectFallback;
}

/**
 * When Lane B, the gateway's own HTTP client, may fetch what the page asked for. A site can tell
 * that client from the browser (its TLS handshake and headers differ), so by default it is used
 * only for Range requests (seeking in audio and video), which the browser lane cannot serve:
 *  - `range`: Range requests only; an asset the browser could not load fails (502);
 *  - `off`: never; Range requests fail too;
 *  - `all`: Range requests and every asset the browser could not load (the earlier behaviour).
 */
export type AssetDirectFallback = "all" | "range" | "off";

/** MIRROR_ASSET_DIRECT_FALLBACK; unset is `range`. Throws on anything else, so start-up fails. */
export function assetDirectFallback(value: string | undefined): AssetDirectFallback {
  const mode = value === undefined || value.trim() === "" ? "range" : value.trim();
  if (mode === "all" || mode === "range" || mode === "off") return mode;
  throw new Error(`MIRROR_ASSET_DIRECT_FALLBACK must be all, range or off, not ${value}`);
}

/** How assets were fetched, and why the direct lane was used or refused. Counts only. */
export interface AssetLaneCounts {
  cdp: number;
  blob: number;
  direct: { range: number; "cdp-failed": number };
  refused: { range: number; "cdp-failed": number };
}

export interface AssetFetcher {
  fetch(request: AssetFetchRequest): Promise<AssetFetchResponse>;
}

export interface ManagedAssetFetcher extends AssetFetcher {
  /** Drops a workspace's connections and TLS state, including those of requests in flight. */
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
  /** Counts since start, for the admin overview. */
  lanes(): AssetLaneCounts;
}

interface LoadResourceResult {
  resource?: {
    success?: unknown;
    netErrorName?: unknown;
    httpStatusCode?: unknown;
    stream?: unknown;
    headers?: unknown;
  };
}

interface IoReadResult {
  data?: unknown;
  base64Encoded?: unknown;
  eof?: unknown;
}

export function createAssetFetcher(deps: AssetFetcherDeps): ManagedAssetFetcher {
  const fallback =
    deps.directFallback ?? assetDirectFallback(process.env.MIRROR_ASSET_DIRECT_FALLBACK);
  const counts: AssetLaneCounts = {
    cdp: 0,
    blob: 0,
    direct: { range: 0, "cdp-failed": 0 },
    refused: { range: 0, "cdp-failed": 0 },
  };
  let lastRefusalReport = Number.NEGATIVE_INFINITY;
  // One connection pool per workspace, so no TLS session or socket crosses between them.
  const pools = new Map<string, { dispatcher: Agent | ProxyAgent; closed: boolean }>();
  const closeSession = async (sessionId: string): Promise<void> => {
    const pool = pools.get(sessionId);
    pools.delete(sessionId);
    if (pool) {
      pool.closed = true;
      await pool.dispatcher.destroy();
    }
  };

  return {
    async fetch(request) {
      let pool = pools.get(request.ref.sessionId);
      if (!pool) {
        const proxy = deps.proxyFor?.(request.ref);
        // Without a profile proxy (whose rules reject private ranges) the gateway connects itself;
        // the public-only agent pins each connection to the addresses it checked.
        pool = {
          dispatcher: proxy
            ? new ProxyAgent(proxy)
            : (deps.directDispatcher ?? createPublicOnlyAgent)(),
          closed: false,
        };
        pools.set(request.ref.sessionId, pool);
      }
      const cdpSessionId = await deps.sessionFor(request.ref);
      if (pool.closed || cdpSessionId === undefined) {
        throw new Error(`Asset tab is not attached: ${request.ref.tabId}`);
      }
      // A request whose workspace was released while it looked up credentials must not go out.
      const directRequest: DirectRequest = (url, options) => {
        if (pool.closed) throw new Error("Asset session was closed");
        return (deps.directRequest ?? defaultDirectRequest)(url, {
          ...options,
          dispatcher: pool.dispatcher,
        });
      };

      if (new URL(request.ref.url).protocol === "blob:") {
        counts.blob += 1;
        return fetchBrowserObject(deps, request.ref, cdpSessionId);
      }

      if (request.range !== undefined) {
        if (fallback === "off") {
          counts.refused.range += 1;
          throw new Error(
            "Range requests are not fetched by the gateway (MIRROR_ASSET_DIRECT_FALLBACK=off)",
          );
        }
        counts.direct.range += 1;
        return fetchDirect(deps, directRequest, request, cdpSessionId);
      }

      let failure: unknown;
      try {
        const response = await fetchThroughCdp(deps, request.ref, cdpSessionId);
        counts.cdp += 1;
        return response;
      } catch (error) {
        failure = error;
      }
      if (fallback !== "all") {
        // The gateway's own client would show the site a TLS handshake that is not the browser's.
        counts.refused["cdp-failed"] += 1;
        // Once a minute at most, and never the address: how often it happens is what matters.
        if (Date.now() - lastRefusalReport >= 60_000) {
          lastRefusalReport = Date.now();
          console.warn(
            `assets: the browser could not load an asset, which is not fetched by the gateway instead (MIRROR_ASSET_DIRECT_FALLBACK=${fallback}; ${counts.refused["cdp-failed"]} so far)`,
          );
        }
        throw new Error("The browser could not load the asset", { cause: failure });
      }
      counts.direct["cdp-failed"] += 1;
      return fetchDirect(deps, directRequest, request, cdpSessionId);
    },
    closeSession,
    lanes: () => ({
      cdp: counts.cdp,
      blob: counts.blob,
      direct: { ...counts.direct },
      refused: { ...counts.refused },
    }),
    async close() {
      await Promise.all([...pools.keys()].map(closeSession));
    },
  };
}

/** Object URLs are capabilities in the originating browser, not network addresses.
 * Hold the Blob there and pull bounded slices; never copy an entire image into a
 * protocol message or attempt an HTTP fallback from another process.
 */
async function fetchBrowserObject(
  deps: AssetFetcherDeps,
  ref: AssetRef,
  sessionId: string,
): Promise<AssetFetchResponse> {
  const frameId = deps.frameFor
    ? await deps.frameFor(ref, sessionId)
    : await resourceFrameId(deps.send, sessionId, ref.documentUrl);
  const world = (await deps.send(sessionId, "Page.createIsolatedWorld", {
    frameId,
    worldName: "mirror-assets",
  })) as { executionContextId: number };
  const result = (await deps.send(sessionId, "Runtime.evaluate", {
    contextId: world.executionContextId,
    expression: `fetch(${JSON.stringify(ref.url)}).then(r => { if (!r.ok) throw new Error('Object unavailable'); return r.blob(); })`,
    awaitPromise: true,
    returnByValue: false,
  })) as { result?: { objectId?: string }; exceptionDetails?: unknown };
  const objectId = result.result?.objectId;
  if (!objectId) throw new Error("Browser object is unavailable or revoked");
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await deps.send(sessionId, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  };
  try {
    if (result.exceptionDetails) throw new Error("Browser object is unavailable or revoked");
    const metadata = (await deps.send(sessionId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function(){return {size:this.size,type:this.type}}",
      returnByValue: true,
    })) as { result?: { value?: { size: number; type: string } } };
    const info = metadata.result?.value;
    if (!info || !Number.isSafeInteger(info.size) || info.size < 0)
      throw new Error("Invalid browser object metadata");
    const body = Readable.from(
      (async function* () {
        try {
          for (let offset = 0; offset < info.size; offset += IO_CHUNK_BYTES) {
            const part = (await deps.send(sessionId, "Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `async function(offset, size) {
              const bytes = new Uint8Array(await this.slice(offset, offset + size).arrayBuffer());
              let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
              return btoa(binary);
            }`,
              arguments: [{ value: offset }, { value: IO_CHUNK_BYTES }],
              awaitPromise: true,
              returnByValue: true,
            })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
            if (part.exceptionDetails || typeof part.result?.value !== "string")
              throw new Error("Browser object read failed");
            yield Buffer.from(part.result.value, "base64");
          }
        } finally {
          await release();
        }
      })(),
    );
    body.once("close", () => void release());
    return {
      statusCode: 200,
      headers: {
        "content-type": info.type || "application/octet-stream",
        "content-length": String(info.size),
      },
      body,
      lane: "cdp",
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function fetchThroughCdp(
  deps: AssetFetcherDeps,
  ref: AssetRef,
  cdpSessionId: string,
): Promise<AssetFetchResponse> {
  const frameId = deps.frameFor
    ? await deps.frameFor(ref, cdpSessionId)
    : await resourceFrameId(deps.send, cdpSessionId, ref.documentUrl);
  const loaded = (await deps.send(cdpSessionId, "Network.loadNetworkResource", {
    frameId,
    url: ref.url,
    options: { includeCredentials: true, disableCache: false },
  })) as LoadResourceResult;
  const resource = loaded.resource;
  if (resource?.success !== true) {
    const detail = typeof resource?.netErrorName === "string" ? `: ${resource.netErrorName}` : "";
    throw new Error(`CDP asset load failed${detail}`);
  }

  const statusCode = positiveStatus(resource.httpStatusCode, 200);
  const headers = normalizeHeaders(resource.headers);
  // Network.loadNetworkResource exposes the decoded representation on its IO stream but keeps
  // the upstream transfer headers. Forwarding (for example) `content-encoding: br` with decoded
  // favicon bytes makes the viewer decode them a second time; the original compressed length is
  // wrong for the same reason. Let the gateway frame the decoded body it actually sends.
  delete headers["content-encoding"];
  delete headers["content-length"];
  if (typeof resource.stream !== "string") {
    return { statusCode, headers, body: Readable.from([]), lane: "cdp" };
  }

  const handle = resource.stream;
  let first: { chunk: Buffer; eof: boolean };
  try {
    // Establish the IO stream before returning so experimental-CDP failures still fall back.
    first = await readCdpChunk(deps.send, cdpSessionId, handle);
  } catch (error) {
    await closeCdpStream(deps.send, cdpSessionId, handle);
    throw error;
  }

  const body = Readable.from(
    (async function* () {
      try {
        if (first.chunk.length > 0) yield first.chunk;
        let eof = first.eof;
        while (!eof) {
          const next = await readCdpChunk(deps.send, cdpSessionId, handle);
          if (next.chunk.length > 0) yield next.chunk;
          eof = next.eof;
        }
      } finally {
        await closeCdpStream(deps.send, cdpSessionId, handle);
      }
    })(),
  );
  return { statusCode, headers, body, lane: "cdp" };
}

async function fetchDirect(
  deps: AssetFetcherDeps,
  directRequest: DirectRequest,
  request: AssetFetchRequest,
  cdpSessionId: string,
): Promise<AssetFetchResponse> {
  const [cookiesResult, userAgent] = await Promise.all([
    deps.send(cdpSessionId, "Network.getCookies", { urls: [request.ref.url] }),
    deps.userAgentFor
      ? deps.userAgentFor(request.ref, cdpSessionId)
      : browserUserAgent(deps.send, cdpSessionId),
  ]);
  const target = new URL(request.ref.url);
  const hardened = process.env.MIRROR_AGENT_HARDENING !== "0";
  const headers: Record<string, string> = {};
  if (hardened) {
    Object.assign(headers, clientHintHeaders(userAgent, target.protocol === "https:"));
    headers.accept = "*/*";
    headers["accept-encoding"] =
      request.range !== undefined ? "identity;q=1, *;q=0" : "gzip, deflate, br";
  }
  headers["user-agent"] = userAgent;
  const cookie = cookieHeader(cookiesResult);
  if (cookie !== "") headers.cookie = cookie;
  if (request.range !== undefined) headers.range = request.range;
  let fetchSite = "none";
  if (request.ref.documentUrl) {
    const source = new URL(request.ref.documentUrl);
    // Match the browser's default strict-origin-when-cross-origin policy.
    if (
      /^https?:$/.test(source.protocol) &&
      !(source.protocol === "https:" && target.protocol === "http:")
    ) {
      source.username = "";
      source.password = "";
      source.hash = "";
      headers.referer = source.origin === target.origin ? source.href : `${source.origin}/`;
    }
    if (/^https?:$/.test(source.protocol)) {
      fetchSite =
        source.origin === target.origin
          ? "same-origin"
          : sameSiteHost(source, target)
            ? "same-site"
            : "cross-site";
    }
  }
  if (hardened && target.protocol === "https:") {
    headers["sec-fetch-site"] = fetchSite;
    headers["sec-fetch-mode"] = "no-cors";
    headers["sec-fetch-dest"] = rangeFetchDest(target.pathname, request.range !== undefined);
  }

  const response = await directRequest(request.ref.url, { headers });
  return {
    statusCode: positiveStatus(response.statusCode, 502),
    headers: normalizeHeaders(response.headers),
    // undici's body is already a Readable; destroying it (the viewer left, a limit) aborts the
    // request at once, where a wrapper would wait for the next chunk first.
    body: response.body instanceof Readable ? response.body : Readable.from(response.body),
    lane: "direct",
  };
}

function clientHintHeaders(userAgent: string, secure: boolean): Record<string, string> {
  if (!secure) return {};
  const major = /\bChrome\/(\d+)/.exec(userAgent)?.[1];
  if (!major) return {};
  const platform = /\bWindows\b/i.test(userAgent)
    ? "Windows"
    : /\bAndroid\b/i.test(userAgent)
      ? "Android"
      : /\b(?:Macintosh|Mac OS X)\b/i.test(userAgent)
        ? "macOS"
        : /\bCrOS\b/i.test(userAgent)
          ? "Chrome OS"
          : "Linux";
  return {
    "sec-ch-ua": `"Not:A-Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`,
    "sec-ch-ua-mobile": /\bMobile\b/.test(userAgent) ? "?1" : "?0",
    "sec-ch-ua-platform": JSON.stringify(platform),
  };
}

function rangeFetchDest(pathname: string, isRange: boolean): string {
  if (!isRange) return "empty";
  if (/\.(?:mp3|wav|ogg|m4a|aac|opus|flac)$/i.test(pathname)) return "audio";
  return "video";
}

function sameSiteHost(source: URL, target: URL): boolean {
  if (source.protocol !== target.protocol) return false;
  const a = source.hostname.toLowerCase();
  const b = target.hostname.toLowerCase();
  if (a === b) return true;
  const base = (host: string) => host.split(".").slice(-2).join(".");
  return a.includes(".") && b.includes(".") && base(a) === base(b);
}

const defaultDirectRequest: DirectRequest = async (url, options) => {
  const response = await undiciRequest(url, { method: "GET", ...options });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
  };
};

async function resourceFrameId(
  send: CdpSend,
  cdpSessionId: string,
  documentUrl?: string,
): Promise<string> {
  interface FrameTree {
    frame: { id: string; url?: string };
    childFrames?: FrameTree[];
  }
  const result = (await send(cdpSessionId, "Page.getFrameTree")) as {
    frameTree?: FrameTree;
  };
  const find = (tree: FrameTree): string | undefined => {
    if (tree.frame.url === documentUrl) return tree.frame.id;
    for (const child of tree.childFrames ?? []) {
      const id = find(child);
      if (id) return id;
    }
  };
  if (documentUrl && result.frameTree) {
    const owner = find(result.frameTree);
    if (owner) return owner;
  }
  const frameId = result.frameTree?.frame?.id;
  if (typeof frameId !== "string" || frameId === "") {
    throw new Error("CDP did not return a valid main frame id");
  }
  return frameId;
}

async function browserUserAgent(send: CdpSend, cdpSessionId: string): Promise<string> {
  const result = (await send(cdpSessionId, "Browser.getVersion")) as { userAgent?: unknown };
  if (typeof result.userAgent !== "string" || result.userAgent === "") {
    throw new Error("CDP did not return the browser User-Agent");
  }
  return result.userAgent;
}

function cookieHeader(value: unknown): string {
  const cookies = record(value).cookies;
  if (!Array.isArray(cookies)) return "";
  return cookies
    .flatMap((cookie) => {
      const item = record(cookie);
      return typeof item.name === "string" && typeof item.value === "string"
        ? [`${item.name}=${item.value}`]
        : [];
    })
    .join("; ");
}

async function readCdpChunk(
  send: CdpSend,
  cdpSessionId: string,
  handle: string,
): Promise<{ chunk: Buffer; eof: boolean }> {
  const result = (await send(cdpSessionId, "IO.read", {
    handle,
    size: IO_CHUNK_BYTES,
  })) as IoReadResult;
  if (typeof result.data !== "string") throw new Error("CDP IO.read returned invalid data");
  return {
    chunk: Buffer.from(result.data, result.base64Encoded === true ? "base64" : "utf8"),
    eof: result.eof === true,
  };
}

async function closeCdpStream(send: CdpSend, cdpSessionId: string, handle: string): Promise<void> {
  await send(cdpSessionId, "IO.close", { handle }).catch(() => undefined);
}

function normalizeHeaders(value: unknown): Record<string, string | string[]> {
  return normalizeAssetHeaders(value);
}

function positiveStatus(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
