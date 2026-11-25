#!/usr/bin/env node
// Documentation check (docs/documentation.md, principle 8): links and anchors, orphan files, the
// reader line, forbidden terms, the principle 3/4/6 greps, the environment variable table against
// the Compose files, interface labels against the viewer source, and file lengths.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);
const read = (file) => readFileSync(join(root, file), "utf8");

// 例外: legal and community files, the frozen upstream archive and .github/ templates.
const EXCEPTIONS = new Set([
  "THIRD_PARTY_NOTICES.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "UPSTREAM.md",
]);
const isException = (file) => EXCEPTIONS.has(file) || file.startsWith(".github/");
const isRecord = (file) => file.startsWith("docs/records/");
const SPEC = "docs/documentation.md";

const docs = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter((file) => file && existsSync(join(root, file)))
  .sort();
const checked = docs.filter((file) => !isException(file));

/** Text with fenced code blocks blanked out (line numbers kept). */
function withoutFences(text) {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line;
    })
    .join("\n");
}

/** Running prose: no code, link targets, HTML tags or comments. Keeps 「」 unless asked. */
function prose(text, { labels = true } = {}) {
  let out = withoutFences(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/<https?:[^>\s]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ");
  if (!labels) out = out.replace(/「[^」\n]*」/g, "「」");
  return out;
}

// ------------------------------------------------------------------ anchors and links
/** GitHub's heading slug. */
function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}
const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = read(file);
  const anchors = new Set();
  const counts = new Map();
  for (const line of withoutFences(text).split("\n")) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = slug(heading[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n ? `${base}-${n}` : base);
    }
  }
  for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
  anchorCache.set(file, anchors);
  return anchors;
}

