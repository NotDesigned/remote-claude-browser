// Two raw viewers and one gateway-owned temporary Chrome. Never touches the production browser.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Down, Up } from "../packages/protocol/src/index";
import { CHAT_EXPRESSION, fileDownloadExpression } from "../packages/gateway/src/claude/extract";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Run through scripts/limited-run.sh");
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws") as typeof import("ws").WebSocket;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const watchdog = setTimeout(() => process.exit(124), 300000);
const profile = await mkdtemp(join(tmpdir(), "two-client-fixture-"));
const clients: Viewer[] = [];
let gateway: ChildProcess | undefined;
let gatewayLog = "";
const checks: Record<string, boolean> = {};
const fixture = createHttpServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
  if (path === "/download") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="client-fixture.txt"',
    });
    response.end("isolated client download\n");
    return;
  }
  if (path === "/favicon.ico") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Two-client fixture</title>
<style>body{margin:0;font:18px sans-serif;background:#fafafa}#editor{position:absolute;left:20px;top:30px;width:420px;height:120px;border:1px solid #555;white-space:pre-wrap}.pulse{position:absolute;left:480px;top:30px;width:20px;height:20px;background:#2563eb}@keyframes pulse{50%{background:#dc2626}}</style>
<div id="editor" contenteditable="true" role="textbox"></div><span class="pulse"></span><button id="attach-button" aria-label="Add files and more" onpointerdown="if(event.buttons!==1)return;this.disabled=true;const input=document.createElement('input');input.id='attachment';input.type='file';input.multiple=true;document.body.append(input)">附件</button><div data-testid="assistant-message"><span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden">Claude responded: 受控回复</span>受控回复<a id="download" href="/download" download>Download fixture</a><div data-testid="message-actions">Copy · 1 minute ago</div><div data-testid="file-card-block"><button aria-label="Download fixture-card.csv" onclick="document.querySelector('#download').click()">保存</button></div></div><button id="send" aria-label="Send message" style="position:absolute;left:500px;top:100px" disabled>Send</button><button id="stop" aria-label="Stop generating" hidden>Stop</button><div id="native-messages"></div>
<script>
let streamTimer;
const editor=document.querySelector('#editor'), send=document.querySelector('#send'), stop=document.querySelector('#stop');
editor.addEventListener('input',()=>{send.disabled=!editor.textContent.trim()});
send.onclick=()=>{
  const text=editor.textContent; if(!text.trim())return;
  editor.textContent=''; send.disabled=true;
  history.pushState({},'', '/chat/native-fixture');
  const user=document.createElement('div');user.dataset.testid='user-message';user.textContent=text;
  const assistant=document.createElement('div');assistant.dataset.testid='assistant-message';
  document.querySelector('#native-messages').append(user,assistant);
  stop.hidden=false;let n=0;clearInterval(streamTimer);
  streamTimer=setInterval(()=>{assistant.textContent+='流式回复'+(++n)+' ';if(n===6){clearInterval(streamTimer);stop.hidden=true}},80);
};
stop.onclick=()=>{clearInterval(streamTimer);stop.hidden=true};
</script>`);
});
await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", done));
const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const portReservation = createTcpServer();
await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
const gatewayPort = (portReservation.address() as { port: number }).port;
await new Promise<void>((done) => portReservation.close(() => done()));
const origin = `http://127.0.0.1:${gatewayPort}`;

interface State {
  sid: string;
  tabs: { tab: string; epoch: number; docId: number; seq: number; url: string }[];
}
interface Lease {
  sid: string;
  label: string;
  maxClients: number;
  available: number;
  sharedAccount: boolean;
}
type ServerStatus = Extract<Down, { t: "server-status" }>;
class Viewer {
  readonly messages: Down[] = [];
  readonly tabIds = new Set<string>();
  readonly frames = new Map<string, number>();
  readonly modes = new Map<string, "dom" | "px">();
  readonly acknowledged = new Map<string, number>();
  pixelAvailable?: boolean;
  status?: ServerStatus;
  socket: import("ws").WebSocket;
  viewerId?: string;
  driver = false;
  closed = false;
  closeCode?: number;
  closeReason?: string;
  expected?: { tab: string; w: number; h: number };
  constructor(
    readonly owner: string,
    readonly sid: string,
    readonly connectionKey = randomUUID(),
  ) {
    this.socket = new WebSocket(
      `${origin.replace("http:", "ws:")}/ws?sid=${encodeURIComponent(sid)}&connectionKey=${encodeURIComponent(connectionKey)}`,
      {
        headers: { Origin: origin, "x-mirror-e2e-owner": owner },
      },
    );
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Down;
      if (message.t === "hello") {
        this.viewerId = message.viewerId;
        this.driver = message.role === "driver";
      }
      if (message.t === "driver") this.driver = message.viewerId === this.viewerId;
      if (message.t === "mode") this.modes.set(message.tab, message.mode);
      if (message.t === "px-capacity") this.pixelAvailable = message.available;
      if (message.t === "server-status") this.status = message;
      if (message.t === "tabs") for (const tab of message.tabs) this.tabIds.add(tab.id);
      if (message.t === "px") {
        this.frames.set(message.tab, (this.frames.get(message.tab) ?? 0) + 1);
        // Keep only metadata; no reason to retain frame images in the Node test process.
        message.data = "";
      }
      this.messages.push(message);
      if (this.messages.length > 600) this.messages.splice(0, this.messages.length - 600);
      if (
        message.t === "snapshot" &&
        message.reason === "viewport" &&
        this.expected?.tab === message.tab
      ) {
        const meta = message.data.find((event) => event.type === 4);
        if (
          meta?.type === 4 &&
          meta.data.width === this.expected.w &&
          meta.data.height === this.expected.h
        ) {
          this.send({ t: "view-ack", tab: message.tab, epoch: message.epoch });
          this.acknowledged.set(message.tab, message.epoch);
        }
      }
    });
    this.socket.on("close", (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason.toString();
    });
    // open() below and subsequent waits observe closure; avoid an unhandled EventEmitter error.
    this.socket.on("error", () => {});
    clients.push(this);
  }
  async open() {
    await waitFor(() => !!this.viewerId && this.driver, `driver hello for ${this.owner}`);
    return this;
  }
  send(message: Up) {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error(`Viewer ${this.owner} is closed`);
    this.socket.send(JSON.stringify(message));
  }
  async negotiate(tab: string, w: number, h: number) {
    const previous = this.acknowledged.get(tab);
    this.expected = { tab, w, h };
    this.send({ t: "view", tab, w, h, dpr: 1 });
    await waitFor(
      () => this.acknowledged.get(tab) !== undefined && this.acknowledged.get(tab) !== previous,
      `viewport agreement ${this.owner}`,
    );
  }
  async close() {
    if (this.closed) return;
    this.socket.close();
    await waitFor(() => this.closed, `viewer ${this.owner} close`, 4000);
  }
}
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (gateway && gateway.exitCode !== null)
      throw new Error(`Gateway exited while waiting for ${label}`);
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function request(owner: string, path: string, options: RequestInit = {}) {
  return fetch(origin + path, {
    ...options,
    headers: { "x-mirror-e2e-owner": owner, ...options.headers },
    signal: AbortSignal.timeout(25000),
  });
}
async function lease(owner: string, clientKey: string): Promise<Lease> {
  const response = await request(owner, "/api/client/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.ok(response.ok, `client acquisition failed: ${response.status}`);
  return response.json() as Promise<Lease>;
}
async function state(owner: string, sid: string): Promise<State> {
  const response = await request(owner, `/__e2e/state?sid=${encodeURIComponent(sid)}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<State>;
}
async function evaluate<T = unknown>(
  owner: string,
  sid: string,
  tab: string,
  expression: string,
): Promise<T> {
  const response = await request(owner, "/__e2e/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sid, tab, expression }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { value: T }).value;
}
async function focusEnd(owner: string, sid: string, tab: string) {
  await evaluate(
    owner,
    sid,
    tab,
    `(() => { const editor=document.querySelector('#editor');editor.focus();const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return true; })()`,
  );
}
async function editor(owner: string, sid: string, tab: string) {
  return evaluate<string>(owner, sid, tab, "document.querySelector('#editor').textContent");
}
function assertStatus(status: ServerStatus, online: number, allocated: number, pixels: number) {
  assert.equal(status.t, "server-status");
  assert.equal(status.clientsOnline, online);
  assert.equal(status.clientsAllocated, allocated);
  assert.equal(status.clientsMax, 16);
  assert.equal(status.pixelsActive, pixels);
  assert.equal(status.pixelsMax, null);
  assert.ok(Number.isFinite(status.sampledAt) && status.sampledAt > 0);
  assert.ok(status.sampledAt <= Date.now() + 5000, "resource timestamps must use real time");
  assert.ok(Number.isInteger(status.cpuCount) && status.cpuCount >= 1);
  assert.ok(
    status.cpuPercent === null ||
      (Number.isFinite(status.cpuPercent) && status.cpuPercent >= 0 && status.cpuPercent <= 100),
  );
  for (const key of ["memoryUsedBytes", "memoryTotalBytes", "browserMemoryBytes"] as const)
    assert.ok(
      status[key] === null || (Number.isFinite(status[key]) && status[key]! >= 0),
      `${key} must be nullable bytes`,
    );
  if (status.memoryUsedBytes !== null && status.memoryTotalBytes !== null)
    assert.ok(status.memoryUsedBytes <= status.memoryTotalBytes);
}
async function advanceIdle(milliseconds: number): Promise<ServerStatus> {
  const response = await request("b", "/__e2e/advance-idle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ milliseconds }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as ServerStatus | { status: ServerStatus };
  return "status" in result ? result.status : result;
}
async function rejectedWs(owner: string, sid: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${origin.replace("http:", "ws:")}/ws?sid=${encodeURIComponent(sid)}`,
      { headers: { Origin: origin, "x-mirror-e2e-owner": owner } },
    );
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Forbidden WS handshake did not finish"));
    }, 5000);
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.on("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve(101);
    });
    socket.on("error", () => {});
  });
}
function assertOnlyOwned(viewer: Viewer, forbidden: ReadonlySet<string>) {
  for (const message of viewer.messages) {
    if ("tab" in message)
      assert.equal(
        forbidden.has(message.tab),
        false,
        `${viewer.owner} received another client's ${message.t}`,
      );
    if (message.t === "tabs")
      for (const tab of message.tabs)
        assert.equal(forbidden.has(tab.id), false, `${viewer.owner} received another client's tab`);
  }
}
function assertPrivatePresence(viewer: Viewer, forbidden: ReadonlySet<string>) {
  for (const message of viewer.messages) {
    if (message.t === "driver")
      assert.equal(
        forbidden.has(message.viewerId),
        false,
        `${viewer.owner} received another client's driver`,
      );
    if (message.t === "presence")
      for (const peer of message.viewers)
        assert.equal(
          forbidden.has(peer.id),
          false,
          `${viewer.owner} received another client's presence`,
        );
    if (message.t === "hello") assert.equal(message.sessionId, viewer.sid);
  }
}

