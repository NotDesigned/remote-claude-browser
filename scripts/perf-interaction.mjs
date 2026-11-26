/**
 * Interaction and reconnection measurements against a running gateway with a real remote Chromium
 * (scripts/perf-stack.sh starts one). The viewer is a local Playwright Chromium that reaches the
 * gateway through a shaping TCP proxy in this process, so the network can be slowed, cut with a
 * reset, or silently black-holed the way a phone's is when it moves between Wi-Fi and 4G.
 *
 *   eval "$(PERF_PROJECT=pu-perf bash scripts/perf-stack.sh up | tail -1 | sed 's/^/export /')"
 *   CHROME_PATH=... node scripts/perf-interaction.mjs [scenario ...]
 *
 * Scenarios (default: all but `sleep` and `long`): typing, burst, click, wheel, touch, stream,
 * stream-phone, tabs, views, reset, blackhole, offline, hidden, offline-typing, rtt, sleep, long.
 * PERF_SLEEP_MINUTES (default 5) sets how long `sleep` keeps the page in the background, with the
 * remote page streaming meanwhile. Results are printed as JSON lines and as a table at the end;
 * PERF_OUT writes the JSON to a file.
 *
 * Times come from Date.now() on this host: the remote browser runs in a container on the same
 * kernel clock. "remote" is when the remote page saw the input, "screen" when the mirrored change
 * was first seen in an animation frame of the viewer.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { chromium } from "playwright";

const env = process.env;
const publicOrigin = env.SMOKE_ORIGIN;
const gateway = new URL(env.PERF_GATEWAY ?? "");
const fixtureOrigin = env.SMOKE_FIXTURE_ORIGIN;
const username = env.SMOKE_USERNAME;
const password = env.SMOKE_PASSWORD;
assert.ok(publicOrigin && fixtureOrigin && username && password, "Run scripts/perf-stack.sh first");
const chromePath = env.CHROME_PATH ?? env.CLAUDE_TEST_CHROME;
assert.ok(chromePath, "Set CHROME_PATH");

const results = [];
const record = (scenario, values) => {
  const row = { scenario, ...values };
  results.push(row);
  console.log(JSON.stringify(row));
};
const stats = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0 };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// The shaping proxy between the viewer and the gateway.

const net = {
  /** Added to each chunk, each way. */
  delayMs: 0,
  /** Random extra delay up to this, each way: a lossy link's retransmissions. */
  jitterMs: 0,
  /** New connections are refused (the device is offline). */
  refuse: false,
};
const links = new Set();
const proxy = createServer((client) => {
  if (net.refuse) {
    client.destroy();
    return;
  }
  const upstream = createConnection({ host: gateway.hostname, port: Number(gateway.port) });
  const link = { client, upstream, dead: false };
  links.add(link);
  const forward = (from, to) => {
    let last = 0;
    from.on("data", (chunk) => {
      if (link.dead) return;
      const wait = net.delayMs + (net.jitterMs ? Math.random() * net.jitterMs : 0);
      if (wait === 0 && last <= Date.now()) {
        to.write(chunk);
        return;
      }
      // In order: a chunk never overtakes the one before it.
      const due = Math.max(Date.now() + wait, last);
      last = due;
      setTimeout(() => {
        if (!link.dead && !to.destroyed) to.write(chunk);
      }, due - Date.now());
    });
  };
  forward(client, upstream);
  forward(upstream, client);
  const close = () => {
    links.delete(link);
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close).on("close", close);
  upstream.on("error", close).on("close", close);
});
/** Every open connection stops carrying anything, without a word to either end. */
const blackhole = () => {
  for (const link of links) link.dead = true;
};
/** Every open connection is reset. */
const resetAll = () => {
  for (const link of links) {
    link.client.resetAndDestroy?.() ?? link.client.destroy();
    link.upstream.destroy();
  }
};
const publicUrl = new URL(publicOrigin);
await new Promise((resolve, reject) =>
  proxy.once("error", reject).listen(Number(publicUrl.port), publicUrl.hostname, resolve),
);

// ---------------------------------------------------------------------------------------------
// The remote page: a long conversation, a composer, and a reply that streams in.

const fixturePage = (html) => `${fixtureOrigin}/?html=${Buffer.from(html).toString("base64url")}`;
const words =
  "the mirror keeps a remote page in step with this one while the reply streams in token by token and the reader scrolls back through a long conversation".split(
    " ",
  );
