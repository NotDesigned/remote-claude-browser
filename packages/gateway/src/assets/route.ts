/**
 * Asset-proxy route GET /s/:sid/a/:token.
 *
 * SEC-2 supplies the optional preHandler. The default deliberately does nothing.
 *
 * ============================ TARGET POLICY CHECK (§7.2) ============================
 * After token decryption, reject private/loopback/carrier-NAT/link-local/reserved targets,
 * including 169.254.169.254 cloud metadata (see ../net/public-target.ts).
 * ======================================================================================
 *
 * Responses are served on the gateway origin, so upstream headers pass an allow-list and
 * document/script content types are neutralized (see applyResponse and assetContentType).
 */
import type {
  FastifyInstance,
  FastifyReply,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from "fastify";

import { pipeline, type Readable } from "node:stream";

import type { AssetCache, CachedAsset } from "./cache";
import type { AssetFetcher, AssetFetchResponse } from "./fetch";
import { openAssetToken, type AssetRef } from "./token";
import { rewriteFetchedStylesheet } from "./stylesheet";
import { normalizeAssetHeaders } from "./headers";
import {
  createAssetLimiter,
  declaredLength,
  DEFAULT_ASSET_LIMITS,
  type AssetLimits,
} from "./limits";
import { SECURITY_HEADERS } from "../security-headers";
import {
  defaultTargetLookup,
  PrivateTargetError,
  rejectPrivateTarget,
  type ResolvedAddress,
  type TargetLookup,
} from "../net/public-target";

interface AssetRouteParams {
  sid: string;
  "*": string;
}

export type { ResolvedAddress };
export type AssetTargetLookup = TargetLookup;
export type AssetPreHandler = preHandlerHookHandler | preHandlerAsyncHookHandler;

export interface AssetRouteDeps {
  serverKey: Buffer;
  /** Overrides the static key; an inactive session must return undefined and fail closed. */
  serverKeyForSession?: (sid: string) => Buffer | undefined;
  cache: AssetCache;
  fetcher: AssetFetcher;
  preHandler?: AssetPreHandler;
  /** Test/deployment seam; all returned addresses are checked before fetching. */
  lookup?: (hostname: string, ref: AssetRef) => Promise<readonly ResolvedAddress[]>;
  /**
   * Bounds on each upstream body (default DEFAULT_ASSET_LIMITS). A Range response, which only
   * streams through, is bounded by the idle timeout alone, since media plays from open ranges.
   */
  limits?: Partial<AssetLimits>;
}

const ignoreStreamEnd = () => undefined;

export function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): void {
  const preHandler: AssetPreHandler = deps.preHandler ?? (async () => undefined);
  const limits: AssetLimits = { ...DEFAULT_ASSET_LIMITS, ...deps.limits };
  const rangeLimits: AssetLimits = {
    maxBytes: Infinity,
    timeoutMs: Infinity,
    idleTimeoutMs: limits.idleTimeoutMs,
  };

  app.get<{ Params: AssetRouteParams }>(
    // A wildcard preserves the public /:token shape while avoiding Fastify's 100-byte named
    // parameter ceiling; AES-GCM tokens are intentionally longer than that.
    "/s/:sid/a/*",
    // A body that fails before its first byte (a limit, the upstream) has no headers out yet.
    {
      preHandler,
      config: { errors: () => ({ status: 502, body: { error: "Asset fetch failed" } }) },
    },
    async (request, reply) => {
      const serverKey = deps.serverKeyForSession
        ? deps.serverKeyForSession(request.params.sid)
        : deps.serverKey;
      if (serverKey === undefined) {
        return reply.code(404).send({ error: "Asset session not found" });
      }
      const stillCurrent = () => {
        if (!deps.serverKeyForSession) return true;
        const current = deps.serverKeyForSession(request.params.sid);
        return current !== undefined && serverKey.equals(current);
      };
      const token = request.params["*"];
      let ref: AssetRef;
      try {
        ref = openAssetToken(token, serverKey);
      } catch {
        return reply.code(400).send({ error: "Invalid asset token" });
      }
      if (ref.sessionId !== request.params.sid) {
        return reply.code(404).send({ error: "Asset session not found" });
      }

      try {
        await rejectPrivateAssetTarget(ref.url, (hostname) =>
          deps.lookup ? deps.lookup(hostname, ref) : defaultTargetLookup(hostname),
        );
      } catch (error) {
        if (error instanceof PrivateTargetError) {
          return reply.code(403).send({ error: "Private asset target rejected" });
        }
        return reply.code(502).send({ error: "Asset target could not be resolved" });
      }

      const range = request.headers.range;
      // Tokens include the sealing-key namespace as well as the reference. A reused SID and URL
      // must never recover content cached by an earlier browser runtime or another user.
      const cacheKey = token;
      if (range === undefined) {
        const cached = await deps.cache.get(cacheKey);
        if (!stillCurrent()) return reply.code(404).send({ error: "Asset session not found" });
        if (cached !== undefined) return sendCached(reply, cached);
      }
      if (!stillCurrent()) return reply.code(404).send({ error: "Asset session not found" });

      let response: AssetFetchResponse;
      try {
        response = await deps.fetcher.fetch({ ref, ...(range === undefined ? {} : { range }) });
        if (!stillCurrent()) {
          response.body.destroy();
          return reply.code(404).send({ error: "Asset session not found" });
        }
        const declared = declaredLength(response.headers);
        if (range === undefined && declared !== undefined && declared > limits.maxBytes) {
          response.body.destroy();
          return reply.code(502).send({ error: "Asset is too large" });
        }
        // From here on the body is bounded in size and time. Destroying any later stage (the
        // viewer going away, a limit, the session ending) aborts the upstream fetch as well.
        const bounded: Readable = pipeline(
          response.body,
          createAssetLimiter(range === undefined ? limits : rangeLimits),
          ignoreStreamEnd,
        );
        response = { ...response, body: bounded };
        if (range === undefined)
          response = await rewriteFetchedStylesheet(response, ref, serverKey);
        if (!stillCurrent()) {
          response.body.destroy();
          return reply.code(404).send({ error: "Asset session not found" });
        }
      } catch {
        return reply.code(502).send({ error: "Asset fetch failed" });
      }

      applyResponse(reply, response.statusCode, response.headers);
      if (range === undefined && response.statusCode === 200) {
        // The viewer gets bytes as they arrive; the disk copy is kept only if the body ends
        // complete while its session is still current, and is removed otherwise.
        return reply.send(
          pipeline(
            response.body,
            deps.cache.tee(
              cacheKey,
              { statusCode: response.statusCode, headers: response.headers },
              { commit: stillCurrent },
            ),
            ignoreStreamEnd,
          ),
        );
      }
      return reply.send(response.body);
    },
  );
}

