import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VIEWER_DIST_ROOT =
  process.env.VIEWER_DIST_ROOT ?? fileURLToPath(new URL("../../viewer/dist", import.meta.url));

/**
 * Only a reverse proxy on the same host (Caddy, or the SSH tunnel endpoint it feeds) may set
 * X-Forwarded-For. Without this every proxied client shares 127.0.0.1, so one bad password
 * attempt would back off every user at once.
 */
export const LOOPBACK_PROXIES = ["127.0.0.1", "::1"];

export function gatewayHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATEWAY_HOST ?? "127.0.0.1";
}

export async function registerViewerStatic(
  app: FastifyInstance,
  root = VIEWER_DIST_ROOT,
): Promise<boolean> {
  if (!existsSync(root)) return false;
  await app.register(fastifyStatic, {
    root,
    cacheControl: false,
    // @fastify/static 10 passes the Fastify reply here, despite typings naming the raw response.
    setHeaders(response, filePath) {
      const value = staticCacheControl(filePath);
      const target = response as unknown as {
        header?(name: string, value: string): unknown;
        setHeader?(name: string, value: string): unknown;
      };
      if (typeof target.header === "function") target.header("cache-control", value);
      else target.setHeader?.("cache-control", value);
    },
  });
  return true;
}

/**
 * Vite names everything under assets/ by content hash, so those files never change and need no
 * revalidation round trip through the tunnel. Pages keep revalidating to pick up new builds.
 * Everything sits behind the access gate, so shared caches must not keep it.
 */
export function staticCacheControl(filePath: string): string {
  return /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(filePath)
    ? "private, max-age=31536000, immutable"
    : "private, no-cache";
}