const paragraph = (n, seed) =>
  Array.from({ length: n }, (_, i) => words[(i * 7 + seed) % words.length]).join(" ");
const thread = Array.from(
  { length: 120 },
  (_, i) =>
    `<div class="msg ${i % 2 ? "ai" : "me"}"><p>${paragraph(60, i)}</p>${i % 2 ? `<p>${paragraph(40, i + 3)}</p><pre><code>${paragraph(12, i)}</code></pre>` : ""}</div>`,
).join("");
const CHAT_PAGE = `<!doctype html><meta charset="utf-8"><title>Perf chat</title>
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif}
#thread{padding:40px 16px 160px;max-width:760px;margin:auto}
.msg{margin:14px 0}.me{background:#eef;padding:4px 10px;border-radius:8px}
pre{background:#f4f4f4;padding:8px;overflow:auto}
#bar{position:fixed;bottom:0;left:0;right:0;background:#ddd;padding:8px;display:flex;gap:6px}
#composer{flex:1;min-height:40px;max-height:120px;overflow:auto;border:1px solid #888;padding:6px;background:#fff}
#hud{position:fixed;top:0;left:0;background:#ffe;font:12px monospace;z-index:2}
button{font-size:16px;min-width:64px;min-height:40px}
</style>
<div id="hud"><span id="echo">0@0</span> <span id="clicks">0@0</span> <span id="scrolled">0@0</span> <span id="tick">0@0</span></div>
<div id="thread">${thread}</div>
<div id="bar"><div id="composer" contenteditable="true" role="textbox"><p><br></p></div>
<button id="press">Press</button><button id="stream">Stream</button></div>
<script>
const $ = (id) => document.getElementById(id);
const stamp = (id, value) => ($(id).textContent = value + "@" + Date.now());
$("composer").addEventListener("input", () => stamp("echo", $("composer").textContent.length));
let clicks = 0;
$("press").addEventListener("click", () => stamp("clicks", ++clicks));
addEventListener("scroll", () => stamp("scrolled", Math.round(scrollY)), { passive: true });
const words = ${JSON.stringify(words)};
let streaming = null;
$("stream").addEventListener("click", () => {
  clearInterval(streaming);
  const seconds = Number(location.hash.match(/stream=(\\d+)/)?.[1] ?? 20);
  const msg = document.createElement("div");
  msg.className = "msg ai";
  $("thread").append(msg);
  let p = null, i = 0;
  const end = Date.now() + seconds * 1000;
  streaming = setInterval(() => {
    if (Date.now() > end) return clearInterval(streaming);
    if (i % 40 === 0) { p = document.createElement(i % 400 === 360 ? "pre" : "p"); msg.append(p); }
    for (let k = 0; k < 3; k++) p.append((i ? " " : "") + words[(i + k) % words.length]);
    i += 3;
    stamp("tick", i);
    if (innerHeight + scrollY > document.body.scrollHeight - 400) scrollTo(0, document.body.scrollHeight);
  }, 30);
});
</script>`;
const OTHER_PAGE = `<!doctype html><meta charset="utf-8"><title>Other tab</title><style>body{font:16px sans-serif}</style>
<h1 id="other">Other tab</h1>${Array.from({ length: 200 }, (_, i) => `<p>${paragraph(30, i)}</p>`).join("")}`;

// ---------------------------------------------------------------------------------------------
// The viewer, with a recorder of what it shows.