for (const file of docs) {
  const text = withoutFences(read(file)).replace(/`[^`\n]*`/g, "");
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path, anchor] = target.split("#");
    const resolved = path ? normalize(join(dirname(file), decodeURI(path))) : file;
    if (resolved.startsWith("..") || !existsSync(join(root, resolved))) {
      fail(file, `broken link ${target}`);
      continue;
    }
    if (anchor === undefined) continue;
    if (!resolved.endsWith(".md")) continue;
    if (!anchorsOf(resolved).has(decodeURIComponent(anchor)))
      fail(file, `missing anchor ${target}`);
  }
}

// 对外锚点: the anchors remote-cc links to.
{
  const spec = read(SPEC);
  const section = spec.slice(spec.indexOf("## 对外锚点"), spec.indexOf("## 术语"));
  for (const match of section.matchAll(/^\|\s*`([^`]+\.md)`\s*\|\s*`([^`]+)`\s*\|/gm)) {
    const [, file, anchor] = match;
    if (!existsSync(join(root, file))) fail(SPEC, `对外锚点 file ${file} is missing`);
    else if (!anchorsOf(file).has(anchor)) fail(file, `对外锚点 ${anchor} is missing`);
  }
}

// ------------------------------------------------------------------ README 「文档」 table
{
  const readme = read("README.md");
  const start = readme.indexOf("## 文档");
  const section = start < 0 ? "" : readme.slice(start, readme.indexOf("\n## ", start + 1));
  if (start < 0) fail("README.md", "no 「文档」 section");
  const listed = new Set(
    [...section.matchAll(/\]\(([^)#\s]+)/g)].map((match) => normalize(match[1])),
  );
  for (const file of checked)
    if (file !== "README.md" && !listed.has(file))
      fail("README.md", `${file} is not in the 「文档」 table`);
}

// ------------------------------------------------------------------ reader line and length
for (const file of checked) {
  const lines = read(file).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = lines.findIndex((line) => line.trim() !== "");
  const reader = /^#\s/.test(lines[first] ?? "")
    ? lines.slice(first + 1).find((line) => line.trim() !== "")
    : lines[first];
  if (!reader?.startsWith("> 读者："))
    fail(file, "the first line after the title must be the 「> 读者：…」 line");
  const limit = file === "README.md" ? 150 : 400;
  if (lines.length > limit) fail(file, `${lines.length} lines, more than ${limit}`);
}

// ------------------------------------------------------------------ terms and greps
// The 「不要写」 column of 术语 that can be searched for; the rest needs a reader's judgement.
const FORBIDDEN = [
  ["Remote Browser", /Remote Browser/],
  ["remote-browser", /remote-browser/],
  ["rcc", /(?<![\w./-])rcc(?![\w-])/],
  ["profile", /(?<![\w./-])profiles?(?![\w-])/i],
  ["浏览器账号", /浏览器账号/],
  ["browser account", /browser accounts?/i],
  ["workspace", /(?<![\w-])workspace(?![\w-])/i],
  ["前端", /前端/],
  ["service users", /service users/i],
  ["用户管理", /用户管理/],
  ["admin panel", /admin panel/i],
  ["「工作台 → 代理」", /工作台\s*→\s*代理/],
  ["「工作台 → API」", /工作台\s*→\s*API/],
  ["代理池", /代理池/],
  ["代理节点", /代理节点/],
  ["出口节点", /出口节点/],
  ["部署默认出口", /部署默认出口/],
  ["deployment default exit", /deployment default exit/i],
  ["图像模式", /图像模式/],
  ["picture mode", /picture mode/i],
  ["远程窗口", /远程窗口/],
  ["专用实例", /专用实例/],
  ["共享账号池", /共享账号池/],
  ["外部 API Key", /外部 API Key/],
  ["个人 Key", /个人 Key/],
  ["inference key", /inference key/i],
  ["浏览器宿主机", /浏览器宿主机/],
  ["Agent", /(?<![\w-])Agent(?![\w-])/],
  ["指纹身份", /指纹身份/],
  ["指纹浏览器", /指纹浏览器/],
  ["运维者", /运维者/],
  ["operator", /(?<![\w-])operators?(?![\w-])/i],
  ["会话许可", /会话许可/],
];
{
  const spec = read(SPEC);
  const terms = spec.slice(spec.indexOf("## 术语"));
  for (const [word] of FORBIDDEN)
    if (!terms.includes(word.replace(/[「」]/g, "")))
      fail("scripts/docs-check.mjs", `「${word}」 is not in the 术语 table any more`);
}
const P3 = [/v0\.[0-9]/, /旧版/, /兼容：/, /已移除/, /草案/, /之前的版本/];
const P4 = [/\.ts:[0-9]/, /\.go:[0-9]/, /已实测/, /里程碑/, /待完成/, /TODO/];
const REMOTE_CC_LINK = "github.com/NotDesigned/remote-cc";

for (const file of checked) {
  if (file === SPEC) continue;
  const raw = read(file);
  const text = prose(raw, { labels: false }).split("\n");
  const rawLines = raw.split("\n");
  const history = file === "CHANGELOG.md" || isRecord(file);
  text.forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    if (!history && file !== "UPSTREAM.md")
      for (const [word, pattern] of FORBIDDEN)
        if (pattern.test(line)) errors.push(`${at}: forbidden term 「${word}」 (术语)`);
    if (!history) {
      for (const pattern of P3)
        if (pattern.test(line) && !rawLines[index].includes("CHANGELOG.md"))
          errors.push(`${at}: ${pattern.source} belongs in CHANGELOG (principle 3)`);
      for (const pattern of P4)
        if (pattern.test(rawLines[index].replace(/「[^」]*」/g, "")))
          errors.push(`${at}: ${pattern.source} outside docs/records (principle 4)`);
      for (const word of ["rcc-egress", "netns"])
        if (rawLines[index].includes(word) && !rawLines[index].includes(REMOTE_CC_LINK))
          errors.push(`${at}: ${word} only in a sentence linking to remote-cc (principle 6)`);
    }
    // Principle 7: a run of 8 or more English words is English prose.
    if (/(?:[A-Za-z][A-Za-z'’-]*[\s,;:]+){7}[A-Za-z]/.test(line.replace(/「[^」]*」/g, "")))
      errors.push(`${at}: English sentence (principle 7)`);
  });
}

// ------------------------------------------------------------------ environment variables
{
  const composeFiles = [
    ...readdirSync(root).filter((name) => /^compose.*\.ya?ml$/.test(name)),
    ...readdirSync(join(root, "client"))
      .filter((name) => /^compose.*\.ya?ml$/.test(name))
      .map((name) => `client/${name}`),
  ];
  const expected = new Set();
  for (const file of composeFiles)
    for (const match of read(file).matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) expected.add(match[1]);
  for (const file of [".env.example", "client/.env.example"])
    for (const match of read(file).matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) expected.add(match[1]);

  const config = "docs/configuration.md";
  const documented = new Set();
  const other = new Set();
  let envSection = false;
  for (const line of withoutFences(read(config)).split("\n")) {
    if (/^## /.test(line)) envSection = line.includes(".env");
    const cell = /^\|([^|]*)\|/.exec(line);
    if (!cell || /^\|\s*-/.test(line)) continue;
    for (const match of cell[1].matchAll(/`([A-Z][A-Z0-9_]+)`/g))
      (envSection ? documented : other).add(match[1]);
  }
  for (const name of expected)
    if (!documented.has(name))
      fail(config, `${name} (Compose or .env.example) is not in the table`);
  for (const name of documented)
    if (!expected.has(name))
      fail(config, `${name} is in the table but not in Compose or .env.example`);

  // Variables outside the .env sections must still exist somewhere in the code.
  const sources = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(m?[jt]sx?|mts|sh|ya?ml)$|^Dockerfile/.test(name)) sources.push(read(path));
    }
  };
  for (const dir of ["packages", "deploy", "client"]) walk(dir);
  sources.push(...composeFiles.map(read));
  const code = sources.join("\n");
  for (const name of other)
    if (!new RegExp(`\\b${name}\\b`).test(code))
      fail(config, `${name} is not used anywhere in the code`);
}

// ------------------------------------------------------------------ interface labels
{
  const corpus = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = join(dir, name);
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/.test(name)) corpus.push(read(path));
    }
  };
  walk("packages/viewer/src");
  // The sign-in page and its single sign-on button come from the gateway.
  corpus.push(read("packages/gateway/src/auth/gate-page.ts"));
  corpus.push(read("packages/gateway/src/auth/oidc.ts"));
  const haystack = corpus.join("\n").replace(/\s+/g, " ");
  for (const file of ["docs/usage.md", "docs/admin.md"]) {
    const text = prose(read(file));
    for (const match of text.matchAll(/「([^」\n]+)」/g))
      if (!haystack.includes(match[1].replace(/\s+/g, " ")))
        fail(file, `interface label 「${match[1]}」 is not in packages/viewer/src`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\ndocs:check: ${errors.length} problem(s). Rules: ${SPEC}`);
  process.exit(1);
}
console.log(`docs:check: ${docs.length} Markdown files OK`);
