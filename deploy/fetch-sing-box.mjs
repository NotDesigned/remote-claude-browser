// Fetches the one sing-box release the image carries and checks it before anything uses it. The image
// build and the deployment script both come here, so they cannot disagree about which binary it is.
// It writes the binary and its license, which goes wherever the binary does.
//   node deploy/fetch-sing-box.mjs <amd64|arm64> <output directory> [cached archive path]
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const SING_BOX_VERSION = "1.14.4";
/** GitHub's digests of the release archives. */
const ARCHIVE_SHA256 = {
  amd64: "699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968",
  arm64: "436441f76ee2f7fe21b5b2d426d3cb261a480455a704865789ad533e4273ec26",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The bytes of one file in a tar archive. */
export function tarMember(tar, wanted) {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
    const size = parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1);
    const start = offset + 512;
    if (name === wanted && (type === "" || type === "0")) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} is not in the archive`);
}

async function archive(arch, cache) {
  const expected = ARCHIVE_SHA256[arch];
  if (!expected) throw new Error(`no sing-box for ${arch}; amd64 and arm64 are known`);
  if (cache) {
    const cached = await readFile(cache).catch(() => null);
    if (cached && sha256(cached) === expected) return cached;
  }
  const name = `sing-box-${SING_BOX_VERSION}-linux-${arch}.tar.gz`;
  const response = await fetch(
    `https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/${name}`,
  );
  if (!response.ok) throw new Error(`downloading ${name} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${name} does not match its known digest`);
  if (cache) {
    await writeFile(`${cache}.part`, bytes);
    await rename(`${cache}.part`, cache);
  }
  return bytes;
}

const [arch, output, cache] = process.argv.slice(2);
if (!arch || !output) {
  console.error("usage: fetch-sing-box.mjs <amd64|arm64> <output directory> [cached archive path]");
  process.exit(2);
}
try {
  const tar = gunzipSync(await archive(arch, cache));
  const folder = `sing-box-${SING_BOX_VERSION}-linux-${arch}`;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "sing-box"), tarMember(tar, `${folder}/sing-box`), { mode: 0o755 });
  await writeFile(join(output, "LICENSE"), tarMember(tar, `${folder}/LICENSE`), { mode: 0o644 });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