/** Runs in the viewer page: notes what the shell and the mirror show, frame by frame. */
function installRecorder() {
  const perf = {
    status: [],
    ready: [],
    seen: { echo: [], clicks: [], scrolled: [], tick: [], composer: [] },
    frames: null,
    longtasks: [],
    rebuilds: 0,
    stages: 0,
    localScroll: [],
  };
  window.__perf = perf;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        perf.longtasks.push({ at: performance.timeOrigin + entry.startTime, ms: entry.duration });
    }).observe({ type: "longtask", buffered: false });
  } catch {}
  let lastStatus = "";
  let lastReady = "";
  let lastFrame = null;
  let lastDoc = null;
  let lastScroll = null;
  const last = {};
  const frameTimes = [];
  const loop = (timestamp) => {
    const now = Date.now();
    const status = document.querySelector("#shell-status .shell-status-text")?.textContent ?? "";
    if (status !== lastStatus) perf.status.push({ at: now, text: (lastStatus = status) });
    const host = document.getElementById("mirror-host");
    const ready = host?.dataset.inputReady ?? "";
    if (ready !== lastReady) perf.ready.push({ at: now, ready: (lastReady = ready) });
    const frame = host?.querySelector(".mirror-stage:not([data-parked]) iframe") ?? null;
    if (frame !== lastFrame) {
      lastFrame = frame;
      perf.stages++;
    }
    const doc = frame?.contentDocument ?? null;
    if (doc !== null && doc !== lastDoc && doc.getElementById("hud")) {
      if (lastDoc !== null) perf.rebuilds++;
      lastDoc = doc;
    }
    if (doc) {
      for (const id of ["echo", "clicks", "scrolled", "tick"]) {
        const text = doc.getElementById(id)?.textContent;
        if (text !== undefined && text !== last[id]) {
          last[id] = text;
          perf.seen[id].push({ at: now, text });
        }
      }
      const composer = doc.getElementById("composer")?.textContent;
      if (composer !== undefined && composer !== last.composer) {
        last.composer = composer;
        perf.seen.composer.push({ at: now, text: composer });
      }
      const y = Math.round(doc.defaultView?.scrollY ?? 0);
      if (y !== lastScroll) {
        lastScroll = y;
        perf.localScroll.push({ at: now, y });
      }
    }
    if (perf.frames !== null && lastFrameTs !== null) frameTimes.push(timestamp - lastFrameTs);
    lastFrameTs = timestamp;
    requestAnimationFrame(loop);
  };
  let lastFrameTs = null;
  perf.startFrames = () => {
    frameTimes.length = 0;
    perf.frames = frameTimes;
    perf.longtasks.length = 0;
  };
  perf.stopFrames = () => {
    const out = frameTimes.slice();
    perf.frames = null;
    return out;
  };
  requestAnimationFrame(loop);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });

async function openViewer({ phone = false } = {}) {
  const context = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 760 },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          userAgent:
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        }
      : { viewport: { width: 1280, height: 900 } },
  );
  await context.addInitScript(() => {
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
  });
  await context.addInitScript(installRecorder);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(publicOrigin);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.locator("button.profile-card").filter({ hasText: "默认账号" }).click();
  await page.waitForSelector("#shell-bar", { timeout: 60_000 });
  await page
    .locator('#urlbar button[aria-label="Reload"]:not([disabled])')
    .waitFor({ timeout: 60_000 });
  return { context, page, cdp, address: page.locator("#urlbar input") };
}

const MIRROR_FRAME = "#mirror-host .mirror-stage:not([data-parked]) iframe";

/** Where an element of the mirror is on the viewer's page. */
async function mirrorPoint(page, id) {
  const handle = await page.waitForFunction(
    ({ id, selector }) => {
      const frame = document.querySelector(selector);
      const doc = frame?.contentDocument;
      const node = doc?.getElementById(id);
      if (!node || document.getElementById("mirror-host")?.dataset.inputReady !== "true")
        return null;
      const box = frame.getBoundingClientRect();
      const sx = box.width / frame.offsetWidth;
      const sy = box.height / frame.offsetHeight;
      const rect = node.getBoundingClientRect();
      return {
        x: box.left + frame.clientLeft * sx + (rect.left + rect.width / 2) * sx,
        y: box.top + frame.clientTop * sy + (rect.top + Math.min(rect.height / 2, 20)) * sy,
      };
    },
    { id, selector: MIRROR_FRAME },
    { timeout: 30_000 },
  );
  return handle.jsonValue();
}

const ready = (page, timeout = 120_000) =>
  page.waitForFunction(
    (selector) =>
      document.getElementById("mirror-host")?.dataset.inputReady === "true" &&
      document.querySelector(selector)?.contentDocument?.getElementById("hud") !== null &&
      document.querySelector(selector)?.contentDocument?.getElementById("hud") !== undefined,
    MIRROR_FRAME,
    { timeout, polling: 50 },
  );

async function openChat(viewer, hash = "") {
  await viewer.address.fill(fixturePage(CHAT_PAGE) + hash);
  await viewer.address.press("Enter");
  await ready(viewer.page);
  await viewer.page.waitForTimeout(500);
}

const perfState = (page) => page.evaluate(() => ({ ...window.__perf, frames: undefined }));
const parseStamp = (text) => {
  const [value, at] = text.split("@");
  return { value: Number(value), at: Number(at) };
};
/** For each value seen in a stamped element: when the remote page set it and when it showed. */
async function stampTimes(page, id) {
  const { seen } = await perfState(page);
  const out = new Map();
  for (const entry of seen[id]) {
    const { value, at } = parseStamp(entry.text);
    if (!out.has(value)) out.set(value, { remote: at, screen: entry.at });
  }
  return out;
}

