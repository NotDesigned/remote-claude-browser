// A real ProseMirror composer in one temporary Chrome, mirrored to a desktop and a phone viewer
// through the real recorder, replay and gateway input relay. Several messages go out in a row,
// typing on straight after each send: each must reach the page once, as the page's input rules
// made it, the field sync must never fail, and the composer here must end up empty.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { chromium, type Page } from "playwright";
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
import { viewerDist } from "./viewer-dist.mjs";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const root = viewerDist();
const composerScript = await readFile(
  new URL("./fixtures/prosemirror-composer.js", import.meta.url),
  "utf8",
);
const remoteHtml = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Composer</title>
<style>body{margin:0;font:16px sans-serif}#bar{position:fixed;bottom:0;left:0;right:0;padding:8px;background:#eee}
.ProseMirror{min-height:40px;border:1px solid #888;padding:6px;background:#fff;white-space:pre-wrap}
.ProseMirror p{margin:0}.is-empty::before{content:attr(data-placeholder);color:#999;float:left;height:0}
#thread{padding:8px 8px 120px}</style>
<div id="thread"></div><div id="bar"></div>
<script>${composerScript.replaceAll("</script", "<\\/script")}</script>
<script>
const thread = document.getElementById("thread");
window.sentMessages = [];
PMComposer.mount(document.getElementById("bar"), {
  onSend(text) {
    window.sentMessages.push(text);
    const msg = document.createElement("p");
    msg.className = "sent";
    msg.textContent = text;
    thread.append(msg);
    const reply = document.createElement("p");
    thread.append(reply);
    let words = 0;
    const timer = setInterval(() => {
      reply.append(" word" + words);
      if (++words > 40) clearInterval(timer);
    }, 30);
  },
});
document.getElementById("composer").focus();
</script>`;
const remoteUrl = "https://claude.ai/composer-input-fixture";
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://fixture").pathname;
  if (path === "/api/client/session") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ sid: "client-1", label: "Composer QA", sharedAccount: true }));
    return;
  }
  const file = resolve(root, path === "/" ? "index.html" : "." + path);
  if (!file.startsWith(root + "/")) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    const types: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".html": "text/html",
    };
    response
      .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? chromium.executablePath(),
  headless: true,
});
const wss = new WebSocketServer({ server, path: "/ws" });
const sockets = new Set<any>();
const chunks = new ChunkReassembler();
const pending = new Map<number, (reply: CmdRes) => void>();
const failures: string[] = [];
let reqId = 0;
const watchdog = setTimeout(() => process.exit(124), 240_000);
const broadcast = (message: Down) => {
  for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(message));
};

async function run(label: string, softKeyboard: boolean): Promise<void> {
  const hub = new TabHub({ sessionId: "client-1", tabId: "composer" });
  const remote = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await remote.exposeFunction("__mirror_emit", (payload: string) => {
    const message = chunks.add(payload);
    if (!message) return;
    if (message.kind === "cmdres") {
      pending.get(message.reqId)?.(message);
      return;
    }
    for (const down of hub.ingest(message as AgentMsg)) broadcast(down);
  });
  await remote.addInitScript({ content: createAgentBundle({ canvas: { enabled: false } }) });
  await remote.route(remoteUrl, (route) =>
    route.fulfill({ contentType: "text/html", body: remoteHtml }),
  );
  await remote.goto(remoteUrl);
  await remote.waitForFunction(() => typeof (window as any).__mirror_cmd === "function");
  const remoteCdp = await remote.context().newCDPSession(remote);
  const sendCmd = async (_tab: string, command: AgentCmdInput): Promise<CmdRes> => {
    const id = ++reqId;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<CmdRes>((resolve, reject) => {
      pending.set(id, resolve);
      timer = setTimeout(() => reject(new Error("fixture command timed out")), 5_000);
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
  hub.onNeedSnapshot(() => sendCmd("composer", { cmd: "snapshot" }));
  let viewport = { w: 390, h: 700 };
  const relay = createInputRelay({
    agentLink: { async *msgs() {}, sendCmd },
    send: async (_session, method, params) => remoteCdp.send(method as never, params as never),
    sessionFor: () => "fixture",
    isDriver: () => true,
    allowsInput: () => true,
    noteInput: () => hub.noteInput(),
    viewportFor: () => viewport,
    onValueStatus: (tab, failed, reason) => {
      if (failed) failures.push(`${label}: ${reason}`);
      broadcast({ t: "input-status", tab, failed, ...(reason ? { reason } : {}) });
    },
  });
  let queue = Promise.resolve();
  const onConnection = (socket: any) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.send(
      JSON.stringify({
        t: "hello",
        viewerId: "viewer",
        role: "driver",
        sessionId: "client-1",
        serverTs: Date.now(),
      }),
    );
    socket.send(
      JSON.stringify({
        t: "tabs",
        tabs: [{ id: "composer", title: "Composer", url: remoteUrl, active: true }],
      }),
    );
    for (const down of hub.joinPayload()) socket.send(JSON.stringify(down));
    socket.on("message", (raw: any) => {
      const message = JSON.parse(String(raw)) as Up;
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
        queue = queue.then(async () => {
          viewport = { w: message.w, h: message.h };
          hub.viewport = { ...viewport, dpr: 1 };
          await remote.setViewportSize({ width: message.w, height: message.h });
          hub.requestSnapshot("viewport");
        });
      if (message.t === "resync-req") hub.requestSnapshot("resync");
      if (["ptr", "key", "text", "value", "scroll", "ime"].includes(message.t))
        void relay("viewer", message as InputMsg);
    });
  };
  wss.on("connection", onConnection);
  const context = await browser.newContext(
    softKeyboard
      ? { viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1100, height: 800 } },
  );
  await context.addInitScript(() => {
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
  });
  const page: Page = await context.newPage();
  page.on("pageerror", (error) => console.error(`${label} viewer error`, error.message));
  try {
    await page.goto(origin + "/?sid=client-1");
    await page.waitForFunction(
      () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    );
    const mirrored = page.frameLocator("#mirror-host iframe");
    await mirrored.locator("#composer").waitFor();
    await mirrored.locator("#composer").click();
    await page.waitForTimeout(400);
    const cdp = await context.newCDPSession(page);
    const type = async (text: string) => {
      if (!softKeyboard) return page.keyboard.type(text, { delay: 40 });
      for (const character of text) {
        await page.keyboard.insertText(character);
        await page.waitForTimeout(40);
      }
    };
    const compose = async (pinyin: string, text: string) => {
      for (let length = 1; length <= pinyin.length; length++) {
        const preedit = pinyin.slice(0, length);
        await cdp.send("Input.imeSetComposition", {
          text: preedit,
          selectionStart: preedit.length,
          selectionEnd: preedit.length,
        });
        await page.waitForTimeout(40);
      }
      await cdp.send("Input.insertText", { text });
    };
    const rounds: Array<{ parts: Array<string | [string, string]>; expected: string }> = [
      { parts: ["first message goes out once"], expected: "first message goes out once" },
      { parts: ["second -- with a dash"], expected: "second — with a dash" },
      { parts: ["**bold** then more"], expected: "bold then more" },
      { parts: ["pinyin ", ["nihao", "你好"], " done"], expected: "pinyin 你好 done" },
      { parts: ["fifth straight after"], expected: "fifth straight after" },
    ];
    const expected: string[] = [];
    for (const [index, round] of rounds.entries()) {
      for (const part of round.parts)
        await (typeof part === "string" ? type(part) : compose(part[0], part[1]));
      await page.waitForTimeout(index % 2 ? 60 : 600);
      await page.keyboard.press("Enter");
      expected.push(round.expected);
      await page.waitForTimeout(index % 2 ? 30 : 250);
    }
    await page.waitForTimeout(3_000);
    const sent = await remote.evaluate(() => (window as any).sentMessages as string[]);
    const composer = await mirrored.locator("#composer").textContent();
    console.log(JSON.stringify({ label, sent, composer, failures }));
    assert.deepEqual(sent, expected, `${label}: messages did not reach the page as typed`);
    assert.deepEqual(failures, [], `${label}: the field sync failed`);
    assert.equal(composer, "", `${label}: the composer here still shows text`);
    console.log(`${label}: a real ProseMirror composer sends each message once and stays in sync.`);
  } finally {
    wss.off("connection", onConnection);
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await context.close();
    hub.invalidateDocument();
    await remote.close();
  }
}

try {
  await run("Desktop", false);
  await run("Phone", true);
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
}
