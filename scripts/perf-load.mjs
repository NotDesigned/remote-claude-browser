/**
 * Measures how long the workbench takes to become usable, phase by phase, against a running server
 * (for example the stack scripts/compose-smoke.sh starts; PERF_LOAD=1 there runs this script).
 *
 *   PERF_ORIGIN=http://127.0.0.1:8080 PERF_USERNAME=… PERF_PASSWORD=… \
 *   PERF_FIXTURE_ORIGIN=http://203.0.113.21:18080 PERF_PROXY=socks5://203.0.113.21:1080 \
 *   CHROME_PATH=… node scripts/perf-load.mjs
 *
 * PERF_NETWORK picks the device's network: "4g" (100 ms round trip, 10 Mbit/s down, 5 up, the
 * default), "wifi" (20 ms, 50/20 Mbit/s) or "none". PERF_RUNS (default 3) repeats each
 * measurement; the table shows the median. PERF_JSON=file also writes every sample.
 *
 * What it measures, each in a fresh browser context unless noted:
 *  - the workbench's assets: bytes on the wire and in memory for every script and style sheet;
 *  - login → profile picker usable, and which API requests the picker waits for;
 *  - pick → browser started (the gateway's Server-Timing phases), viewer connected, first page
 *    rebuilt, input ready; on a new profile every run, so its browser starts cold;
 *  - the same profile picked again from another page while its browser runs (warm), and, with
 *    PERF_CLOSE_BROWSER, once more after its browser closed (cold, with its exit known);
 *  - a navigation to a large page, and a reload of the workbench while its session lives.
 *
 * It creates one profile per cold run (named perf-load-…) and deletes it afterwards.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.PERF_ORIGIN ?? process.env.SMOKE_ORIGIN;
const username = process.env.PERF_USERNAME ?? process.env.SMOKE_USERNAME ?? "admin";
const password = process.env.PERF_PASSWORD ?? process.env.SMOKE_PASSWORD;
const fixtureOrigin = process.env.PERF_FIXTURE_ORIGIN ?? process.env.SMOKE_FIXTURE_ORIGIN;
const proxy = process.env.PERF_PROXY;
const runs = Number(process.env.PERF_RUNS ?? 3);
// A shell command that closes one profile's browser ({id} is its id), for example
// `docker exec <server> pkill -f -- --user-data-dir=/data/accounts/{id}`; without it the
// "known exit" cold start is not measured.
const closeBrowser = process.env.PERF_CLOSE_BROWSER;
assert.ok(
  origin && password && fixtureOrigin,
  "Set PERF_ORIGIN, PERF_PASSWORD and PERF_FIXTURE_ORIGIN",
);

const NETWORKS = {
  "4g": { latency: 100, downloadThroughput: 10e6 / 8, uploadThroughput: 5e6 / 8 },
  wifi: { latency: 20, downloadThroughput: 50e6 / 8, uploadThroughput: 20e6 / 8 },
  none: null,
};
const network = process.env.PERF_NETWORK ?? "4g";
assert.ok(network in NETWORKS, `PERF_NETWORK is one of ${Object.keys(NETWORKS).join(", ")}`);

const fixturePage = (html) => `${fixtureOrigin}/?html=${Buffer.from(html).toString("base64url")}`;
/** A long conversation-like page, built by its own script so that the address stays short. */
const LARGE_PAGE = `<!doctype html><meta charset="utf-8"><title>Large page</title>
<style>${Array.from({ length: 300 }, (_, i) => `.c${i}{color:hsl(${i},40%,30%);margin:${i % 7}px}`).join("")}
.msg{font:15px/1.5 sans-serif;padding:12px;border-bottom:1px solid #ddd}.msg pre{background:#f4f4f4;padding:8px}</style>
<main id="log"></main><script>
const log = document.getElementById("log");
const words = "the quick brown fox jumps over a lazy dog while remote browsers mirror pages".split(" ");
for (let i = 0; i < 400; i++) {
  const msg = document.createElement("article");
  msg.className = "msg c" + (i % 300);
  let text = "";
  for (let w = 0; w < 60; w++) text += words[(i * 7 + w) % words.length] + " ";
  msg.innerHTML = "<h3>Message " + i + "</h3><p>" + text + "</p><ul><li>one</li><li>two</li><li>three</li></ul>" +
    (i % 5 === 0 ? "<pre><code>const x = " + i + ";\\nconsole.log(x);</code></pre>" : "");
  log.append(msg);
}
const done = document.createElement("p");
done.id = "perf-done";
done.textContent = "done";
document.body.append(done);
</script>`;

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const samples = {};
const record = (name, value) => (samples[name] ??= []).push(value);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });

async function newPage(context) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (NETWORKS[network])
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NETWORKS[network] });
  // WebSocket frames, for the size of what the viewer receives.
  const frames = [];
  cdp.on("Network.webSocketFrameReceived", ({ timestamp, response }) =>
    frames.push({
      at: timestamp,
      bytes:
        response.opcode === 2
          ? (response.payloadData.length * 3) / 4
          : Buffer.byteLength(response.payloadData),
    }),
  );
  return { page, cdp, frames };
}

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
    // When the picker first shows a profile, in the page's own time: from the start of its
    // navigation, which for the page after logging in includes the login's POST and redirect.
    const watch = new MutationObserver(() => {
      if (!document.querySelector("button.profile-card")) return;
      window.__perfPickerAt = performance.now();
      watch.disconnect();
    });
    watch.observe(document, { childList: true, subtree: true });
  });
  return context;
}

/** Same-origin API call from the page, with its cookies. */
const call = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    { method, path, body },
  );

const mirrorShows = (page, id, timeout = 60_000) =>
  page.waitForFunction(
    (id) => {
      const host = document.getElementById("mirror-host");
      const frame = host?.querySelector(".mirror-stage:not([data-parked]) iframe");
      return !!frame?.contentDocument?.getElementById(id);
    },
    id,
    { timeout, polling: 16 },
  );
const inputReady = (page) =>
  page.waitForFunction(
    () => document.getElementById("mirror-host")?.dataset.inputReady === "true",
    undefined,
    { timeout: 60_000, polling: 16 },
  );
const rebuildMeasures = (page) =>
  page.evaluate(() =>
    performance.getEntriesByName("mirror-rebuild").map((entry) => entry.duration),
  );

function serverTiming(header) {
  const phases = {};
  for (const part of (header ?? "").split(",")) {
    const match = /^\s*([\w-]+);dur=([\d.]+)/.exec(part);
    if (match) phases[match[1]] = (phases[match[1]] ?? 0) + Number(match[2]);
  }
  return phases;
}

async function login(page) {
  const started = Date.now();
  await page.goto(origin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  const submitted = Date.now();
  await page.locator('button[type="submit"]').click();
  await page.locator("button.profile-card").first().waitFor({ timeout: 60_000 });
  return {
    gate: submitted - started,
    picker: await page.evaluate(() => window.__perfPickerAt),
  };
}

/** What the workbench page loaded, from its resource timing. */
async function resources(page) {
  return page.evaluate(() =>
    [
      ...performance.getEntriesByType("navigation"),
      ...performance.getEntriesByType("resource"),
    ].map((entry) => ({
      name: new URL(entry.name).pathname,
      type: entry.initiatorType ?? "navigation",
      start: Math.round(entry.startTime),
      duration: Math.round(entry.duration),
      transfer: entry.transferSize,
      body: entry.decodedBodySize,
      encoded: entry.encodedBodySize,
    })),
  );
}

let defaultProxyId;
async function prepare(page) {
  const accounts = (await call(page, "GET", "/api/accounts")).json;
  defaultProxyId = accounts.accounts.find((account) => account.proxyId)?.proxyId;
  if (defaultProxyId || !proxy) return;
  const imported = await call(page, "POST", "/api/proxy-sources", {
    name: "perf-load exit",
    visibility: "private",
    content: `${proxy}#perf`,
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  const { proxies } = (await call(page, "GET", "/api/proxies")).json;
  defaultProxyId = proxies[0].id;
  const bound = await call(page, "PATCH", "/api/accounts/default/proxy", {
    proxyId: defaultProxyId,
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.json));
}

/** Picks the profile on a page showing the picker; its browser is not running. */
async function pickCold(page, frames, name, label) {
  await page.locator("button.profile-card").first().waitFor();
  const framesBefore = frames.length;
  const picked = Date.now();
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/client/session", {
      timeout: 90_000,
    }),
    page.locator("button.profile-card").filter({ hasText: name }).click(),
  ]);
  const answered = Date.now();
  assert.equal(response.status(), 200, await response.text());
  const phases = serverTiming(await response.headerValue("server-timing"));
  for (const [phase, ms] of Object.entries(phases)) record(`  ${label} server: ${phase}`, ms);
  record(`pick → session answered (${label})`, answered - picked);
  await page.waitForFunction(
    () => document.querySelector("[data-connection]")?.getAttribute("data-connection") === "open",
    undefined,
    { timeout: 60_000, polling: 16 },
  );
  record(`pick → viewer connected (${label})`, Date.now() - picked);
  await page.waitForFunction(
    () => performance.getEntriesByName("mirror-rebuild").length > 0,
    undefined,
    { timeout: 60_000, polling: 16 },
  );
  record(`pick → first page rebuilt (${label})`, Date.now() - picked);
  await inputReady(page);
  record(`pick → input ready (${label})`, Date.now() - picked);
  record(`first snapshot rebuild ms (${label})`, (await rebuildMeasures(page))[0]);
  record(
    `WS bytes until ready (${label})`,
    frames.slice(framesBefore).reduce((sum, frame) => sum + frame.bytes, 0),
  );
}