async function focusComposer(viewer) {
  const point = await mirrorPoint(viewer.page, "composer");
  await viewer.page.mouse.click(point.x, point.y);
  await viewer.page.waitForTimeout(400);
}

async function clearComposer(viewer) {
  await viewer.page.keyboard.press("Control+a");
  await viewer.page.keyboard.press("Backspace");
  await viewer.page.waitForTimeout(600);
}

/** The remote composer's text, as the remote page last stamped its length, and as mirrored. */
async function composerText(page) {
  return page.evaluate(
    (selector) =>
      document.querySelector(selector)?.contentDocument?.getElementById("composer")?.textContent ??
      null,
    MIRROR_FRAME,
  );
}

async function typingLatency(viewer, { label = "typing", keys = 30, gapMs = 150 } = {}) {
  await focusComposer(viewer);
  await clearComposer(viewer);
  const base = (await composerText(viewer.page))?.length ?? 0;
  const sent = [];
  const local = [];
  for (let i = 0; i < keys; i++) {
    const key = "abcdefghij"[i % 10];
    const before = Date.now();
    await viewer.page.keyboard.type(key);
    sent.push(before);
    // The mirror's own field shows the key at once, before the page answers.
    local.push(
      await viewer.page.evaluate(
        ({ selector, length }) =>
          new Promise((resolve) => {
            const check = () => {
              const text = document
                .querySelector(selector)
                ?.contentDocument?.getElementById("composer")?.textContent;
              if ((text?.length ?? 0) >= length) resolve(Date.now());
              else requestAnimationFrame(check);
            };
            check();
            setTimeout(() => resolve(NaN), 2000);
          }),
        { selector: MIRROR_FRAME, length: base + i + 1 },
      ),
    );
    await sleep(gapMs);
  }
  await sleep(2000);
  const times = await stampTimes(viewer.page, "echo");
  const toRemote = [];
  const toScreen = [];
  const localEcho = [];
  for (let i = 0; i < keys; i++) {
    const hit = times.get(base + i + 1);
    localEcho.push(local[i] - sent[i]);
    if (!hit) continue;
    toRemote.push(hit.remote - sent[i]);
    toScreen.push(hit.screen - hit.remote);
  }
  record(label, {
    localEchoMs: stats(localEcho),
    keyToRemoteMs: stats(toRemote),
    remoteToScreenMs: stats(toScreen),
    roundTripMs: stats(toRemote.map((value, i) => value + toScreen[i])),
    missing: keys - toRemote.length,
  });
}

async function burstTyping(
  viewer,
  {
    label = "burst",
    text = "The quick brown fox jumps over the lazy dog 0123456789",
    delay = 25,
  } = {},
) {
  await focusComposer(viewer);
  await clearComposer(viewer);
  const start = Date.now();
  await viewer.page.keyboard.type(text, { delay });
  const typedAt = Date.now();
  const deadline = Date.now() + 15_000;
  let times;
  while (Date.now() < deadline) {
    times = await stampTimes(viewer.page, "echo");
    if (times.has(text.length)) break;
    await sleep(100);
  }
  await sleep(1500);
  const mirrored = await composerText(viewer.page);
  const settled = times.get(text.length);
  record(label, {
    chars: text.length,
    typingMs: typedAt - start,
    lastKeyToRemoteMs: settled ? settled.remote - typedAt : null,
    lastKeyToScreenMs: settled ? settled.screen - typedAt : null,
    remoteMatches: mirrored === text,
    mirrored: mirrored === text ? undefined : mirrored,
  });
}

async function clickLatency(viewer, { label = "click", presses = 10 } = {}) {
  const point = await mirrorPoint(viewer.page, "press");
  const sent = [];
  const before = await stampTimes(viewer.page, "clicks");
  const first = Math.max(0, ...before.keys());
  for (let i = 0; i < presses; i++) {
    sent.push(Date.now());
    await viewer.page.mouse.click(point.x, point.y);
    await sleep(400);
  }
  await sleep(1500);
  const times = await stampTimes(viewer.page, "clicks");
  const toRemote = [];
  const toScreen = [];
  for (let i = 0; i < presses; i++) {
    const hit = times.get(first + i + 1);
    if (!hit) continue;
    toRemote.push(hit.remote - sent[i]);
    toScreen.push(hit.screen - hit.remote);
  }
  record(label, {
    clickToRemoteMs: stats(toRemote),
    remoteToScreenMs: stats(toScreen),
    missing: presses - toRemote.length,
  });
}

