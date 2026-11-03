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
  await app.register(fastifyStatic, { root });
  return true;
}