async function coldRun(run) {
  const context = await newContext();
  const { page, frames } = await newPage(context);
  const apiRequests = [];
  page.on("requestfinished", async (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    const timing = request.timing();
    apiRequests.push({ path, start: timing.startTime, end: timing.startTime + timing.responseEnd });
  });
  const steps = await login(page);
  record("login POST → picker usable", steps.picker);
  if (run === 0) {
    const loaded = await resources(page);
    console.log("\nWorkbench assets (first cold load):");
    for (const entry of loaded.filter((entry) => !entry.name.startsWith("/api/")))
      console.log(
        `  ${entry.name.padEnd(40)} ${String(entry.transfer).padStart(8)} B wire ${String(entry.body).padStart(8)} B ${String(entry.duration).padStart(6)} ms (at ${entry.start})`,
      );
    const first = Math.min(...apiRequests.map((request) => request.start));
    console.log("API requests until the picker was usable:");
    for (const request of apiRequests.sort((a, b) => a.start - b.start))
      console.log(
        `  ${request.path.padEnd(40)} ${String(Math.round(request.start - first)).padStart(6)} → ${String(Math.round(request.end - first)).padStart(6)} ms`,
      );
    const jsBytes = loaded
      .filter((entry) => entry.name.endsWith(".js"))
      .reduce((sum, entry) => sum + entry.transfer, 0);
    record("viewer JS on the wire (B)", jsBytes);
  }
  if (!defaultProxyId) await prepare(page);
  const made = (
    await call(page, "POST", "/api/accounts", { name: `perf-load-${run}`, proxyId: defaultProxyId })
  ).json;
  assert.ok(made?.id, "Could not create a profile");
  await page.reload();
  await pickCold(page, frames, `perf-load-${run}`, "cold, new profile");

  // A large page, then a reload of the workbench while the session lives.
  const address = page.locator("#urlbar input");
  await page
    .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  const navFrames = frames.length;
  const navigated = Date.now();
  await address.fill(fixturePage(LARGE_PAGE));
  await address.press("Enter");
  await mirrorShows(page, "perf-done");
  record("navigate → large page shown", Date.now() - navigated);
  const measures = await rebuildMeasures(page);
  record("large page rebuild (ms)", measures.at(-1));
  record(
    "large page WS bytes",
    frames.slice(navFrames).reduce((sum, frame) => sum + frame.bytes, 0),
  );

  const reloadFrames = frames.length;
  const reloaded = Date.now();
  await page.reload();
  await mirrorShows(page, "perf-done");
  record("reload → large page shown", Date.now() - reloaded);
  await inputReady(page);
  record("reload → input ready", Date.now() - reloaded);
  record(
    "reload WS bytes",
    frames.slice(reloadFrames).reduce((sum, frame) => sum + frame.bytes, 0),
  );

  // The same profile from another page while its browser runs.
  const second = await newPage(context);
  await second.page.goto(`${origin}/?new=1`);
  await second.page.locator("button.profile-card").first().waitFor();
  const warmPicked = Date.now();
  const [warm] = await Promise.all([
    second.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/client/session",
      { timeout: 90_000 },
    ),
    second.page
      .locator("button.profile-card")
      .filter({ hasText: `perf-load-${run}` })
      .click(),
  ]);
  record("pick → session answered (warm)", Date.now() - warmPicked);
  for (const [name, ms] of Object.entries(serverTiming(await warm.headerValue("server-timing"))))
    record(`  warm server: ${name}`, ms);
  await inputReady(second.page);
  record("pick → input ready (warm)", Date.now() - warmPicked);

  for (const target of [second.page, page]) {
    const sid = new URL(target.url()).searchParams.get("sid");
    if (sid) await call(target, "DELETE", `/api/client/session/${sid}`);
  }

  // The same profile once its browser has closed: the exit it had is known from last time.
  if (closeBrowser) {
    execSync(closeBrowser.replaceAll("{id}", made.id), { stdio: "inherit" });
    const deadline = Date.now() + 30_000;
    const running = async () =>
      (await call(page, "GET", "/api/accounts")).json.accounts.find(
        (account) => account.id === made.id,
      )?.running;
    while ((await running()) && Date.now() < deadline) await page.waitForTimeout(200);
    assert.ok(!(await running()), "The profile's browser did not close");
    const again = await newPage(context);
    await again.page.goto(`${origin}/?new=1`);
    await pickCold(again.page, again.frames, `perf-load-${run}`, "cold, known exit");
    const sid = new URL(again.page.url()).searchParams.get("sid");
    if (sid) await call(again.page, "DELETE", `/api/client/session/${sid}`);
  }
  const removed = await call(page, "DELETE", `/api/accounts/${made.id}`);
  assert.ok(removed.status < 300, `Deleting the profile failed: ${removed.status}`);
  await context.close();
}

try {
  for (let run = 0; run < runs; run++) {
    const started = Date.now();
    await coldRun(run);
    console.log(`run ${run + 1}/${runs} took ${Date.now() - started} ms`);
  }
  console.log(`\nMedians over ${runs} runs, network ${network}:`);
  for (const [name, values] of Object.entries(samples))
    console.log(
      `  ${name.padEnd(42)} ${String(Math.round(median(values))).padStart(9)}   [${values.map((value) => Math.round(value)).join(", ")}]`,
    );
  if (process.env.PERF_JSON)
    await writeFile(process.env.PERF_JSON, JSON.stringify({ network, samples }, null, 2));
} finally {
  await browser.close();
}