async function wheelLatency(viewer, { label = "wheel", steps = 12 } = {}) {
  const point = await mirrorPoint(viewer.page, "thread");
  await viewer.page.mouse.move(point.x, point.y + 200);
  const toRemote = [];
  const toScreen = [];
  const toLocal = [];
  for (let i = 0; i < steps; i++) {
    const { seen, localScroll } = await perfState(viewer.page);
    const remoteCount = seen.scrolled.length;
    const localCount = localScroll.length;
    const sent = Date.now();
    await viewer.page.mouse.wheel(0, i % 4 === 3 ? -300 : 200);
    await sleep(700);
    const after = await perfState(viewer.page);
    const firstRemote = after.seen.scrolled[remoteCount];
    const firstLocal = after.localScroll[localCount];
    if (firstLocal) toLocal.push(firstLocal.at - sent);
    if (firstRemote) {
      const stamp = parseStamp(firstRemote.text);
      toRemote.push(stamp.at - sent);
      toScreen.push(firstRemote.at - stamp.at);
    }
  }
  record(label, {
    wheelToLocalScrollMs: stats(toLocal),
    wheelToRemoteMs: stats(toRemote),
    remoteToScreenMs: stats(toScreen),
  });
}

async function touchScroll(viewer, { label = "touch", swipes = 8 } = {}) {
  const point = await mirrorPoint(viewer.page, "thread");
  const toRemote = [];
  const toLocal = [];
  const settle = [];
  for (let i = 0; i < swipes; i++) {
    const { seen, localScroll } = await perfState(viewer.page);
    const remoteCount = seen.scrolled.length;
    const localCount = localScroll.length;
    const sent = Date.now();
    const distance = i % 3 === 2 ? -250 : 250;
    await viewer.cdp.send("Input.synthesizeScrollGesture", {
      x: Math.round(point.x),
      y: Math.round(Math.min(point.y + 150, 600)),
      yDistance: -distance,
      speed: 1200,
      gestureSourceType: "touch",
      repeatCount: 1,
    });
    const gestureDone = Date.now();
    await sleep(900);
    const after = await perfState(viewer.page);
    const firstRemote = after.seen.scrolled[remoteCount];
    const firstLocal = after.localScroll[localCount];
    if (firstLocal) toLocal.push(firstLocal.at - sent);
    if (firstRemote) toRemote.push(parseStamp(firstRemote.text).at - sent);
    const lastRemote = after.seen.scrolled.at(-1);
    if (after.seen.scrolled.length > remoteCount && lastRemote)
      settle.push(lastRemote.at - gestureDone);
  }
  record(label, {
    swipeToLocalScrollMs: stats(toLocal),
    swipeToRemoteMs: stats(toRemote),
    gestureEndToLastMirroredMs: stats(settle),
    swipesWithRemoteScroll: toRemote.length,
    swipes,
  });
}

async function streaming(viewer, { label = "stream", seconds = 20, throttle = 1 } = {}) {
  await openChat(viewer, `#stream=${seconds}`);
  if (throttle > 1) await viewer.cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await viewer.cdp.send("Performance.enable");
  const before = await viewer.cdp.send("Performance.getMetrics");
  await viewer.page.evaluate(() => window.__perf.startFrames());
  const point = await mirrorPoint(viewer.page, "stream");
  await viewer.page.mouse.click(point.x, point.y);
  await sleep(seconds * 1000 + 3000);
  const frames = await viewer.page.evaluate(() => window.__perf.stopFrames());
  const after = await viewer.cdp.send("Performance.getMetrics");
  if (throttle > 1) await viewer.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const metric = (set, name) => set.metrics.find((m) => m.name === name)?.value ?? 0;
  const { longtasks, seen } = await perfState(viewer.page);
  const lag = [];
  for (const entry of seen.tick) {
    const stamp = parseStamp(entry.text);
    if (stamp.value > 0) lag.push(entry.at - stamp.at);
  }
  const ticks = seen.tick.map((entry) => parseStamp(entry.text).value);
  record(label, {
    throttle,
    frameMs: stats(frames),
    framesOver50ms: frames.filter((ms) => ms > 50).length,
    frames: frames.length,
    longTasks: longtasks.length,
    longTaskMsTotal: Math.round(longtasks.reduce((sum, task) => sum + task.ms, 0)),
    longTaskMaxMs: Math.round(Math.max(0, ...longtasks.map((task) => task.ms))),
    remoteToScreenLagMs: stats(lag),
    mirroredUpdates: ticks.length,
    lastTick: ticks.at(-1),
    taskSeconds: +(metric(after, "TaskDuration") - metric(before, "TaskDuration")).toFixed(2),
    scriptSeconds: +(metric(after, "ScriptDuration") - metric(before, "ScriptDuration")).toFixed(2),
    layoutSeconds: +(metric(after, "LayoutDuration") - metric(before, "LayoutDuration")).toFixed(2),
    heapMB: +(metric(after, "JSHeapUsedSize") / 1e6).toFixed(1),
    domNodes: metric(after, "Nodes"),
  });
}

