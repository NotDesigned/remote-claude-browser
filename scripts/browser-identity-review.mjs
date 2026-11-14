/** Independent review against a loopback-only E2E gateway; never accepts a production origin. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws");
const [sessionFile, expectedMode, outputFile] = process.argv.slice(2);
assert(
  sessionFile && ["dom", "native"].includes(expectedMode) && outputFile,
  "Usage: node scripts/browser-identity-review.mjs <session.json> dom|native <report.json>",
);
const { base } = JSON.parse(await readFile(sessionFile, "utf8"));
const origin = new URL(base);
assert(
  origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname),
  "Review requires an isolated loopback E2E origin",
);
const owner = "fingerprint-review";
const headers = { "Content-Type": "application/json", "x-mirror-e2e-owner": owner };
const acquired = await fetch(base + "/api/client/session", {
  method: "POST",
  headers,
  body: JSON.stringify({ clientKey: "fingerprint-review-" + expectedMode }),
});
assert.equal(acquired.status, 200, "Could not acquire review workspace");
const session = await acquired.json();
async function evaluate(expression) {
  const r = await fetch(base + "/__e2e/evaluate", {
    method: "POST",
    headers,
    body: JSON.stringify({ sid: session.sid, expression }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(r.status, 200, "Fixture evaluation failed");
  return (await r.json()).value;
}
assert.equal((await fetch(base + "/__e2e/probe")).status, 200, "E2E gateway required");
const url = new URL("/ws", origin);
url.protocol = "ws:";
url.searchParams.set("sid", session.sid);
url.searchParams.set("e2e-owner", owner);
url.searchParams.set("connectionKey", randomUUID());
const socket = new WebSocket(url);
let activeTab;
let frames = 0;
let viewportEpoch;
let nativeAdvertised = false;
let pixelStartupRetried = false;
const setup = new Set();
const modes = [];
const send = (message) => socket.send(JSON.stringify(message));
socket.on("message", (bytes, binary) => {
  if (binary) {
    frames++;
    return;
  }
  const message = JSON.parse(bytes.toString());
  if (message.t === "px" || message.t === "vid") frames++;
  if (message.t === "mode") {
    modes.push(message.mode);
    nativeAdvertised ||= message.native === true;
  }
  if (message.t === "snapshot") {
    if (message.reason === "viewport") viewportEpoch = message.epoch;
    send({ t: "view-ack", tab: message.tab, epoch: message.epoch });
  }
  if (message.t === "tabs") {
    activeTab = message.tabs.find((tab) => tab.active)?.id;
    if (activeTab && !setup.has(activeTab)) {
      setup.add(activeTab);
      send({ t: "view", tab: activeTab, w: 1050, h: 893, dpr: 1 });
      // Native mode must reject a request to restore DOM replay, rather than silently inject it.
      send({ t: "mode", tab: activeTab, mode: "dom", video: false });
      const tab = message.tabs.find((tab) => tab.id === activeTab);
      if (!tab.url.startsWith("https://who.1ms.dog/"))
        send({ t: "nav", tab: activeTab, action: "go", url: "https://who.1ms.dog/" });
    }
  }
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
try {
  const started = Date.now();
  let result;
  while (Date.now() - started < 50000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      result =
        await evaluate(`({url:location.href,title:document.title,text:document.body.innerText,
        identity:{ua:navigator.userAgent,platform:navigator.platform,webdriver:navigator.webdriver,screen:[screen.width,screen.height],
          eme:Function.prototype.toString.call(navigator.requestMediaKeySystemAccess),
          enumerate:Function.prototype.toString.call(navigator.mediaDevices.enumerateDevices),permissions:Function.prototype.toString.call(navigator.permissions.query),
          shadow:Function.prototype.toString.call(Element.prototype.attachShadow),clipboard:Function.prototype.toString.call(navigator.clipboard.readText)},
        globals:Object.getOwnPropertyNames(window).filter(k=>/mirror|rrweb/i.test(k))})`);
      if (
        Date.now() - started >= 18000 &&
        result.text.includes("Lie detection") &&
        result.text.includes("signals read")
      )
        break;
    } catch {}
  }
  assert(result?.url.startsWith("https://who.1ms.dog/"), "Detector did not load");
  assert(result.identity.eme.includes("[native code]"), "EME API was replaced");
  assert(result.identity.enumerate.includes("[native code]"), "Device enumeration was replaced");
  assert(result.identity.permissions.includes("[native code]"), "Permissions API was replaced");
  assert.equal(result.identity.webdriver, false);
  assert.deepEqual(
    result.identity.screen,
    [1920, 1080],
    "Shared display leaked into screen metrics",
  );
  if (expectedMode === "native") {
    assert(nativeAdvertised && modes.includes("px"), "Native rendering was not enforced");
    if (!frames) {
      pixelStartupRetried = true;
      send({ t: "mode", tab: activeTab, mode: "px", video: false });
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    assert(frames > 0, "Native mode produced no pixel frames");
    assert(
      result.identity.shadow.includes("[native code]"),
      "Native mode still records shadow DOM",
    );
    assert(
      result.identity.clipboard.includes("[native code]"),
      "Native mode still installs clipboard hooks",
    );
  }
  assert(viewportEpoch !== undefined, "Viewport negotiation did not complete");
  await evaluate(
    `window.__reviewClickCount=0;{const button=document.createElement('button');button.textContent='Local review';button.style.cssText='position:fixed;left:20px;top:20px;width:120px;height:40px;z-index:2147483647';button.onclick=()=>window.__reviewClickCount++;document.body.append(button)};true`,
  );
  send({ t: "view", tab: activeTab, w: 1050, h: 893, dpr: 1 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const kind of ["down", "up"])
    send({
      t: "ptr",
      tab: activeTab,
      kind,
      nodeId: 0,
      rx: 0,
      ry: 0,
      vx: 60,
      vy: 40,
      button: 0,
      buttons: kind === "down" ? 1 : 0,
      mods: 0,
    });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const clicked = await evaluate("window.__reviewClickCount");
  assert.equal(clicked, 1, "Pointer input was blocked or dispatched incorrectly");
  const report = {
    expectedMode,
    nativeAdvertised,
    pixelFrames: frames,
    pointerInput: "passed",
    viewportEpoch,
    ...result,
  };
  await writeFile(outputFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      expectedMode,
      nativeAdvertised,
      pixelStartupRetried,
      pixelFrames: frames,
      pointerInput: "passed",
      screen: result.identity.screen,
      detectorGrade: /Grade\s+([A-F])/.exec(result.text)?.[1],
      lieDetection: /Lie detection\s+([^\n]+)/.exec(result.text)?.[1],
      report: outputFile,
    }),
  );
} finally {
  socket.close();
}
