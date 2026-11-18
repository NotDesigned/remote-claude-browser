// Official management UI, pinned independently from the CPA engine.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CPA_PANEL_VERSION = "v1.28.3";
export const CPA_PANEL_SHA256 = "6d4e005420ee18899ef115a4e68d61f700ddb372844f2317546a0d0aa4553dfc";
export async function fetchCpaPanel(output, localFile) {
  let bytes;
  if (localFile) bytes = await readFile(localFile);
  else {
    const response = await fetch(
      `https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/${CPA_PANEL_VERSION}/management.html`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok) throw new Error(`CPA panel download returned HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== CPA_PANEL_SHA256)
    throw new Error("CPA panel does not match its pinned SHA256");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes, { mode: 0o644 });
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await fetchCpaPanel(process.argv[2], process.argv[3]);