async function tabSwitch(viewer, { label = "tabs", rounds = 4 } = {}) {
  const tabs = viewer.page.locator('#tabstrip [role="tab"]');
  const count = await tabs.count();
  if (count < 2) {
    await viewer.page.locator("#new-tab").click();
    await viewer.page.waitForFunction(
      () => document.querySelectorAll('#tabstrip [role="tab"]').length >= 2,
    );
    await viewer.page.waitForFunction(
      () =>
        document.querySelector('#tabstrip [role="tab"][aria-selected="true"]') ===
        document.querySelectorAll('#tabstrip [role="tab"]')[1],
    );
    await viewer.page.locator('#urlbar button[aria-label="Reload"]:not([disabled])').waitFor();
    await viewer.address.fill(fixturePage(OTHER_PAGE));
    await viewer.address.press("Enter");
    await viewer.page.waitForFunction(
      (selector) => document.querySelector(selector)?.contentDocument?.getElementById("other"),
      MIRROR_FRAME,
      { timeout: 60_000 },
    );
  }
  const visible = [];
  const usable = [];
  for (let i = 0; i < rounds * 2; i++) {
    const target = i % 2 === 0 ? 0 : 1;
    const marker = target === 0 ? "hud" : "other";
    const start = Date.now();
    await tabs.nth(target).click();
    const shown = await viewer.page.waitForFunction(
      ({ selector, marker }) =>
        document.querySelector(selector)?.contentDocument?.getElementById(marker)
          ? Date.now()
          : null,
      { selector: MIRROR_FRAME, marker },
      { timeout: 60_000, polling: "raf" },
    );
    visible.push((await shown.jsonValue()) - start);
    const inputOk = await viewer.page.waitForFunction(
      () =>
        document.getElementById("mirror-host")?.dataset.inputReady === "true" ? Date.now() : null,
      undefined,
      { timeout: 60_000, polling: "raf" },
    );
    usable.push((await inputOk.jsonValue()) - start);
    await sleep(800);
  }
  record(label, { contentVisibleMs: stats(visible), inputReadyMs: stats(usable) });
  await tabs.nth(0).click();
  await ready(viewer.page);
}

async function viewSwitch(viewer, { label = "views", rounds = 3 } = {}) {
  const toPicture = [];
  const toPage = [];
  for (let i = 0; i < rounds; i++) {
    let start = Date.now();
    await viewer.page.locator('[data-view-mode="px"]').click();
    const painted = await viewer.page.waitForFunction(
      () => (document.querySelector(".px-canvas")?.width > 0 ? Date.now() : null),
      undefined,
      { timeout: 60_000, polling: "raf" },
    );
    toPicture.push((await painted.jsonValue()) - start);
    await sleep(1500);
    start = Date.now();
    await viewer.page.locator('[data-view-mode="dom"]').click();
    const back = await viewer.page.waitForFunction(
      (selector) =>
        document.getElementById("mirror-host")?.dataset.inputReady === "true" &&
        document.querySelector(selector)?.contentDocument?.getElementById("hud")
          ? Date.now()
          : null,
      MIRROR_FRAME,
      { timeout: 60_000, polling: "raf" },
    );
    toPage.push((await back.jsonValue()) - start);
    await sleep(1500);
  }
  record(label, { pageToPictureMs: stats(toPicture), pictureToPageMs: stats(toPage) });
}

/** Status pill texts from `since` on, with times relative to it. */
async function statusTrail(page, since) {
  const { status, ready: readiness } = await perfState(page);
  return {
    status: status.filter((s) => s.at >= since).map((s) => `${s.at - since}:${s.text}`),
    ready: readiness.filter((r) => r.at >= since).map((r) => `${r.at - since}:${r.ready}`),
  };
}

