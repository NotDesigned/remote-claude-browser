/**
 * Nested cross-origin frames send their documents once after loading: a frame's document sent
 * again rebuilds it in the replay, under whoever is already using it. AGENT_BUNDLE_PATH runs the
 * check against another build of the agent.
 */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "../../..");
const gatewayRequire = createRequire(resolve(workspace, "packages/gateway/package.json"));
const { default: puppeteer } = gatewayRequire("puppeteer-core");
const { AGENT_BUNDLE } = await import(
  process.env.AGENT_BUNDLE_PATH ?? resolve(workspace, "packages/agent/dist/index.js")
);

async function executablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known executable.
    }
  }
  throw new Error("Chrome not found; set CHROME_PATH to run the frames acceptance");
}

function decodeChunks(chunks) {
  const partials = new Map();
  const messages = [];
  for (const chunk of chunks) {
    const match = /^M2\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|/.exec(chunk);
    assert(match, `invalid binding frame: ${chunk.slice(0, 40)}`);
    const [, docId, msgId, idx, total] = match;
    const key = `${docId}:${msgId}`;
    const slices = partials.get(key) ?? new Array(Number(total));
    slices[Number(idx)] = chunk.slice(match[0].length);
    partials.set(key, slices);
    if (slices.every((slice) => slice !== undefined)) {
      messages.push(JSON.parse(slices.join("")));
      partials.delete(key);
    }
  }
  return messages;
}

const quoted = (html) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const sandboxed = (html) =>
  `<iframe sandbox="allow-scripts" style="width:300px;height:200px" srcdoc="${quoted(html)}"></iframe>`;
const leaf = (tag) => `<!doctype html><p id="${tag}">${tag}</p>`;
const PAGE = `<!doctype html><title>Frames</title>${sandboxed(
  `<!doctype html><p>outer</p>${sandboxed(leaf("inner"))}`,
)}${sandboxed(leaf("single"))}`;

const browser = await puppeteer.launch({
  executablePath: await executablePath(),
  headless: true,
  // Sandboxed frames stay in the page's process, where the agent is added to every document.
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-site-isolation-trials",
    "--disable-features=IsolateSandboxedIframes,site-per-process",
  ],
});

try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__mirror_chunks = [];
    if (window === window.top)
      window.__mirror_emit = (payload) => window.__mirror_chunks.push(payload);
  });
  await page.evaluateOnNewDocument(AGENT_BUNDLE);
  await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`, { waitUntil: "load" });
  // Long past the ready messages and their answers, and the 250 ms between a frame's snapshots.
  await new Promise((done) => setTimeout(done, 3_000));

  const messages = decodeChunks(await page.evaluate(() => [...window.__mirror_chunks]));
  const events = messages.filter((message) => message.kind === "rrweb").map((message) => message.e);
  assert.equal(
    events.filter((event) => event.type === 2).length,
    1,
    "the page sent more than one snapshot",
  );
  const sent = new Map();
  /** Where in the stream each frame's document was last attached. */
  const lastAt = new Map();
  const visit = (node, found) => {
    if (node.attributes?.id) found.push(node.attributes.id);
    for (const child of node.childNodes ?? []) visit(child, found);
    return found;
  };
  events.forEach((event, index) => {
    if (event.type !== 3 || event.data.source !== 0 || event.data.isAttachIframe !== true) return;
    for (const { node } of event.data.adds) {
      if (node.type !== 0) continue;
      const ids = visit(node, []);
      const name = ids.includes("inner") ? "inner" : ids.includes("single") ? "single" : "outer";
      sent.set(name, (sent.get(name) ?? 0) + 1);
      lastAt.set(name, index);
    }
  });
  const snapshotAt = events.findIndex((event) => event.type === 2);
  // Every frame is filled in the replay: its document comes after the one holding its frame.
  assert.ok(lastAt.get("outer") > snapshotAt, "the outer frame's document came before the page");
  assert.ok(lastAt.get("single") > snapshotAt, "a frame's document came before the page");
  assert.ok(lastAt.get("inner") > lastAt.get("outer"), "the inner document came before its frame");
  assert.deepEqual(
    Object.fromEntries([...sent].sort()),
    { inner: 1, outer: 1, single: 1 },
    "a frame's document was sent more than once",
  );
  console.log("Frames acceptance: each nested frame's document was sent once after loading.");
} finally {
  await browser.close();
}