/** Resolve-then-check every address so a hostname cannot hide a private destination. */
export async function rejectPrivateAssetTarget(
  target: string,
  lookup: AssetTargetLookup = defaultTargetLookup,
): Promise<void> {
  // Object URLs belong to this browser, not DNS or a direct HTTP fallback.
  if (new URL(target).protocol === "blob:") return;
  await rejectPrivateTarget(target, lookup);
}

function sendCached(reply: FastifyReply, cached: CachedAsset): FastifyReply {
  applyResponse(reply, cached.statusCode, cached.headers);
  return reply.send(cached.createReadStream());
}

function applyResponse(
  reply: FastifyReply,
  statusCode: number,
  headers: Record<string, string | string[]>,
): void {
  reply.code(statusCode);
  const safeHeaders = normalizeAssetHeaders(headers);
  // Only representation and caching metadata crosses from the upstream site. Anything that
  // could act on the gateway origin (CSP, framing, CORS/CORP/COOP/COEP, HSTS, Link, Refresh,
  // Location, cookies, Content-Disposition, ...) is dropped.
  for (const [name, value] of Object.entries(safeHeaders)) {
    if (ALLOWED_UPSTREAM_HEADERS.has(name)) reply.header(name, value);
  }
  const contentType = assetContentType(headerValue(safeHeaders, "content-type"));
  if (contentType !== undefined) reply.header("content-type", contentType);
  // The gateway's own policy, with a CSP that turns any document rendered from this response
  // into an inert, opaque-origin sandbox. A response's CSP does not affect images, fonts,
  // stylesheets or media used as subresources, but an SVG opened directly or in a frame cannot
  // run script or reach the gateway origin.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
  reply.header("content-security-policy", ASSET_CONTENT_SECURITY_POLICY);
  // Font bytes are content-addressed by their sealed source URL and can be retained by the
  // browser. Determine this only from the upstream Content-Type; never sniff the token URL.
  if (isFontContentType(contentType)) {
    reply.header("cache-control", IMMUTABLE_FONT_CACHE_CONTROL);
  }
}

export const ASSET_CONTENT_SECURITY_POLICY = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "frame-ancestors 'none'",
].join("; ");

const ALLOWED_UPSTREAM_HEADERS = new Set([
  "accept-ranges",
  "age",
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "etag",
  "expires",
  "last-modified",
  "vary",
]);

/**
 * The mirror loads images (SVG included), fonts, stylesheets and media through this route. The
 * replayer rebuilds <script> as <noscript> and writes frame documents itself, so scripts and
 * documents are never needed from here; serving them under their own type would hand the
 * remote site executable content on the gateway origin. They are relabelled text/plain, which
 * nosniff keeps from being run as script or rendered as markup. Unknown types become opaque
 * bytes.
 */
export function assetContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const essence = value.split(";", 1)[0]!.trim().toLowerCase();
  if (essence === "") return undefined;
  if (essence === "image/svg+xml") return "image/svg+xml";
  const type = essence.split("/", 1)[0];
  const xmlish = essence.endsWith("+xml") || essence.endsWith("/xml");
  if (PASSTHROUGH_CONTENT_TYPES.has(essence)) return value;
  if (!xmlish && (type === "image" || type === "font" || type === "audio" || type === "video")) {
    return value;
  }
  if (
    type === "text" ||
    xmlish ||
    essence.endsWith("+json") ||
    essence.endsWith("/json") ||
    SCRIPT_CONTENT_TYPES.has(essence)
  ) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

const PASSTHROUGH_CONTENT_TYPES = new Set([
  "text/css",
  "text/vtt",
  "application/octet-stream",
  "application/ogg",
  "application/vnd.ms-fontobject",
  "application/font-woff",
  "application/font-woff2",
  "application/font-sfnt",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/x-font-opentype",
  "application/x-font-truetype",
]);

const SCRIPT_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/x-ecmascript",
  "application/wasm",
]);

const IMMUTABLE_FONT_CACHE_CONTROL = "private, max-age=31536000, immutable";
const FONT_CONTENT_TYPES = new Set(["font/woff2", "font/woff", "font/ttf", "font/otf"]);

function headerValue(
  headers: Record<string, string | string[]>,
  target: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function isFontContentType(value: string | undefined): boolean {
  return (
    value !== undefined && FONT_CONTENT_TYPES.has(value.split(";", 1)[0]!.trim().toLowerCase())
  );
}
