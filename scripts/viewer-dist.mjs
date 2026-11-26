// The built viewer the UI smokes serve. They test what is in packages/viewer/dist, so a missing
// or stale build fails here with what to run, not later as a confusing UI difference.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BUILD = "pnpm --filter @mirror/viewer... run build";
const SOURCES = ["packages/viewer/src", "packages/viewer/index.html", "packages/protocol/src"];

function newest(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return { path, time: stat.mtimeMs };
  let found = { path, time: 0 };
  for (const entry of readdirSync(path)) {
    const candidate = newest(join(path, entry));
    if (candidate.time > found.time) found = candidate;
  }
  return found;
}

export function viewerDist() {
  const root = resolve("packages/viewer/dist");
  const index = join(root, "index.html");
  if (!existsSync(index)) throw new Error(`packages/viewer/dist is missing: run ${BUILD} first`);
  const built = statSync(index).mtimeMs;
  for (const source of SOURCES) {
    if (!existsSync(source)) continue;
    const changed = newest(source);
    if (changed.time > built)
      throw new Error(`packages/viewer/dist is older than ${changed.path}: run ${BUILD} first`);
  }
  return root;
}
