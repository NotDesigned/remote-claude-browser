/**
 * The rrweb patches in patches/ only count when they are what is installed. A patch edited without
 * `pnpm install` keeps the old hash in the lockfile, and a node_modules installed before the edit
 * keeps the old code: tests then pass against code that is not what ships. Checks that
 *  - pnpm-lock.yaml records each patch of package.json with the hash of the file as it is now,
 *  - every workspace package resolves the patched package to the build made with that hash,
 *  - and that build contains every line the patch adds.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** pnpm 9's patch hash: base32 of the MD5 of the file, with CRLF read as LF, unpadded. */
export function patchHash(content) {
  const digest = createHash("md5").update(content.replace(/\r\n/g, "\n")).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The lockfile's `patchedDependencies`: key -> { hash, path }. */
export function lockedPatches(lockfile) {
  const patches = new Map();
  const block = /^patchedDependencies:\n((?:[ ].*\n?)*)/m.exec(lockfile);
  if (block === null) return patches;
  let current = null;
  for (const line of block[1].split("\n")) {
    const key = /^ {2}'?([^':]+(?::[^':]+)?)'?:\s*$/.exec(line);
    if (key !== null) {
      current = { hash: undefined, path: undefined };
      patches.set(key[1], current);
      continue;
    }
    const field = /^ {4}(hash|path):\s*(\S+)\s*$/.exec(line);
    if (field !== null && current !== null) current[field[1]] = field[2];
  }
  return patches;
}

/** The lines a patch adds, per file it changes (`dist/record.js` and so on). */
export function addedLines(patch) {
  const files = new Map();
  let lines = null;
  for (const line of patch.split("\n")) {
    const target = /^\+\+\+ b\/(.+)$/.exec(line);
    if (target !== null) {
      lines = [];
      files.set(target[1], lines);
      continue;
    }
    if (lines !== null && line.startsWith("+") && line.slice(1).trim() !== "")
      lines.push(line.slice(1).trim());
  }
  return files;
}

/** Splits `@scope/name@1.2.3` into its name and version. */
function splitKey(key) {
  const at = key.lastIndexOf("@");
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** Every problem found, as messages; empty when the patches are what is installed. */
export function checkPatches(root) {
  const errors = [];
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = manifest.pnpm?.patchedDependencies ?? {};
  const lockPath = join(root, "pnpm-lock.yaml");
  const locked = existsSync(lockPath) ? lockedPatches(readFileSync(lockPath, "utf8")) : new Map();
  const packagesDir = join(root, "packages");
  const workspaces = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packagesDir, entry.name))
    : [];

  for (const [key, relativePath] of Object.entries(declared)) {
    const patchPath = join(root, relativePath);
    if (!existsSync(patchPath)) {
      errors.push(`${relativePath}: the patch for ${key} is missing`);
      continue;
    }
    const patch = readFileSync(patchPath, "utf8");
    const hash = patchHash(patch);
    const lock = locked.get(key);
    if (lock === undefined) {
      errors.push(`pnpm-lock.yaml has no patch for ${key} — run pnpm install`);
    } else {
      if (lock.path !== relativePath)
        errors.push(`pnpm-lock.yaml patches ${key} from ${lock.path}, not ${relativePath}`);
      if (lock.hash !== hash)
        errors.push(
          `pnpm-lock.yaml records ${key} with patch hash ${lock.hash}, but ${relativePath} hashes to ${hash} — run pnpm install`,
        );
    }

    const { name, version } = splitKey(key);
    const additions = addedLines(patch);
    let installed = 0;
    for (const workspace of workspaces) {
      const link = join(workspace, "node_modules", name);
      if (!existsSync(link)) continue;
      installed++;
      const dir = realpathSync(link);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.version !== version) continue;
      if (!dir.includes(`_patch_hash=${hash}`)) {
        errors.push(
          `${link} resolves to ${dir}, not the build patched with ${hash} — run pnpm install --frozen-lockfile`,
        );
        continue;
      }
      for (const [file, lines] of additions) {
        const path = join(dir, file);
        const text = existsSync(path) ? readFileSync(path, "utf8") : null;
        const missing = text === null ? lines : lines.filter((line) => !text.includes(line));
        if (missing.length > 0)
          errors.push(
            `${path} lacks ${missing.length} line(s) ${relativePath} adds, such as ${JSON.stringify(missing[0])} — reinstall`,
          );
      }
    }
    if (installed === 0 && existsSync(join(root, "node_modules")))
      errors.push(`no workspace package has ${name} installed, so its patch is not checked`);
  }
  return errors;
}
