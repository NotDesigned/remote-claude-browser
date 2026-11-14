import { build } from "esbuild";

const banner = {
  js: 'import { createRequire as nodeRequire } from "node:module"; const require = nodeRequire(import.meta.url);',
};

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner,
  outfile: "dist/main.mjs",
  sourcemap: false,
  external: ["@fastify/static", "dockerode", "fastify", "puppeteer-core", "undici", "ws"],
  logLevel: "warning",
});

console.log("@mirror/gateway: built dist/main.mjs");

await build({
  entryPoints: ["../../deploy/profile-broker.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner,
  outfile: "dist/profile-broker.mjs",
  logLevel: "warning",
});
