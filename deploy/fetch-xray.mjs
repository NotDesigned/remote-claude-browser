// Image builds and remote deployments use the same pinned, checksum-verified Xray release.
// node deploy/fetch-xray.mjs <amd64|arm64> <output directory> [cached archive path]
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

export const XRAY_VERSION = "26.11.9";
const ARCHIVES = {
  amd64: {
    name: "Xray-linux-64.zip",
    sha256: "b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82",
  },
  arm64: {
    name: "Xray-linux-arm64-v8a.zip",
    sha256: "64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be",
  },
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Read only named members, never extract archive paths to the filesystem.
export function zipMember(zip, wanted) {
  if (zip.length < 22) throw new Error("invalid Xray ZIP directory");
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50)
    throw new Error("invalid Xray ZIP directory");
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("invalid Xray ZIP entry");
    const method = zip.readUInt16LE(offset + 10),
      size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28),
      extraLength = zip.readUInt16LE(offset + 30),
      commentLength = zip.readUInt16LE(offset + 32);
    if (zip.toString("utf8", offset + 46, offset + 46 + nameLength) === wanted) {
      const local = zip.readUInt32LE(offset + 42);
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50)
        throw new Error("invalid Xray ZIP local entry");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + size > zip.length) throw new Error("truncated Xray ZIP member");
      const bytes = zip.subarray(start, start + size);
      if (method === 0) return bytes;
      if (method === 8) return inflateRawSync(bytes);
      throw new Error("unsupported Xray ZIP compression");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} is not in the Xray archive`);
}
export async function fetchXray(arch, output, cache) {
  const release = ARCHIVES[arch];
  if (!release) throw new Error(`no Xray for ${arch}; amd64 and arm64 are supported`);
  let bytes = cache ? await readFile(cache).catch(() => null) : null;
  if (!bytes || sha256(bytes) !== release.sha256) {
    const response = await fetch(
      `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${release.name}`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok)
      throw new Error(`downloading ${release.name} failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== release.sha256)
      throw new Error(`${release.name} does not match its known digest`);
    if (cache) {
      await writeFile(`${cache}.part`, bytes);
      await rename(`${cache}.part`, cache);
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "xray"), zipMember(bytes, "xray"), { mode: 0o755 });
  await writeFile(join(output, "LICENSE"), zipMember(bytes, "LICENSE"), { mode: 0o644 });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [arch, output, cache] = process.argv.slice(2);
  if (!arch || !output) {
    console.error("usage: fetch-xray.mjs <amd64|arm64> <output directory> [cached archive path]");
    process.exit(2);
  }
  try {
    await fetchXray(arch, output, cache);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
