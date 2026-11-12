// Append CPA settings without rewriting existing browser credentials or the VLESS URI.
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export function prepareCpaEnv(source) {
  const env = parseEnv(source);
  if (!env.EGRESS_PROXY) throw new Error("Set EGRESS_PROXY in .env before enabling CPA");
  const additions = [];
  for (const key of ["CPA_API_KEY", "CPA_MANAGEMENT_KEY"]) {
    if (!env[key]) {
      env[key] = `cpa_${randomBytes(32).toString("hex")}`;
      additions.push(`${key}=${env[key]}`);
    }
    if (env[key].length < 32) throw new Error(`${key} must contain at least 32 characters`);
  }
  if (env.CPA_API_KEY === env.CPA_MANAGEMENT_KEY) throw new Error("CPA keys must be different");
  const files = (env.COMPOSE_FILE || "compose.yml")
    .split(":")
    .filter((f) => f && f !== "compose.cpa.yml" && f !== "compose.cpa.https.yml");
  files.push("compose.cpa.yml");
  const https = files.includes("compose.https.yml");
  if (https) {
    if (!env.PUBLIC_HOST) throw new Error("Set PUBLIC_HOST when using compose.https.yml");
    files.push("compose.cpa.https.yml");
  }
  const line = `COMPOSE_FILE=${files.join(":")}`;
  let result = source.replace(/^COMPOSE_FILE=.*$/m, line);
  if (!/^COMPOSE_FILE=/m.test(source)) additions.push(line);
  if (additions.length)
    result = result.trimEnd() + "\n\n# Optional CPA API service\n" + additions.join("\n") + "\n";
  return {
    text: result,
    origin: https ? `https://${env.PUBLIC_HOST}` : `http://127.0.0.1:${env.CPA_PORT || 8317}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2] || ".env";
    const source = await readFile(path, "utf8");
    const result = prepareCpaEnv(source);
    const temp = `${path}.cpa-${process.pid}`;
    await writeFile(temp, result.text, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
    console.log(
      `CPA panel: ${result.origin}/management.html\nAPI base URL: ${result.origin}/v1\nKeys are saved in ${path}: CPA_MANAGEMENT_KEY and CPA_API_KEY.\nRun: docker compose up -d --build cpa caddy (omit caddy without HTTPS).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CPA setup failed");
    process.exitCode = 1;
  }
}
