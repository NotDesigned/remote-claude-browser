import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const gateway = process.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:3000";
const port = Number(process.env.VIEWER_PORT ?? 5173);

export default defineConfig({
  plugins: [preact()],
  build: {
    rollupOptions: {
      input: {
        browser: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/ws": { target: gateway, ws: true },
      "/s/": { target: gateway },
      // Present only when MIRROR_E2E=1; keeps the harness on the viewer's origin too.
      "/__e2e": { target: gateway },
    },
  },
});
