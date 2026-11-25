import preact from "@preact/preset-vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

export default defineConfig(({ command }) => {
  // The development server and tests have no build to compare; such a page never reloads for one.
  const id = command === "build" ? buildId() : "dev";
  return {
    plugins: [preact(), viewerBuild(id)],
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