/** Waits until the page is usable again, and says how it got there. */
async function recovery(viewer, since, timeout = 180_000) {
  const before = await perfState(viewer.page);
  await viewer.page.waitForFunction(
    () => document.querySelector("#shell-status .shell-status-text")?.textContent === "已连接",
    undefined,
    { timeout, polling: 50 },
  );
  await ready(viewer.page, timeout);
  const usableAt = Date.now();
  await sleep(300);
  const after = await perfState(viewer.page);
  const trail = await statusTrail(viewer.page, since);
  const firstNotOk = after.status.find((s) => s.at >= since && s.text !== "已连接");
  return {
    usableMs: usableAt - since,
    statusChangedAfterMs: firstNotOk ? firstNotOk.at - since : null,
    rebuilt: after.rebuilds > before.rebuilds || after.stages > before.stages,
    ...trail,
  };
}

async function waitNoticed(viewer, since, timeout) {
  try {
    await viewer.page.waitForFunction(
      () => document.querySelector("#shell-status .shell-status-text")?.textContent !== "已连接",
      undefined,
      { timeout, polling: 50 },
    );
    return Date.now() - since;
  } catch {
    return null;
  }
}

async function cutReset(viewer, { label = "reset" } = {}) {
  await ready(viewer.page);
  const since = Date.now();
  resetAll();
  record(label, await recovery(viewer, since));
}

async function cutBlackhole(viewer, { label = "blackhole", typeWhileCut = false } = {}) {
  await ready(viewer.page);
  let typed = null;
  if (typeWhileCut) {
    await focusComposer(viewer);
    await clearComposer(viewer);
  }
  const since = Date.now();
  blackhole();
  if (typeWhileCut) {
    await sleep(1000);
    typed = "lost?";
    await viewer.page.keyboard.type(typed, { delay: 60 });
  }
  const noticedMs = await waitNoticed(viewer, since, 60_000);
  const result = await recovery(viewer, since);
  let composer;
  if (typeWhileCut) {
    await sleep(3000);
    composer = await composerText(viewer.page);
  }
  record(label, {
    noticedMs,
    ...result,
    ...(typeWhileCut ? { typed, remoteComposer: composer } : {}),
  });
}

async function cutOffline(viewer, { label = "offline", seconds = 10, typeWhileCut = false } = {}) {
  await ready(viewer.page);
  if (typeWhileCut) {
    await focusComposer(viewer);
    await clearComposer(viewer);
  }
  const since = Date.now();
  net.refuse = true;
  blackhole();
  await viewer.context.setOffline(true);
  const noticedMs = await waitNoticed(viewer, since, 60_000);
  let typed;
  if (typeWhileCut) {
    typed = "offline";
    await viewer.page.keyboard.type(typed, { delay: 60 });
  }
  await sleep(Math.max(0, seconds * 1000 - (Date.now() - since)));
  const restoredAt = Date.now();
  net.refuse = false;
  await viewer.context.setOffline(false);
  const result = await recovery(viewer, restoredAt);
  let composer;
  if (typeWhileCut) {
    await sleep(3000);
    composer = await composerText(viewer.page);
  }
  record(label, {
    offlineSeconds: seconds,
    noticedMs,
    ...result,
    ...(typeWhileCut ? { typed, remoteComposer: composer } : {}),
  });
}

