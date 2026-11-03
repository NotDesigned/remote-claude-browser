// Controlled UI fixture only: never connects to the user's browser or a CAPTCHA service.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const watchdog = setTimeout(() => {
  console.error("Pixel fixture timed out");
  process.exit(124);
}, 90000);
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const root = resolve("packages/viewer/dist");
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://fixture.test").pathname;
  if (path === "/api/client/session") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        sid: "client-1",
        label: "独立会话 1",
        maxClients: 2,
        available: 1,
        sharedAccount: true,
      }),
    );
    return;
  }
  const file = resolve(root, path === "/" ? "index.html" : `.${path}`);
  if (!file.startsWith(root + "/")) {
    response.writeHead(403).end();
    return;
  }
  try {
    const type =
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
      "application/octet-stream";
    const body = await readFile(file);
    response.writeHead(200, { "content-type": type });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
const wss = new WebSocketServer({ server, path: "/ws" });
const inputs = [];
const views = [];
let pixel = "";
let lastMode = "dom";
let sequence = 1,
  epoch = 1;
const document = {
  type: 0,
  id: 1,
  childNodes: [
    { type: 1, id: 2, name: "html", publicId: "", systemId: "" },
    {
      type: 2,
      id: 3,
      tagName: "html",
      attributes: {},
      childNodes: [
        { type: 2, id: 4, tagName: "head", attributes: {}, childNodes: [] },
        {
          type: 2,
          id: 5,
          tagName: "body",
          attributes: {},
          childNodes: [
            {
              type: 2,
              id: 6,
              tagName: "h1",
              attributes: {},
              childNodes: [{ type: 3, id: 7, textContent: "Controlled remote-page fixture" }],
            },
          ],
        },
      ],
    },
  ],
};
wss.on("connection", (socket) => {
  let mode = lastMode,
    width = 1280,
    height = 800,
    frameTimer;
  const send = (message) => socket.readyState === 1 && socket.send(JSON.stringify(message));
  const frame = () => send({ t: "px", tab: "fixture", data: pixel, w: width, h: height });
  const snapshot = (reason) => {
    const timestamp = Date.now();
    send({
      t: "snapshot",
      tab: "fixture",
      epoch: ++epoch,
      seq: sequence++,
      reason,
      data: [
        { type: 4, timestamp, data: { href: "https://fixture.test", width, height } },
        { type: 2, timestamp, data: { node: document, initialOffset: { top: 0, left: 0 } } },
      ],
    });
  };
  send({
    t: "hello",
    viewerId: "fixture-driver",
    role: "driver",
    sessionId: "fixture",
    serverTs: Date.now(),
  });
  send({
    t: "tabs",
    tabs: [{ id: "fixture", title: "Fixture", url: "https://fixture.test", active: true }],
  });
  snapshot("nav");
  if (mode === "px") frameTimer = setInterval(frame, 16);
  socket.on("close", () => clearInterval(frameTimer));
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.t === "ping")
      send({ t: "pong", id: message.id, sentTs: message.sentTs, serverTs: Date.now() });
    if (message.t === "view") {
      views.push(message);
      width = message.w;
      height = message.h;
      snapshot("viewport");
      if (mode === "px") frame();
    }
    if (message.t === "mode") {
      mode = lastMode = message.mode;
      clearInterval(frameTimer);
      send({ t: "mode", tab: "fixture", mode });
      if (mode === "px") {
        frame();
        frameTimer = setInterval(frame, 16);
      } else snapshot("resync");
    }
    if (message.t === "ptr") inputs.push(message);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: "/opt/claude-test-chrome/chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
// The root page opens text chat by default; these checks exercise the DOM view.
await page.addInitScript(() => localStorage.setItem("mirror.view-mode", "dom"));
pixel = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const context = canvas.getContext("2d");
  context.fillStyle = "#264653";
  context.fillRect(0, 0, 2, 2);
  return canvas.toDataURL("image/png");
});
await page.addInitScript(() => {
  window.__flicker = { track: false, blanks: 0, samples: 0, sizeWrites: 0 };
  for (const name of ["width", "height"]) {
    const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
    Object.defineProperty(HTMLCanvasElement.prototype, name, {
      ...original,
      set(value) {
        if (this.classList.contains("px-canvas") && window.__flicker.track)
          window.__flicker.sizeWrites++;
        original.set.call(this, value);
      },
    });
  }
  const NativeImage = window.Image;
  window.Image = function (...args) {
    const image = new NativeImage(...args);
    let handler = null;
    Object.defineProperty(image, "onload", {
      configurable: true,
      get: () => handler,
      set: (value) => {
        handler = value;
      },
    });
    image.addEventListener("load", (event) => setTimeout(() => handler?.call(image, event), 45));
    return image;
  };
  window.Image.prototype = NativeImage.prototype;
  const sample = () => {
    if (window.__flicker.track) {
      const canvas = document.querySelector("#mirror-host canvas");
      if (!canvas || canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3] === 0)
        window.__flicker.blanks++;
      window.__flicker.samples++;
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});
const checks = {};
try {
  await page.goto(origin);
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  const toolbarVisible = () =>
    page.locator("#view-mode-select").evaluate((button) => {
      const box = button.getBoundingClientRect(),
        header = button.closest("header").getBoundingClientRect(),
        host = document.querySelector("#mirror-host").getBoundingClientRect();
      return (
        box.width > 0 &&
        box.top >= header.top &&
        box.bottom <= header.bottom + 1 &&
        box.left >= 0 &&
        box.right <= innerWidth &&
        header.bottom <= host.top + 1
      );
    });
  for (const viewport of [
    { width: 1360, height: 1000 },
    { width: 800, height: 700 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(700);
    assert.equal(await toolbarVisible(), true);
  }
  checks.toolbarVisibleDesktopTabletMobile = true;
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  await page.locator("#view-mode-select").selectOption("px");
  await page.locator("#mirror-host canvas").waitFor({ state: "visible" });
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  assert.equal(await page.locator("#mirror-host iframe").count(), 0);
  const canvas = page.locator("#mirror-host canvas");
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#mirror-host canvas");
    const host = document.querySelector("#mirror-host");
    return (
      canvas?.width === host.clientWidth &&
      canvas?.height === host.clientHeight &&
      canvas?.getContext("2d").getImageData(0, 0, 1, 1).data[3] === 255
    );
  });
  await canvas.click();
  await page.waitForTimeout(100);
  assert(
    inputs.some(
      (input) => input.nodeId === -1 && input.kind === "down" && input.vx > 0 && input.vy > 0,
    ),
  );
  checks.pixelResizePreservesCanvasAndInput = true;
  await page.evaluate(() => {
    window.__flicker.track = true;
  });
  await page.waitForTimeout(1500);
  const metrics = await page.evaluate(() => {
    window.__flicker.track = false;
    return window.__flicker;
  });
  assert(metrics.samples > 5);
  assert.equal(metrics.blanks, 0);
  assert.equal(metrics.sizeWrites, 0);
  checks.continuousFramesPreservePaint = true;
  const countBefore = views.length;
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(700);
  assert.equal(views.length, countBefore);
  checks.sameGeometryDoesNotResync = true;
  const socket = [...wss.clients][0];
  socket.send(
    JSON.stringify({
      t: "snapshot",
      tab: "background",
      epoch: 50,
      seq: 50,
      reason: "resync",
      data: [
        {
          type: 4,
          timestamp: Date.now(),
          data: { href: "https://background.test", width: 900, height: 600 },
        },
        {
          type: 2,
          timestamp: Date.now(),
          data: { node: document, initialOffset: { top: 0, left: 0 } },
        },
      ],
    }),
  );
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#mirror-host canvas").count(), 1);
  assert.equal(await page.locator("#mirror-host iframe").count(), 0);
  assert.equal(views.length, countBefore);
  checks.backgroundSnapshotDoesNotReplacePicture = true;
  socket.close(1012, "controlled reconnect");
  await page.waitForFunction(
    () =>
      document.querySelector("#connection-state")?.getAttribute("data-state") === "open" &&
      document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  for (let attempt = 0; attempt < 30 && views.length === countBefore; attempt++)
    await page.waitForTimeout(100);
  assert(views.length > countBefore);
  assert.equal(await page.locator("#mirror-host canvas").count(), 1);
  checks.reconnectPreservesPictureAndRenegotiates = true;
  await page.locator("#view-mode-select").selectOption("dom");
  await page.locator("#mirror-host iframe").waitFor();
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  assert.equal(await page.locator("#mirror-host canvas").count(), 0);
  checks.returnToDomRenegotiates = true;
  await page.locator("#connection-state").screenshot({ path: "artifacts/toolbar-fixture.png" });
  await writeFile(
    "artifacts/pixel-smoke.json",
    JSON.stringify({ fixtureOnly: true, checks }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ fixtureOnly: true, checks }, null, 2));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
