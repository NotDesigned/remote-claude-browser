// One temporary Chrome with real recorder, replay, touch events, and gateway input dispatch.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { chromium, webkit } from "playwright";
import { createAgentBundle } from "../packages/agent/dist/index.js";
import {
  ChunkReassembler,
  type AgentMsg,
  type AgentCmdInput,
  type CmdRes,
  type Down,
  type Up,
} from "../packages/protocol/src/index";
import { TabHub } from "../packages/gateway/src/hub/tabhub";
import { createInputRelay, type InputMsg } from "../packages/gateway/src/input/relay";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const baseline = process.env.MOBILE_TOUCH_BASELINE === "1";
const webkitViewer = process.env.MOBILE_TOUCH_ENGINE === "webkit";
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const root = resolve("packages/viewer/dist");
const remoteHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;height:1800px;background:linear-gradient(#fff,#ddd);font:16px sans-serif}#editor{position:absolute;left:20px;top:20px;width:280px;height:80px;border:1px solid #555}#tap{position:absolute;left:20px;top:125px;width:160px;height:36px}.hover-row{position:absolute;left:20px;top:180px;width:280px;height:40px;background:#eee}.hover-button{position:absolute;right:4px;top:0;width:0;height:40px;opacity:0;pointer-events:none}.hover-row:hover .hover-button{width:40px;opacity:1;pointer-events:auto}@media(pointer:coarse){.hover-button{width:40px;opacity:1;pointer-events:auto}}#nested{position:absolute;left:20px;top:270px;width:280px;height:150px;overflow:auto;border:1px solid #333}#nested-content{height:1000px;background:linear-gradient(#cde,#7ad)}#bottom{position:absolute;top:1500px}
</style></head><body><div id="editor" contenteditable="true" role="textbox"></div><button id="tap" onclick="window.tapCount++">Tap button</button><div class="hover-row">Hover menu<button class="hover-button" id="menu" onclick="window.menuCount++">⋯</button></div><div id="nested"><div id="nested-content">Nested scrolling</div></div><p id="bottom">Bottom of page</p><script>window.tapCount=0;window.menuCount=0;</script></body></html>`;
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://fixture").pathname;
  if (path === "/api/client/session") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        sid: "client-1",
        label: "Mobile QA",
        maxClients: 8,
        available: 7,
        sharedAccount: true,
      }),
    );
    return;
  }
  if (path === "/remote") {
    response.writeHead(200, { "content-type": "text/html" }).end(remoteHtml);
    return;
  }
  const file = resolve(root, path === "/" ? "index.html" : "." + path);
  if (!file.startsWith(root + "/")) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    response
      .writeHead(200, {
        "content-type":
          (
            { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" } as Record<
              string,
              string
            >
          )[extname(file)] ?? "application/octet-stream",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  executablePath: "/opt/claude-test-chrome/chrome",
  headless: true,
});
let viewerBrowser = browser;
const wss = new WebSocketServer({ server, path: "/ws" });
const sockets = new Set<any>();
const hub = new TabHub({ sessionId: "client-1", tabId: "mobile" });
const chunks = new ChunkReassembler();
const pending = new Map<number, (reply: CmdRes) => void>();
const received: Up[] = [];
const dispatches: Promise<unknown>[] = [];
const checks: Record<string, boolean> = {};
let reqId = 0;
let mode: "dom" | "px" = "dom";
let viewport = { w: 375, h: 640 };
const watchdog = setTimeout(() => process.exit(124), 240000);
const broadcast = (message: Down) => {
  for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(message));
};
try {
  const remote = await browser.newPage({ viewport: { width: 375, height: 640 } });
  await remote.exposeFunction("__mirror_emit", (payload: string) => {
    const message = chunks.add(payload);
    if (!message) return;
    if (message.kind === "cmdres") {
      pending.get(message.reqId)?.(message);
      return;
    }
    for (const down of hub.ingest(message as AgentMsg))
      if (mode === "dom" || down.t === "snapshot") broadcast(down);
  });
  await remote.addInitScript({ content: createAgentBundle({ canvas: { enabled: false } }) });
  await remote.goto(origin + "/remote");
  await remote.waitForFunction(() => typeof (window as any).__mirror_cmd === "function");
  const remoteCdp = await remote.context().newCDPSession(remote);
  const sendCmd = async (_tab: string, command: AgentCmdInput): Promise<CmdRes> => {
    const id = ++reqId;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<CmdRes>((resolve, reject) => {
      pending.set(id, resolve);
      timer = setTimeout(
        () => reject(new Error("fixture command timed out")),
        webkitViewer ? 30000 : 5000,
      );
    });
    try {
      const [result] = await Promise.all([
        response,
        remote.evaluate(
          ({ command, id }) => (window as any).__mirror_cmd({ ...command, reqId: id }),
          { command, id },
        ),
      ]);
      return result;
    } finally {
      clearTimeout(timer!);
      pending.delete(id);
    }
  };
  hub.onNeedSnapshot(() => sendCmd("mobile", { cmd: "snapshot" }));
  const relay = createInputRelay({
    agentLink: { async *msgs() {}, sendCmd },
    send: async (_session, method, params) => remoteCdp.send(method as never, params as never),
    sessionFor: () => "fixture",
    isDriver: () => true,
    allowsInput: () => true,
    noteInput: () => hub.noteInput(),
    viewportFor: () => viewport,
  });
  const pixels = async () =>
    broadcast({
      t: "px",
      tab: "mobile",
      data: (await remote.screenshot({ type: "jpeg", quality: 70 })).toString("base64"),
      w: viewport.w,
      h: viewport.h,
    });
  let controlWork = Promise.resolve();
  wss.on("connection", (socket: any) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(
      JSON.stringify({
        t: "hello",
        viewerId: "mobile-viewer",
        role: "driver",
        sessionId: "client-1",
        serverTs: Date.now(),
      }),
    );
    socket.send(
      JSON.stringify({
        t: "tabs",
        tabs: [{ id: "mobile", title: "Mobile fixture", url: origin + "/remote", active: true }],
      }),
    );
    for (const down of hub.joinPayload()) socket.send(JSON.stringify(down));
    socket.on("message", (raw: any) => {
      const message = JSON.parse(String(raw)) as Up;
      received.push(message);
      if (message.t === "ping")
        socket.send(
          JSON.stringify({
            t: "pong",
            id: message.id,
            sentTs: message.sentTs,
            serverTs: Date.now(),
          }),
        );
      if (message.t === "view")
        controlWork = controlWork.then(async () => {
          viewport = { w: message.w, h: message.h };
          hub.viewport = { ...viewport, dpr: 1 };
          await remoteCdp.send("Emulation.setDeviceMetricsOverride", {
            width: message.w,
            height: message.h,
            deviceScaleFactor: 1,
            mobile: false,
          });
          hub.requestSnapshot("viewport");
        });
      if (message.t === "resync-req") hub.requestSnapshot("resync");
      if (message.t === "mode")
        controlWork = controlWork.then(async () => {
          mode = message.mode;
          hub.mode = mode;
          broadcast(message);
          if (mode === "px") await pixels();
          else hub.requestSnapshot("resync");
        });
      if (["ptr", "key", "text", "value", "scroll", "ime"].includes(message.t))
        dispatches.push(relay("mobile-viewer", message as InputMsg));
    });
  });
  if (webkitViewer)
    viewerBrowser = await webkit.launch({
      headless: true,
      env: {
        ...process.env,
        LIBGL_ALWAYS_SOFTWARE: "1",
        LP_NUM_THREADS: "1",
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      },
    });
  const context = await viewerBrowser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("mobile fixture viewer error", error.message));
  await page.goto(origin);
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  const local = page.frameLocator("#mirror-host iframe");
  await page.evaluate(() => {
    (window as any).__mirrorWebsiteScriptRan = false;
    const doc = document.querySelector<HTMLIFrameElement>("#mirror-host iframe")!.contentDocument!;
    const script = doc.createElement("script");
    script.textContent = "parent.__mirrorWebsiteScriptRan = true";
    doc.head.append(script);
    doc.body.setAttribute("onpointerdown", "parent.__mirrorWebsiteScriptRan = true");
    doc.querySelector("#editor")!.setAttribute("oninput", "parent.__mirrorWebsiteScriptRan = true");
    const child = doc.createElement("iframe");
    child.srcdoc = "<script>parent.parent.__mirrorWebsiteScriptRan = true</script>";
    child.style.display = "none";
    doc.body.append(child);
  });
  const settle = async () => {
    await Promise.all(dispatches);
    await page.waitForTimeout(200);
    await Promise.all(dispatches);
  };
  const swipe = async (x: number, from: number, to: number) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: from }],
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: from + ((to - from) * step) / 12 }],
      });
      await page.waitForTimeout(18);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await settle();
  };
  await local.locator("#tap").tap();
  await settle();
  checks.domTapExactlyOnce = await remote.evaluate(() => (window as any).tapCount === 1);
  await local.locator("#menu").tap();
  await settle();
  checks.domHoverMenuTap = await remote.evaluate(() => (window as any).menuCount === 1);
  if (!baseline) {
    await remote.locator("#tap").evaluate((button) => {
      (button as HTMLButtonElement).onclick = () => {
        (window as any).tapCount++;
        (window as any).__mirror_cmd({ cmd: "snapshot", reqId: 1000000 });
      };
    });
    await local.locator("#tap").tap();
    await settle();
    await page.waitForFunction(
      () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    );
    checks.domTapSurvivesSnapshotRebuild = await remote.evaluate(
      () => (window as any).tapCount === 2,
    );
    await remote.locator("#tap").evaluate((button) => {
      (button as HTMLButtonElement).onclick = () => {
        (window as any).tapCount++;
      };
    });
  }
  await local.locator("#editor").tap();
  await settle();
  checks.domTapFocusesLocalEditor = await local
    .locator("#editor")
    .evaluate((el) => el.ownerDocument.activeElement === el);
  await page.keyboard.insertText("分析AI问题");
  await settle();
  checks.domTypedTextReachesRemote = await remote
    .locator("#editor")
    .evaluate((el) => el.textContent === "分析AI问题");
  checks.websiteScriptsRemainBlocked = await page.evaluate(
    () => (window as any).__mirrorWebsiteScriptRan === false,
  );
  if (!webkitViewer) {
    const rect = await page.locator("#mirror-host iframe").boundingBox();
    assert.ok(rect);
    await swipe(rect.x + 350, rect.y + Math.min(480, rect.height - 20), rect.y + 160);
    checks.domTouchScrollsRemote = await remote.evaluate(() => scrollY > 20);
    await remote.evaluate(() => window.scrollTo(0, 0));
    await local.locator("body").evaluate((el) => el.ownerDocument.defaultView!.scrollTo(0, 0));
    await settle();
    await page.locator("#view-mode-select").selectOption("px");
    await page.locator("#mirror-host canvas").waitFor();
    await controlWork;
    let canvasRect = (await page.locator("#mirror-host canvas").boundingBox())!;
    const beforePan = await remote.evaluate(() => ({
      tap: (window as any).tapCount,
      menu: (window as any).menuCount,
    }));
    await swipe(
      canvasRect.x + 350,
      canvasRect.y + Math.min(480, canvasRect.height - 10),
      canvasRect.y + 160,
    );
    checks.pixelTouchScrollsRemote = await remote.evaluate(() => scrollY > 20);
    checks.pixelSwipeDoesNotClick = await remote.evaluate(
      (before) =>
        (window as any).tapCount === before.tap && (window as any).menuCount === before.menu,
      beforePan,
    );
    await remote.evaluate(() => window.scrollTo(0, 0));
    await settle();
    canvasRect = (await page.locator("#mirror-host canvas").boundingBox())!;
    await swipe(canvasRect.x + 100, canvasRect.y + 395, canvasRect.y + 220);
    checks.pixelTouchScrollsNested = await remote
      .locator("#nested")
      .evaluate((el) => el.scrollTop > 20);
    checks.pixelNestedScrollLeavesRoot = await remote.evaluate(() => scrollY === 0);
    await page.touchscreen.tap(canvasRect.x + 80, canvasRect.y + 140);
    await settle();
    checks.pixelTapExactlyOnce = await remote.evaluate(
      (expected) => (window as any).tapCount === expected,
      baseline ? 2 : 3,
    );
    checks.pixelTapRetainsLocalIme = await page.evaluate(
      () => document.activeElement?.classList.contains("px-ime-input") === true,
    );
  }
  const result = {
    fixtureOnly: true,
    engine: webkitViewer ? "webkit" : "chromium",
    realTouchEvents: true,
    baseline,
    checks,
    counts: await remote.evaluate(() => ({
      tap: (window as any).tapCount,
      menu: (window as any).menuCount,
      scrollY,
      nested: document.querySelector("#nested")!.scrollTop,
    })),
    inputKinds: received.reduce<Record<string, number>>((counts, message) => {
      counts[message.t] = (counts[message.t] ?? 0) + 1;
      return counts;
    }, {}),
  };
  await writeFile(
    baseline
      ? "artifacts/mobile-input-baseline.json"
      : webkitViewer
        ? "artifacts/mobile-input-webkit.json"
        : "artifacts/mobile-input-smoke.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!baseline) for (const [name, ok] of Object.entries(checks)) assert.equal(ok, true, name);
} finally {
  clearTimeout(watchdog);
  hub.invalidateDocument();
  if (viewerBrowser !== browser) await viewerBrowser.close();
  await browser.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
}