const setHidden = (page, hidden) =>
  page.evaluate((hidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

async function hiddenFor(viewer, { label = "hidden", seconds = 30, streamSeconds = 0 } = {}) {
  await ready(viewer.page);
  if (streamSeconds > 0) {
    await openChat(viewer, `#stream=${streamSeconds}`);
    const point = await mirrorPoint(viewer.page, "stream");
    await viewer.page.mouse.click(point.x, point.y);
    await sleep(500);
  }
  await setHidden(viewer.page, true);
  await sleep(seconds * 1000);
  const since = Date.now();
  await setHidden(viewer.page, false);
  record(label, {
    hiddenSeconds: seconds,
    streamedSeconds: streamSeconds,
    ...(await recovery(viewer, since)),
  });
}

async function highRtt(viewer, { label = "rtt", delayMs = 150, jitterMs = 0 } = {}) {
  net.delayMs = delayMs;
  net.jitterMs = jitterMs;
  // Only new connections carry the delay at once; force one so that the socket is shaped.
  resetAll();
  await recovery(viewer, Date.now());
  await typingLatency(viewer, { label: `${label}-typing`, keys: 20, gapMs: 250 });
  await burstTyping(viewer, { label: `${label}-burst` });
  await clickLatency(viewer, { label: `${label}-click`, presses: 6 });
  net.delayMs = 0;
  net.jitterMs = 0;
  resetAll();
  await recovery(viewer, Date.now());
}

async function longSession(viewer, { label = "long", minutes = 5 } = {}) {
  await viewer.cdp.send("Performance.enable");
  const heap = [];
  const end = Date.now() + minutes * 60_000;
  await openChat(viewer, "#stream=50");
  while (Date.now() < end) {
    const point = await mirrorPoint(viewer.page, "stream");
    await viewer.page.mouse.click(point.x, point.y);
    await sleep(55_000);
    const metrics = await viewer.cdp.send("Performance.getMetrics");
    const value = (name) => metrics.metrics.find((m) => m.name === name)?.value ?? 0;
    heap.push({ heapMB: +(value("JSHeapUsedSize") / 1e6).toFixed(1), nodes: value("Nodes") });
  }
  record(label, { minutes, samples: heap });
}

// ---------------------------------------------------------------------------------------------

const all = [
  "typing",
  "burst",
  "click",
  "wheel",
  "stream",
  "tabs",
  "views",
  "reset",
  "blackhole",
  "offline",
  "offline-typing",
  "hidden",
  "rtt",
  "touch",
  "stream-phone",
];
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : all;
try {
  const desk = await openViewer();
  await openChat(desk);
  for (const scenario of wanted) {
    try {
      switch (scenario) {
        case "typing":
          await typingLatency(desk);
          break;
        case "burst":
          await burstTyping(desk);
          break;
        case "click":
          await clickLatency(desk);
          break;
        case "wheel":
          await wheelLatency(desk);
          break;
        case "stream":
          await streaming(desk);
          await openChat(desk);
          break;
        case "tabs":
          await tabSwitch(desk);
          break;
        case "views":
          await viewSwitch(desk);
          break;
        case "reset":
          await cutReset(desk);
          break;
        case "blackhole":
          await cutBlackhole(desk);
          break;
        case "blackhole-typing":
          await cutBlackhole(desk, { label: "blackhole-typing", typeWhileCut: true });
          break;
        case "offline":
          await cutOffline(desk);
          break;
        case "offline-typing":
          await cutOffline(desk, { label: "offline-typing", typeWhileCut: true });
          break;
        case "hidden":
          await hiddenFor(desk, { seconds: 30 });
          await hiddenFor(desk, { label: "hidden-streaming", seconds: 30, streamSeconds: 25 });
          await openChat(desk);
          break;
        case "sleep": {
          const minutes = Number(env.PERF_SLEEP_MINUTES ?? 5);
          await hiddenFor(desk, {
            label: `sleep-${minutes}min`,
            seconds: minutes * 60,
            streamSeconds: Math.min(minutes * 60, 120),
          });
          await openChat(desk);
          break;
        }
        case "rtt":
          await highRtt(desk, { label: "rtt150" });
          await highRtt(desk, { label: "lossy", delayMs: 80, jitterMs: 400 });
          break;
        case "long":
          await longSession(desk, { minutes: Number(env.PERF_LONG_MINUTES ?? 5) });
          await openChat(desk);
          break;
        case "touch":
        case "stream-phone": {
          // A second device takes the session over; the desktop page is done after this.
          await desk.context.close();
          const phone = await openViewer({ phone: true });
          await openChat(phone);
          await touchScroll(phone);
          await typingLatency(phone, { label: "phone-typing", keys: 15 });
          await streaming(phone, { label: "stream-phone4x", throttle: 4 });
          await phone.context.close();
          wanted.length = 0;
          break;
        }
        default:
          throw new Error(`Unknown scenario ${scenario}`);
      }
    } catch (error) {
      record(scenario, { error: String(error?.message ?? error).split("\n")[0] });
      net.refuse = false;
      net.delayMs = 0;
      net.jitterMs = 0;
    }
  }
} finally {
  await browser.close();
  proxy.close();
  for (const link of links) {
    link.client.destroy();
    link.upstream.destroy();
  }
}
if (env.PERF_OUT) await writeFile(env.PERF_OUT, JSON.stringify(results, null, 2));
console.log("\nscenario | results");
for (const row of results) {
  const { scenario, ...rest } = row;
  console.log(`${scenario} | ${JSON.stringify(rest)}`);
}
process.exit(0);
