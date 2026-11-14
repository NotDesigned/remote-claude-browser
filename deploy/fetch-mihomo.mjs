// Pinned upstream release; this file is shared by image builds and local checks.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const MIHOMO_VERSION = "v1.19.34";
export const MIHOMO_ARCHIVES = {
  amd64: {
    name: "mihomo-linux-amd64-v1-v1.19.34.gz",
    sha256: "0c07340a01408d033dda4088ea2a4c1e4d82aeed7b2f84f7c046e93b6ff3290c",
  },
  arm64: {
    name: "mihomo-linux-arm64-v1.19.34.gz",
    sha256: "daaf78a6240a282cdfd75bcbf98fe321f6bd52765cc29e79f344191198f0b50f",
  },
};
export async function fetchMihomo(arch, output, archivePath) {
  const release = MIHOMO_ARCHIVES[arch];
  if (!release) throw new Error("Mihomo supports amd64 and arm64 in this build");
  const cached = process.env.MIHOMO_CACHE_DIR && join(process.env.MIHOMO_CACHE_DIR, release.name);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  let bytes;
  if (archivePath) bytes = await readFile(archivePath);
  else if (cached) {
    try {
      bytes = await readFile(cached);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (bytes && digest(bytes) !== release.sha256) bytes = undefined;
  }
  if (!bytes) {
    const response = await fetch(
      `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${release.name}`,
      { signal: AbortSignal.timeout(900_000) },
    );
    if (!response.ok) throw new Error(`Mihomo download returned HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (digest(bytes) !== release.sha256)
    throw new Error("Mihomo archive does not match its pinned SHA256");
  if (cached && !archivePath) {
    await mkdir(process.env.MIHOMO_CACHE_DIR, { recursive: true });
    await writeFile(cached + ".part", bytes);
    await rename(cached + ".part", cached);
  }
  const binary = gunzipSync(bytes);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "mihomo"), binary, { mode: 0o755 });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [arch, output, archive] = process.argv.slice(2);
  if (!arch || !output)
    throw new Error("usage: fetch-mihomo.mjs <amd64|arm64> <output directory> [archive]");
  await fetchMihomo(arch, output, archive);
}
