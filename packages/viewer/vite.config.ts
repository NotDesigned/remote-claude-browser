import preact from "@preact/preset-vite";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

const gateway = process.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:3000";
const port = Number(process.env.VIEWER_PORT ?? 5173);

/**
 * Names this build: release version, commit when there is one, and build time, so that no two
 * builds share it. The page compares it with the one the gateway serves (the gateway reads
 * build-id.txt) to notice that it was loaded before a deploy.
 */
function buildId(): string {
  const { version } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  let commit = "local";
  try {
    commit = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Image builds have no repository; the build time still tells builds apart.
  }
  return `${version}+${commit}.${Date.now().toString(36)}`;
}

function viewerBuild(id: string): Plugin {
  return {
    name: "viewer-build-id",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build-id.txt", source: `${id}\n` });
    },
  };
}

/**
 * Writes a Brotli and a gzip copy beside every script, style sheet and image the page loads, once
 * at build time and at the highest levels: the gateway serves them (preCompressed in
 * packages/gateway/src/serving.ts), so no request compresses anything, and a reverse proxy's
 * on-the-fly compression leaves an already-encoded response alone.
 */
export function precompress(): Plugin {
  return {
    name: "viewer-precompress",
    apply: "build",
    writeBundle(options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!/\.(js|css|svg|html|json|txt)$/.test(fileName)) continue;
        const source = output.type === "chunk" ? output.code : output.source;
        const bytes = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
        if (bytes.length < 1024) continue;
        const file = join(options.dir!, fileName);
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(bytes, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
            },
          }),
        );
        writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
      }
    },
  };
}

export default defineConfig(({ command }) => {
  // The development server and tests have no build to compare; such a page never reloads for one.
  const id = command === "build" ? buildId() : "dev";
  return {
    plugins: [preact(), viewerBuild(id), precompress()],
    define: { __VIEWER_BUILD__: JSON.stringify(id) },
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      proxy: {
        "/ws": { target: gateway, ws: true },
        "/s/": { target: gateway },
        "/api/": { target: gateway },
        "/gate": { target: gateway },
        "/logout": { target: gateway },
        // Present only when MIRROR_E2E=1; keeps the harness on the viewer's origin too.
        "/__e2e": { target: gateway },
      },
    },
  };
});
