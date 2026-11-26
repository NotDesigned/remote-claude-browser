import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addedLines, checkPatches, lockedPatches, patchHash } from "./rrweb-patches.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const PATCH = `diff --git a/dist/x.js b/dist/x.js
--- a/dist/x.js
+++ b/dist/x.js
@@ -1,2 +1,3 @@
 const a = 1;
+const patched = true;
 export { a };
`;

/** A workspace whose package `@x/y@1.0.0` is patched, installed as `installedWith` built it. */
function workspace({ patch = PATCH, lockHash = patchHash(PATCH), installedWith = PATCH } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rrweb-patches-"));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    "package.json",
    JSON.stringify({
      pnpm: { patchedDependencies: { "@x/y@1.0.0": "patches/@x__y@1.0.0.patch" } },
    }),
  );
  write("patches/@x__y@1.0.0.patch", patch);
  write(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\n\npatchedDependencies:\n  '@x/y@1.0.0':\n    hash: ${lockHash}\n    path: patches/@x__y@1.0.0.patch\n\nimporters:\n`,
  );
  const built = `node_modules/.pnpm/@x+y@1.0.0_patch_hash=${patchHash(installedWith)}/node_modules/@x/y`;
  write(`${built}/package.json`, JSON.stringify({ name: "@x/y", version: "1.0.0" }));
  write(
    `${built}/dist/x.js`,
    installedWith === PATCH ? "const a = 1;\nconst patched = true;\nexport { a };\n" : "old\n",
  );
  mkdirSync(join(root, "packages/a/node_modules/@x"), { recursive: true });
  symlinkSync(join(root, built), join(root, "packages/a/node_modules/@x/y"));
  return root;
}

test("hashes a patch as pnpm does, and reads the lockfile's patches", () => {
  const lock = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  for (const [key, path] of Object.entries(manifest.pnpm.patchedDependencies)) {
    const locked = lockedPatches(lock).get(key);
    assert.equal(locked?.path, path);
    assert.equal(locked?.hash, patchHash(readFileSync(join(repo, path), "utf8")));
  }
  assert.equal(patchHash("a\r\nb"), patchHash("a\nb"));
});

test("reads the lines a patch adds, file by file", () => {
  assert.deepEqual([...addedLines(PATCH)], [["dist/x.js", ["const patched = true;"]]]);
});

test("passes when the patch is locked and installed", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkPatches(root), []);
});

test("fails when the patch changed after the lockfile", (t) => {
  const edited = PATCH.replace("+const patched = true;", "+const patched = 2;");
  const root = workspace({ patch: edited, installedWith: edited });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.match(checkPatches(root).join("\n"), /records @x\/y@1\.0\.0 with patch hash/);
});

test("fails when node_modules was installed from another patch", (t) => {
  const root = workspace({ installedWith: `${PATCH}+older\n` });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.match(checkPatches(root).join("\n"), /not the build patched with/);
});

test("fails when the installed build lacks the patch's lines", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = join(
    root,
    `node_modules/.pnpm/@x+y@1.0.0_patch_hash=${patchHash(PATCH)}/node_modules/@x/y/dist/x.js`,
  );
  writeFileSync(built, "const a = 1;\n");
  assert.match(checkPatches(root).join("\n"), /lacks 1 line/);
});