try {
  gateway = spawn("pnpm", ["exec", "tsx", "packages/gateway/src/main.ts"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MIRROR_CLIENTS: "16",
      MIRROR_E2E: "1",
      MIRROR_IDLE_GRACE_MS: "60000",
      CHROME_HEADFUL: "0",
      CHROME_PATH: "/opt/claude-test-chrome/chrome",
      MIRROR_CANVAS_SNAPSHOTS: "0",
      MIRROR_DISABLE_RTC: "1",
      MIRROR_START_URL: fixtureOrigin + "/initial",
      MIRROR_PUBLIC_ORIGIN: origin,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      CHROME_USER_DATA_DIR: profile,
      VIEWER_DIST_ROOT: resolve("packages/viewer/dist"),
      MIRROR_ACCESS_PASSWORD: "two-client-fixture-only",
      CLAUDE_CHAT_ENABLED: "1",
    },
  });
  for (const stream of [gateway.stdout, gateway.stderr])
    stream?.on("data", (chunk) => {
      gatewayLog = (gatewayLog + String(chunk)).slice(-32768);
    });
  await waitFor(
    async () => {
      try {
        return (await fetch(origin + "/healthz", { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    "gateway startup",
    45000,
  );
  const first = await lease("a", "a-test"),
    second = await lease("b", "b-test");
  assert.notEqual(first.sid, second.sid);
  assert.equal(first.maxClients, 16);
  assert.equal(first.sharedAccount, true);
  assert.equal(first.available, 15);
  checks.sixteenSessionCapacityMetadata = true;
  let a = await new Viewer("a", first.sid).open();
  const b = await new Viewer("b", second.sid).open();
  assert.notEqual(a.viewerId, b.viewerId);
  assertPrivatePresence(a, new Set([b.viewerId!]));
  assertPrivatePresence(b, new Set([a.viewerId!]));
  checks.privateDriverAndPresence = true;
  await waitFor(
    () => a.status?.clientsOnline === 2 && b.status?.clientsAllocated === 2,
    "initial server status",
  );
  assertStatus(a.status!, 2, 2, 0);
  assertStatus(b.status!, 2, 2, 0);
  checks.serverStatusAndResources = true;
  await waitFor(
    async () =>
      (await state("a", first.sid)).tabs.length > 0 &&
      (await state("b", second.sid)).tabs.length > 0,
    "owned page allocation",
  );
  const aTab = (await state("a", first.sid)).tabs[0]!.tab,
    bTab = (await state("b", second.sid)).tabs[0]!.tab;
  assert.notEqual(aTab, bTab);
  await waitFor(
    async () =>
      (await evaluate("a", first.sid, aTab, "!!document.querySelector('#editor')")) &&
      (await evaluate("b", second.sid, bTab, "!!document.querySelector('#editor')")),
    "fixture navigation",
  );
  for (const title of ["First conversation", "Second conversation", "Third conversation"]) {
    await evaluate("a", first.sid, aTab, `document.title = ${JSON.stringify(title)}; true`);
    await waitFor(
      () =>
        a.messages.some(
          (message) =>
            message.t === "tabs" &&
            message.tabs.some((tab) => tab.id === aTab && tab.title === title),
        ),
      "title updates independently of navigation",
    );
  }
  checks.pageTitleChangesWithoutAnotherNavigation = true;
  await Promise.all([a.negotiate(aTab, 760, 540), b.negotiate(bTab, 940, 640)]);
  await focusEnd("a", first.sid, aTab);
  await focusEnd("b", second.sid, bTab);
  a.send({ t: "text", tab: aTab, insert: "甲客户端：分析AI问题" });
  b.send({ t: "text", tab: bTab, insert: "乙客户端：独立中文输入" });
  await waitFor(
    async () =>
      (await editor("a", first.sid, aTab)) === "甲客户端：分析AI问题" &&
      (await editor("b", second.sid, bTab)) === "乙客户端：独立中文输入",
    "independent Chinese input",
  );
  checks.independentChineseInput = true;
  assert.deepEqual(await evaluate("a", first.sid, aTab, "[innerWidth,innerHeight]"), [760, 540]);
  assert.deepEqual(await evaluate("b", second.sid, bTab, "[innerWidth,innerHeight]"), [940, 640]);
  checks.independentViewports = true;

  const previousA = a;
  a = await new Viewer("a", first.sid).open();
  await waitFor(() => previousA.closed, "latest page replaces the previous same-SID socket");
  assert.equal(previousA.closeCode, 4009);
  assert.equal(previousA.closeReason, "replaced");
  assert.equal(a.messages.find((message) => message.t === "hello")?.role, "driver");
  assert.equal(b.closed, false);
  assert.equal(b.driver, true);
  assert.equal(await editor("b", second.sid, bTab), "乙客户端：独立中文输入");
  const stalePage = new Viewer("a", first.sid, previousA.connectionKey);
  await waitFor(() => stalePage.closed, "retired page reconnect is terminal");
  assert.equal(stalePage.closeCode, 4009);
  assert.equal(
    stalePage.messages.some((message) => message.t === "hello"),
    false,
  );
  await a.negotiate(aTab, 760, 540);
  await waitFor(
    () => a.status?.clientsOnline === 2 && b.status?.clientsOnline === 2,
    "same SID takeover keeps unique online count",
  );
  assertStatus(a.status!, 2, 2, 0);
  assertStatus(b.status!, 2, 2, 0);
  assert.equal(a.closed, false);
  assert.ok(
    a.messages
      .filter((message) => message.t === "presence")
      .every((message) => message.viewers.length === 1 && message.viewers[0]!.id === a.viewerId),
  );
  checks.latestSameSessionConnectionIsDriver = true;

  const blockedState = await request("a", `/__e2e/state?sid=${second.sid}`);
  assert.equal(blockedState.status, 403);
  const blockedEval = await request("a", "/__e2e/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sid: second.sid,
      tab: bTab,
      expression: "window.crossOwnerExecuted=true",
    }),
  });
  assert.equal(blockedEval.status, 403);
  assert.ok([401, 403].includes(await rejectedWs("a", second.sid)));
  assert.equal((await request("b", `/s/${first.sid}/a/invalid-token`)).status, 403);
  checks.httpAndWsOwnership = true;
  for (const message of [
    { t: "text", tab: bTab, insert: "FOREIGN" },
    { t: "nav", tab: bTab, action: "go", url: fixtureOrigin + "/foreign" },
    { t: "nav", tab: bTab, action: "close" },
    { t: "nav", tab: bTab, action: "activate" },
    { t: "mode", tab: bTab, mode: "px" },
    { t: "view", tab: bTab, w: 333, h: 222, dpr: 1 },
    { t: "resync-req", tab: bTab, reason: "foreign test" },
  ] as Up[]) {
    if (a.socket.readyState === WebSocket.OPEN) a.send(message);
  }
  await delay(400);
  assert.equal(await editor("b", second.sid, bTab), "乙客户端：独立中文输入");
  assert.deepEqual(
    await evaluate(
      "b",
      second.sid,
      bTab,
      "[innerWidth,innerHeight,location.pathname,!!window.crossOwnerExecuted]",
    ),
    [940, 640, "/initial", false],
  );
  checks.crossTargetCommandsRejected = true;
  if (a.closed) a = await new Viewer("a", first.sid).open();
  a.send({ t: "nav", tab: aTab, action: "go", url: fixtureOrigin + "/client-a-next" });
  await waitFor(
    async () => (await evaluate("a", first.sid, aTab, "location.pathname")) === "/client-a-next",
    "A-only navigation",
  );
  await a.negotiate(aTab, 680, 480);
  assert.deepEqual(
    await evaluate("b", second.sid, bTab, "[innerWidth,innerHeight,location.pathname]"),
    [940, 640, "/initial"],
  );
  checks.navigationAndResizeDoNotInterfere = true;

  const beforeA = a.frames.get(aTab) ?? 0,
    beforeB = b.frames.get(bTab) ?? 0;
  await evaluate(
    "a",
    first.sid,
    aTab,
    "document.querySelector('.pulse').style.animation='pulse 1s steps(2,end) infinite'; true",
  );
  await evaluate(
    "b",
    second.sid,
    bTab,
    "document.querySelector('.pulse').style.animation='pulse 1s steps(2,end) infinite'; true",
  );
  a.send({ t: "mode", tab: aTab, mode: "px" });
  await waitFor(
    () => (a.frames.get(aTab) ?? 0) >= beforeA + 2 && a.modes.get(aTab) === "px",
    "A starts its changing pixel stream",
    20000,
  );
  assert.equal(b.pixelAvailable, true);
  await waitFor(() => b.status?.pixelsActive === 1, "status records one active pixel stream");
  assertStatus(b.status!, 2, 2, 1);
  await focusEnd("b", second.sid, bTab);
  b.send({ t: "text", tab: bTab, insert: "，图像忙时仍可中文输入" });
  await waitFor(
    async () =>
      (await editor("b", second.sid, bTab)) === "乙客户端：独立中文输入，图像忙时仍可中文输入",
    "B Chinese input while the pixel slot is busy",
  );
  await b.negotiate(bTab, 1020, 700);
  assert.deepEqual(await evaluate("b", second.sid, bTab, "[innerWidth,innerHeight]"), [1020, 700]);
  assert.deepEqual(await evaluate("a", first.sid, aTab, "[innerWidth,innerHeight]"), [680, 480]);
  b.send({ t: "nav", tab: bTab, action: "go", url: fixtureOrigin + "/client-b-dom-next" });
  await waitFor(
    async () =>
      (await evaluate("b", second.sid, bTab, "location.pathname")) === "/client-b-dom-next",
    "B DOM navigation while the pixel slot is busy",
  );
  await waitFor(
    async () => await evaluate("b", second.sid, bTab, "!!document.querySelector('#editor')"),
    "B editor after its independent DOM navigation",
  );
  await b.negotiate(bTab, 940, 640);
  await focusEnd("b", second.sid, bTab);
  b.send({ t: "text", tab: bTab, insert: "乙客户端：独立中文输入" });
  await waitFor(
    async () => (await editor("b", second.sid, bTab)) === "乙客户端：独立中文输入",
    "B DOM input after navigation while A retains pixels",
  );
  assert.equal(b.modes.get(bTab), "dom");
  assert.equal(b.frames.get(bTab) ?? 0, beforeB, "DOM mode does not receive image frames");
  assert.equal(b.pixelAvailable, true);
  b.send({ t: "mode", tab: bTab, mode: "px" });
  await waitFor(
    () => (b.frames.get(bTab) ?? 0) >= beforeB + 2 && b.modes.get(bTab) === "px",
    "B starts pixels while A keeps streaming",
    20000,
  );
  await waitFor(() => b.status?.pixelsActive === 2, "status records both active pixel streams");
  assertStatus(b.status!, 2, 2, 2);
  assertOnlyOwned(a, new Set([bTab]));
  assertOnlyOwned(b, new Set([aTab]));
  a.send({ t: "mode", tab: aTab, mode: "dom" });
  await waitFor(
    () => a.modes.get(aTab) === "dom" && b.pixelAvailable === true,
    "A returns to DOM while B keeps streaming",
  );
  const stoppedA = a.frames.get(aTab) ?? 0;
  const ongoingB = b.frames.get(bTab) ?? 0;
  await waitFor(
    () => (b.frames.get(bTab) ?? 0) >= ongoingB + 2 && b.modes.get(bTab) === "px",
    "B keeps receiving frames after A stops",
    20000,
  );
  assert.equal(a.frames.get(aTab) ?? 0, stoppedA, "A must stop receiving frames after the handoff");
  assert.equal(a.modes.get(aTab), "dom");
  assertOnlyOwned(a, new Set([bTab]));
  assertOnlyOwned(b, new Set([aTab]));
  b.send({ t: "mode", tab: bTab, mode: "dom" });
  await waitFor(
    () => b.modes.get(bTab) === "dom" && b.pixelAvailable === true,
    "B stops its own pixel stream",
  );
  await waitFor(() => b.status?.pixelsActive === 0, "status records the released pixel stream");
  assertStatus(b.status!, 2, 2, 0);
  await evaluate(
    "a",
    first.sid,
    aTab,
    `(() => { const data=new DataTransfer();data.setData('text/plain','A private clipboard fixture');window.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true}));return true; })()`,
  );
  await waitFor(
    () => a.messages.some((m) => m.t === "clip" && m.text === "A private clipboard fixture"),
    "clipboard routed to A",
  );
  assert.equal(
    b.messages.some((m) => m.t === "clip" && m.text === "A private clipboard fixture"),
    false,
  );
  checks.privateClipboardRouting = true;
  await evaluate(
    "a",
    first.sid,
    aTab,
    "localStorage.setItem('qa-private-draft', 'client A draft'); true",
  );
  assert.equal(
    await evaluate("b", second.sid, bTab, "localStorage.getItem('qa-private-draft')"),
    null,
  );
  await evaluate(
    "b",
    second.sid,
    bTab,
    "localStorage.setItem('qa-private-draft', 'client B draft'); true",
  );
  assert.equal(
    await evaluate("a", first.sid, aTab, "localStorage.getItem('qa-private-draft')"),
    "client A draft",
  );
  checks.websiteStorageIsolated = true;

  await evaluate(
    "a",
    first.sid,
    aTab,
    "navigator.clipboard.writeText('A native API private').then(() => true)",
  );
  assert.equal(
    await evaluate("a", first.sid, aTab, "navigator.clipboard.readText()"),
    "A native API private",
  );
  assert.equal(await evaluate("b", second.sid, bTab, "navigator.clipboard.readText()"), "");
  await evaluate(
    "b",
    second.sid,
    bTab,
    "navigator.clipboard.writeText('B native API private').then(() => true)",
  );
  assert.equal(
    await evaluate("a", first.sid, aTab, "navigator.clipboard.readText()"),
    "A native API private",
  );
  checks.realClipboardApisIsolated = true;

  const prepareUpload = await request("a", `/s/${first.sid}/uploads/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: aTab }),
  });
  assert.equal(prepareUpload.status, 200, await prepareUpload.clone().text());
  const pick = (await prepareUpload.json()) as { key: string };
  const foreignPrepare = await request("a", `/s/${first.sid}/uploads/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: bTab }),
  });
  assert.equal(foreignPrepare.status, 404);
  const uploadPath = `/s/${first.sid}/u/${pick.key}`;
  const fileText = "独立附件上传 fixture";
  const fileBytes = Buffer.from(fileText);
  const uploadHeaders = {
    "content-type": "application/octet-stream",
    "x-mirror-file-index": "0",
    "x-mirror-file-count": "1",
    "x-mirror-file-size": String(fileBytes.length),
    "x-mirror-total-size": String(fileBytes.length),
    "x-mirror-file-name": encodeURIComponent("中文附件.txt"),
    "x-mirror-file-type": "text%2Fplain",
  };
  assert.equal(
    (await request("b", uploadPath, { method: "POST", headers: uploadHeaders, body: fileBytes }))
      .status,
    403,
  );
  const uploaded = await request("a", uploadPath, {
    method: "POST",
    headers: uploadHeaders,
    body: fileBytes,
  });
  assert.equal(uploaded.status, 204, await uploaded.text());
  assert.equal(
    await evaluate("a", first.sid, aTab, "document.querySelector('#attachment').files[0].text()"),
    fileText,
  );
  assert.equal(
    await evaluate(
      "b",
      second.sid,
      bTab,
      "document.querySelector('#attachment')?.files.length ?? 0",
    ),
    0,
  );
  assert.equal(
    (await request("a", uploadPath, { method: "POST", headers: uploadHeaders, body: fileBytes }))
      .status,
    404,
  );
  const cancelPrepare = await request("a", `/s/${first.sid}/uploads/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: aTab }),
  });
  const cancelPick = (await cancelPrepare.json()) as { key: string };
  assert.equal(
    (await request("a", `/s/${first.sid}/u/${cancelPick.key}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (
      await request("a", `/s/${first.sid}/u/${cancelPick.key}`, {
        method: "POST",
        headers: uploadHeaders,
        body: fileBytes,
      })
    ).status,
    404,
  );
  checks.actualFileUploadAndOwnership = true;
  checks.cancelUploadInvalidatesKey = true;

  const beforeDisconnectA = a.frames.get(aTab) ?? 0;
  a.send({ t: "mode", tab: aTab, mode: "px" });
  await waitFor(
    () => (a.frames.get(aTab) ?? 0) >= beforeDisconnectA + 2 && b.pixelAvailable === true,
    "A reacquires pixels before disconnecting",
    20000,
  );
  b.send({ t: "mode", tab: bTab, mode: "px" });
  await waitFor(() => b.status?.pixelsActive === 2, "both pixel streams before disconnect");
  await a.close();
  await waitFor(() => b.status?.pixelsActive === 1, "disconnect releases only A's pixel stream");
  assert.equal(b.modes.get(bTab), "px");
  b.send({ t: "mode", tab: bTab, mode: "dom" });
  await waitFor(() => b.status?.pixelsActive === 0, "B releases its remaining pixel stream");
  assert.equal((await lease("a", "a-test")).sid, first.sid);
  a = await new Viewer("a", first.sid).open();
  await a.negotiate(aTab, 680, 480);
  await waitFor(
    () => a.modes.get(aTab) === "dom" && a.pixelAvailable === true,
    "A reconnects in DOM without reacquiring pixels",
  );
  assert.equal(a.frames.get(aTab) ?? 0, 0, "reconnecting A must not start a pixel stream");
  assert.ok((await state("a", first.sid)).tabs.some((tab) => tab.tab === aTab));
  checks.concurrentPixelStreamsAndIndependentRelease = true;
  checks.reconnectRetainsOwnedPage = true;

  await evaluate(
    "a",
    first.sid,
    aTab,
    `!!window.open(${JSON.stringify(fixtureOrigin + "/popup")}, '_blank', 'width=420,height=320')`,
  );
  await waitFor(async () => (await state("a", first.sid)).tabs.length === 2, "popup ownership");
  assert.equal((await state("b", second.sid)).tabs.length, 1);
  const popup = (await state("a", first.sid)).tabs.find((tab) => tab.tab !== aTab)!.tab;
  a.send({ t: "nav", tab: popup, action: "close" });
  await waitFor(async () => (await state("a", first.sid)).tabs.length === 1, "close own popup");
  a.send({ t: "nav", tab: aTab, action: "newtab", url: fixtureOrigin + "/new-a" });
  await waitFor(async () => (await state("a", first.sid)).tabs.length === 2, "new tab ownership");
  assert.equal((await state("b", second.sid)).tabs.length, 1);
  const added = (await state("a", first.sid)).tabs.find((tab) => tab.tab !== aTab)!.tab;
  a.send({ t: "nav", tab: added, action: "close" });
  await waitFor(async () => (await state("a", first.sid)).tabs.length === 1, "close own new tab");
  checks.popupAndNewTabOwnership = true;

  if (process.env.TWO_CLIENT_SKIP_DOWNLOAD !== "1") {
    const extracted = await evaluate<{ messages: { files: { id: string; name: string }[] }[] }>(
      "a",
      first.sid,
      aTab,
      CHAT_EXPRESSION,
    );
    assert.deepEqual(extracted.messages[0].files, [
      { id: "0", name: "Download fixture" },
      { id: "1", name: "fixture-card.csv" },
    ]);
    assert.equal(
      (extracted.messages[0] as unknown as { text: string }).text,
      "受控回复Download fixture",
    );
    assert.equal(
      await evaluate("a", first.sid, aTab, fileDownloadExpression(0, 1, "fixture-card.csv")),
      true,
    );
    checks.realNativeFileExtraction = true;
    await evaluate(
      "a",
      first.sid,
      aTab,
      String.raw`(() => {
      const message = document.createElement('div');
      message.id = 'formula-extraction-fixture';
      message.dataset.testid = 'assistant-message';
      message.innerHTML = '<p>公式 <span class="katex"><annotation encoding="application/x-tex">E=mc^2\n</annotation><span aria-hidden="true">visual duplicate</span></span></p><span class="katex-display"><span class="katex"><annotation encoding="application/x-tex">\n\\frac{1}{2}\n</annotation></span></span>';
      document.body.append(message);
      return true;
    })()`,
    );
    const formulas = await evaluate<{ messages: { text: string }[] }>(
      "a",
      first.sid,
      aTab,
      CHAT_EXPRESSION,
    );
    assert.equal(formulas.messages.at(-1)!.text, "公式 $E=mc^2$\n\n$$\n\\frac{1}{2}\n$$");
    await evaluate(
      "a",
      first.sid,
      aTab,
      "document.querySelector('#formula-extraction-fixture').remove(); true",
    );
    checks.realFormulaAnnotationExtraction = true;
    await waitFor(
      () => a.messages.some((m) => m.t === "download" && m.state === "done" && !!m.href),
      "owned download completion",
    );
    const download = a.messages.findLast(
      (m) => m.t === "download" && m.state === "done",
    ) as Extract<Down, { t: "download" }>;
    assert.equal(
      b.messages.some((m) => m.t === "download" && m.id === download.id),
      false,
    );
    assert.equal((await request("b", download.href!)).status, 403);
    const ownFile = await request("a", download.href!);
    assert.equal(ownFile.status, 200);
    assert.equal(await ownFile.text(), "isolated client download\n");
    const retryFile = await request("a", download.href!);
    assert.equal(retryFile.status, 200);
    assert.equal(await retryFile.text(), "isolated client download\n");
    const partialFile = await request("a", download.href!, { headers: { range: "bytes=0-7" } });
    assert.equal(partialFile.status, 206);
    assert.equal(await partialFile.text(), "isolated");
    checks.downloadRoutingAndOwnership = true;
    checks.retryAndRangeDownload = true;
  } else checks.downloadRoutingAndOwnership = false;

  const nativeResponse = await request(
    "a",
    `/s/${first.sid}/api/claude/events?connectionKey=${randomUUID()}&tab=${aTab}`,
  );
  assert.equal(nativeResponse.status, 200);
  const nativeReader = nativeResponse.body!.getReader();
  let nativeState: Record<string, any> | undefined,
    nativeController = "",
    nativeDeltas = 0;
  const nativePump = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await nativeReader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop()!;
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const data = JSON.parse(frame.slice(6));
        nativeController = data.controller;
        if (data.type === "snapshot") nativeState = data.state;
        if (data.type === "delta" && nativeState) {
          nativeDeltas++;
          for (const change of data.edits) {
            if (change.message) nativeState.messages[change.index] = change.message;
            else if (change.edit) {
              const e = change.edit,
                m = nativeState.messages[change.index];
              m.text = m.text.slice(0, e.at) + e.insert + m.text.slice(e.at + e.delete);
            }
          }
          nativeState.messages.length = data.length;
          Object.assign(nativeState, {
            epoch: data.epoch,
            url: data.url,
            ready: data.ready,
            generating: data.generating,
          });
        }
      }
    }
  })();
  await waitFor(() => Boolean(nativeState?.ready), "native SSE ready", 20000);
  await delay(200);
  const pausedSequence = (await state("a", first.sid)).tabs.find((tab) => tab.tab === aTab)!.seq;
  const nativeSent = await request("a", `/s/${first.sid}/api/claude/action`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: origin },
    body: JSON.stringify({
      id: randomUUID(),
      controller: nativeController,
      epoch: nativeState!.epoch,
      type: "send",
      text: "原生文字全链路测试",
    }),
  });
  assert.equal(nativeSent.status, 200, await nativeSent.clone().text());
  assert.equal(((await nativeSent.json()) as { status: string }).status, "confirmed");
  await waitFor(
    () =>
      Boolean(
        nativeState?.messages.some(
          (m: any) => m.role === "assistant" && m.text.includes("流式回复6"),
        ),
      ),
    "native streamed reply",
    12000,
  );
  assert.ok(nativeDeltas > 0);
  assert.equal(
    (await state("a", first.sid)).tabs.find((tab) => tab.tab === aTab)!.seq,
    pausedSequence,
    "native messages must not record an unused DOM mutation stream",
  );
  checks.nativePausesUnusedDomRecording = true;
  checks.nativeSseSendAndStreaming = true;
  await nativeReader.cancel();
  await nativePump;
  a = await new Viewer("a", first.sid).open();
  await a.negotiate(aTab, 680, 480);
  const resumedSequence = (await state("a", first.sid)).tabs.find((tab) => tab.tab === aTab)!.seq;
  await evaluate(
    "a",
    first.sid,
    aTab,
    "document.querySelector('#editor').textContent='恢复DOM录制'; true",
  );
  await waitFor(
    async () =>
      (await state("a", first.sid)).tabs.find((tab) => tab.tab === aTab)!.seq > resumedSequence,
    "DOM recording resumes after returning from native chat",
  );
  checks.nativeDomRecordingRoundTrip = true;

  const released = await request("a", `/api/client/session/${first.sid}`, { method: "DELETE" });
  assert.ok([200, 204].includes(released.status));
  await waitFor(() => a.closed, "released owner's WebSocket closed");
  await b.negotiate(bTab, 940, 640);
  await focusEnd("b", second.sid, bTab);
  b.send({ t: "text", tab: bTab, insert: "，乙仍可操作" });
  await waitFor(
    async () => (await editor("b", second.sid, bTab)) === "乙客户端：独立中文输入，乙仍可操作",
    "B survives A release",
  );
  const third = await lease("c", "c-test");
  assert.equal(third.sid, first.sid);
  const c = await new Viewer("c", third.sid).open();
  await waitFor(async () => (await state("c", third.sid)).tabs.length > 0, "free slot reassigned");
  assert.equal((await request("a", `/__e2e/state?sid=${third.sid}`)).status, 403);
  assert.ok([401, 403].includes(await rejectedWs("a", third.sid)));
  assertOnlyOwned(c, new Set([aTab, bTab]));
  assertPrivatePresence(
    b,
    new Set(
      clients
        .filter((client) => client.owner !== "b")
        .flatMap((client) => (client.viewerId ? [client.viewerId] : [])),
    ),
  );
  assertPrivatePresence(
    c,
    new Set(
      clients
        .filter((client) => client.owner !== "c")
        .flatMap((client) => (client.viewerId ? [client.viewerId] : [])),
    ),
  );
  checks.releaseAndSlotReuse = true;
  const cTab = (await state("c", third.sid)).tabs[0]!.tab;
  await waitFor(
    async () => await evaluate("c", third.sid, cTab, "!!document.querySelector('#editor')"),
    "C fixture ready for idle protection",
  );
  assert.equal(
    await evaluate(
      "c",
      third.sid,
      cTab,
      `(() => { const stop=document.createElement('button');stop.id='idle-busy-stop';stop.setAttribute('aria-label','Stop response');stop.textContent='Stop';document.body.append(stop);return stop.getClientRects().length>0; })()`,
    ),
    true,
  );
  const beforeIdleB = await editor("b", second.sid, bTab);
  await c.close();
  await waitFor(() => b.status?.clientsOnline === 1, "closed C is offline while B remains online");
  const busyStatus = await advanceIdle(61000);
  assertStatus(busyStatus, 1, 2, 0);
  assert.equal(
    (await request("c", `/__e2e/state?sid=${third.sid}`)).status,
    200,
    "busy offline generation must retain its window",
  );
  await evaluate("c", third.sid, cTab, "document.querySelector('#idle-busy-stop').remove(); true");
  const reclaimedStatus = await advanceIdle(3000);
  assertStatus(reclaimedStatus, 1, 1, 0);
  assert.equal((await request("c", `/__e2e/state?sid=${third.sid}`)).status, 403);
  assert.ok([401, 403].includes(await rejectedWs("c", third.sid)));
  assert.equal(b.closed, false);
  await focusEnd("b", second.sid, bTab);
  b.send({ t: "text", tab: bTab, insert: "，自动回收不影响乙" });
  await waitFor(
    async () => (await editor("b", second.sid, bTab)) === beforeIdleB + "，自动回收不影响乙",
    "B input survives idle reclamation",
  );
  const fresh = await lease("fresh", "fresh-test");
  assert.equal(fresh.sid, third.sid);
  const freshViewer = await new Viewer("fresh", fresh.sid).open();
  await waitFor(
    () => freshViewer.status?.clientsOnline === 2 && freshViewer.status?.clientsAllocated === 2,
    "fresh lease status after idle slot reuse",
  );
  assertStatus(freshViewer.status!, 2, 2, 0);
  assertOnlyOwned(freshViewer, new Set([cTab, bTab]));
  assert.equal((await request("c", `/__e2e/state?sid=${fresh.sid}`)).status, 403);
  checks.idleBusyProtectionAndAutomaticReclaim = true;
  const result = {
    fixtureOnly: true,
    oneGatewayOwnedChrome: true,
    checks,
    clientSlots: [first.sid, second.sid],
    maxClients: 16,
    finalStatus: freshViewer.status,
    downloadSkipped: process.env.TWO_CLIENT_SKIP_DOWNLOAD === "1",
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/two-client-smoke.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Two-client fixture failed:", error);
  console.error(gatewayLog.slice(-12000));
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/two-client-smoke-failure.json",
    JSON.stringify({ error: String(error), checks, gatewayLog: gatewayLog.slice(-16000) }, null, 2),
    { mode: 0o600 },
  );
  throw error;
} finally {
  clearTimeout(watchdog);
  for (const client of clients) client.socket.terminate();
  if (gateway?.pid) {
    try {
      process.kill(-gateway.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise<void>((done) => gateway!.once("exit", () => done())),
      delay(5000),
    ]);
    try {
      process.kill(-gateway.pid, "SIGKILL");
    } catch {}
  }
  await new Promise<void>((done) => fixture.close(() => done()));
  await rm(profile, { recursive: true, force: true });
}
