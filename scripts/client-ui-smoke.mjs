// Isolated, local-only bootstrap fixture. Never attaches to B or the authenticated browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const watchdog = setTimeout(() => {
  console.error("Client UI fixture timed out");
  process.exit(124);
}, 120000);
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const root = resolve("packages/viewer/dist");
const artifacts = resolve("artifacts");
const events = [];
const creates = [];
const connections = [];
const slots = new Map();
const views = [];
const checks = {};
const layouts = {};
const pageErrors = [];
const uploadedFiles = [];
const nativeStreams = new Set();
let uploadSerial = 0;
let completedFixtureDownload = false;
let browser;
let context;
let firstPage;
let failure;
let holdFirstCreate = true;
let holdNextDelete = false;
let heldDelete;
let statusTimer;
let statusSampledAt = 0;
let cpuPercent = 30;

function deferred() {
  let release;
  const promise = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  return { promise, release };
}
const firstCreateObserved = deferred();
const firstCreateGate = deferred();
const deleteObserved = deferred();
const note = (kind, data = {}) => {
  const entry = { seq: events.length + 1, kind, ...data };
  events.push(entry);
  return entry;
};
const json = (response, status, data) =>
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(data));

function statusSample() {
  return {
    t: "server-status",
    sampledAt: (statusSampledAt = Math.max(Date.now(), statusSampledAt + 1)),
    clientsOnline: new Set(
      connections
        .filter((entry) => !entry.closed && entry.socket.readyState === 1)
        .map((entry) => entry.sid),
    ).size,
    clientsAllocated: slots.size,
    clientsMax: 16,
    pixelsActive: 0,
    pixelsMax: null,
    cpuPercent,
    cpuCount: 2,
    memoryUsedBytes: 1.2 * 1024 ** 3,
    memoryTotalBytes: 1.9 * 1024 ** 3,
    browserMemoryBytes: 0.8 * 1024 ** 3,
  };
}
function broadcastStatus() {
  const message = JSON.stringify(statusSample());
  for (const socket of wss.clients) if (socket.readyState === 1) socket.send(message);
}

async function bodyJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16384) throw new Error("Fixture request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture.test");
    if (url.pathname === "/api/status" && request.method === "GET") {
      note("status-request");
      json(response, 200, statusSample());
      return;
    }
    if (url.pathname === "/api/client/session" && request.method === "POST") {
      const body = await bodyJson(request);
      assert.match(body.clientKey, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
      assert.match(request.headers.cookie ?? "", /fixture-device=one-context/);
      const record = note("create-request", { clientKey: body.clientKey, sid: body.sid ?? null });
      creates.push(record);
      if (holdFirstCreate) {
        holdFirstCreate = false;
        firstCreateObserved.release(record);
        await firstCreateGate.promise;
      }
      let session = [...slots.values()].find((slot) => slot.clientKey === body.clientKey);
      if (!session && body.sid) session = slots.get(body.sid);
      if (!session) {
        const sid = ["client-1", "client-2"].find((candidate) => !slots.has(candidate));
        if (!sid) {
          note("capacity-response", { clientKey: body.clientKey });
          json(response, 503, {
            code: "CLIENT_CAPACITY",
            ownedSessions: [...slots.values()].map(({ sid, label }) => ({ sid, label })),
          });
          return;
        }
        session = { sid, label: `独立会话 ${sid.at(-1)}`, clientKey: body.clientKey };
        slots.set(sid, session);
      }
      note("create-response", { sid: session.sid, clientKey: body.clientKey });
      json(response, 200, {
        sid: session.sid,
        label: session.label,
        maxClients: 16,
        available: 16 - slots.size,
        sharedAccount: true,
      });
      return;
    }
    if (url.pathname.startsWith("/api/client/session/") && request.method === "DELETE") {
      const sid = decodeURIComponent(url.pathname.split("/").at(-1));
      assert(slots.has(sid), "DELETE must name an allocated fixture session");
      const record = note("delete-request", { sid });
      if (holdNextDelete) {
        holdNextDelete = false;
        heldDelete = deferred();
        deleteObserved.release(record);
        await heldDelete.promise;
      }
      slots.delete(sid);
      note("delete-response", { sid });
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
    const scoped = /^\/s\/(client-[12])\/(.*)$/.exec(url.pathname);
    if (scoped) {
      const sid = scoped[1],
        path = scoped[2],
        tab = `fixture-${sid}`;
      if (path === "api/claude/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.write(
          `data: ${JSON.stringify({
            type: "snapshot",
            seq: 1,
            controller: "fixture-controller",
            state: {
              tab,
              epoch: "fixture-chat",
              url: "https://claude.fixture.invalid/new",
              title: "受控文字聊天",
              ready: true,
              generating: false,
              messages: [
                {
                  id: "assistant",
                  role: "assistant",
                  text: String.raw`受控回复，支持中文附件。行内 $E=mc^2$ 与 \(\alpha+\beta\)。
$$\frac{1}{2}+\int_0^1 x^2\,dx+d_{\text{model}}$$
\[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]

${"```"}python
def f(x):
    return x
${"```"}`,
                  steps: [{ summary: "Searched the web, read a page", state: "done" }],
                  files: [{ id: "0", name: "结果.txt" }],
                },
              ],
              conversations: [],
            },
          })}\n\n`,
        );
        nativeStreams.add(response);
        response.on("close", () => nativeStreams.delete(response));
        return;
      }
      if (path === "uploads/prepare" && request.method === "POST") {
        const body = await bodyJson(request);
        assert.equal(body.tab, tab);
        const pick = {
          t: "filepick",
          tab,
          key: `fixture-upload-${++uploadSerial}`,
          multiple: true,
          maxFiles: 20,
          maxFileBytes: 104857600,
          maxTotalBytes: 524288000,
        };
        for (const connection of connections)
          if (connection.sid === sid && !connection.closed && connection.socket.readyState === 1)
            connection.socket.send(JSON.stringify(pick));
        json(response, 200, pick);
        return;
      }
      if (path.startsWith("u/")) {
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        assert.equal(request.method, "POST");
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        uploadedFiles.push({
          sid,
          name: decodeURIComponent(request.headers["x-mirror-file-name"]),
          text: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(204).end();
        return;
      }
      if (path === "api/claude/file" && request.method === "POST") {
        const body = await bodyJson(request);
        assert.equal(body.controller, "fixture-controller");
        assert.equal(body.message, 0);
        assert.equal(body.file, "0");
        completedFixtureDownload = true;
        response.writeHead(204).end();
        return;
      }
      if (path === "downloads") {
        json(
          response,
          200,
          completedFixtureDownload
            ? [
                {
                  t: "download",
                  id: "fixture-download",
                  name: "结果.txt",
                  recv: 7,
                  total: 7,
                  state: "done",
                  href: `/s/${sid}/d/fixture-result`,
                },
              ]
            : [],
        );
        return;
      }
      if (path === "d/fixture-result") {
        response
          .writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="result.txt"',
          })
          .end("fixture");
        return;
      }
    }
    const file = resolve(
      root,
      url.pathname === "/" ? "index.html" : `.${decodeURIComponent(url.pathname)}`,
    );
    if (!file.startsWith(root + "/")) {
      response.writeHead(403).end();
      return;
    }
    const type =
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ??
      "application/octet-stream";
    const body = await readFile(file);
    response
      .writeHead(200, {
        "content-type": type,
        ...(url.pathname === "/"
          ? { "set-cookie": "fixture-device=one-context; Path=/; HttpOnly; SameSite=Lax" }
          : {}),
      })
      .end(body);
  } catch (error) {
    if (error?.code === "ENOENT") response.writeHead(404).end();
    else {
      note("fixture-error", { message: String(error) });
      if (!response.headersSent) json(response, 500, { code: "FIXTURE_ERROR" });
      else response.end();
    }
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://fixture.test");
  const sid = url.searchParams.get("sid");
  note("ws-upgrade", { sid, url: request.url });
  if (url.pathname !== "/ws" || !slots.has(sid)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
});

function remoteDocument(label) {
  return {
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
            attributes: {
              style:
                "margin:0;padding:36px;box-sizing:border-box;background:#fafbf8;color:#3e5542;font-family:system-ui,sans-serif",
            },
            childNodes: [
              {
                type: 2,
                id: 6,
                tagName: "h1",
                attributes: { style: "font-size:22px;font-weight:500" },
                childNodes: [{ type: 3, id: 7, textContent: `${label} · 本地验收页面` }],
              },
              {
                type: 2,
                id: 8,
                tagName: "p",
                attributes: { style: "font-size:14px;color:#7b8974;line-height:1.8" },
                childNodes: [
                  {
                    type: 3,
                    id: 9,
                    textContent:
                      "这是受控页面，仅验证会话启动与工具栏。没有连接服务器 B 或 Claude。",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

wss.on("connection", (socket, request) => {
  const sid = new URL(request.url, "http://fixture.test").searchParams.get("sid");
  const session = slots.get(sid);
  const closed = deferred();
  for (const existing of connections) {
    if (existing.sid === sid && !existing.closed && existing.socket.readyState === 1) {
      existing.socket.close(4009, "Session opened in another page");
    }
  }
  const record = {
    ...note("ws-open", { sid }),
    socket,
    closed: false,
    closePromise: closed.promise,
  };
  connections.push(record);
  const tab = `fixture-${sid}`;
  let width = 1200,
    height = 700,
    epoch = 0,
    sequence = 0;
  const send = (message) => socket.readyState === 1 && socket.send(JSON.stringify(message));
  const snapshot = (reason) => {
    const timestamp = Date.now();
    send({
      t: "snapshot",
      tab,
      epoch: ++epoch,
      seq: ++sequence,
      reason,
      data: [
        { type: 4, timestamp, data: { href: "https://claude.fixture.invalid/new", width, height } },
        {
          type: 2,
          timestamp,
          data: { node: remoteDocument(session.label), initialOffset: { top: 0, left: 0 } },
        },
      ],
    });
  };
  const viewerId = `${sid}-viewer`;
  send({ t: "hello", viewerId, role: "driver", sessionId: sid, serverTs: Date.now() });
  send({ t: "presence", viewers: [{ id: viewerId, name: "本机" }] });
  broadcastStatus();
  send({
    t: "tabs",
    tabs: [
      { id: tab, title: session.label, url: "https://claude.fixture.invalid/new", active: true },
    ],
  });
  send({
    t: "chrome",
    tab,
    url: "https://claude.fixture.invalid/new",
    loading: false,
    canBack: false,
    canFwd: false,
  });
  snapshot("nav");
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.t === "mode") send({ t: "mode", tab, mode: message.mode });
    if (message.t === "ping")
      send({ t: "pong", id: message.id, sentTs: message.sentTs, serverTs: Date.now() });
    if (message.t === "view") {
      views.push({ sid, w: message.w, h: message.h });
      width = message.w;
      height = message.h;
      snapshot("viewport");
    }
    if (message.t === "resync-req") snapshot("resync");
  });
  socket.on("close", () => {
    record.closed = true;
    note("ws-close", { sid });
    closed.release();
    broadcastStatus();
  });
});

async function ready(page, sid) {
  await page.waitForFunction((expectedSid) => {
    return (
      new URL(location.href).searchParams.get("sid") === expectedSid &&
      document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true"
    );
  }, sid);
}

async function captureHeader(page, name, viewport) {
  await page.bringToFront();
  await page.setViewportSize(viewport);
  await page.waitForTimeout(500);
  await ready(page, "client-1");
  const layout = await page.evaluate(() => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    const header = document.querySelector("#shell-bar");
    const host = document.querySelector("#mirror-host");
    return {
      width: innerWidth,
      height: innerHeight,
      header: box(header),
      host: box(host),
      address: box(document.querySelector('#urlbar input[aria-label="Address"]')),
      tabTitle: box(document.querySelector('.browser-tab[data-active="true"] .tab-title')),
      hud: box(document.querySelector("#viewer-hud-layer")),
      controls: [
        ...document.querySelectorAll("#shell-bar [data-view-mode]"),
        document.querySelector("#shell-menu-toggle"),
        document.querySelector("#shell-status"),
      ].map((element) => {
        const rect = box(element);
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const id = element.dataset.viewMode ?? element.id;
        return { id, ...rect, hit: hit !== null && (hit === element || element.contains(hit)) };
      }),
    };
  });
  layouts[name] = layout;
  assert(layout.header.bottom <= layout.host.y + 1, `${name}: header overlaps the content`);
  assert(layout.address.right <= layout.hud.x + 1, `${name}: RTT control overlaps the address`);
  assert(layout.tabTitle.width >= 20, `${name}: active tab title is squeezed out`);
  for (const control of layout.controls) {
    assert(control.width > 0 && control.height > 0, `${name}: ${control.id} has no visible size`);
    assert(
      control.x >= 0 && control.right <= layout.width + 1,
      `${name}: ${control.id} clips horizontally`,
    );
    assert(
      control.y >= layout.header.y - 1 && control.bottom <= layout.header.bottom + 1,
      `${name}: ${control.id} clips vertically`,
    );
    assert(control.hit, `${name}: ${control.id} is covered by another control`);
  }
  await page.screenshot({ path: resolve(artifacts, `client-ui-${name}.png`) });
}

try {
  await mkdir(artifacts, { recursive: true });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  statusTimer = setInterval(broadcastStatus, 3_000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CLAUDE_TEST_CHROME ?? "/opt/claude-test-chrome/chrome",
    headless: true,
  });
  context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // The root page opens text chat by default; these checks exercise the DOM view.
  await context.addInitScript(() => {
    // The first about:blank document has an opaque origin and no storage.
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
  });
  context.on("page", (page) => {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
  });
  await context.addInitScript(() => {
    const trace = [];
    window.__clientUiTrace = trace;
    const record = (kind, extra = {}) => trace.push({ seq: trace.length + 1, kind, ...extra });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : (input.url ?? String(input)),
        location.href,
      );
      const tracked =
        url.pathname.startsWith("/api/client/session") || url.pathname === "/api/status";
      const method = init?.method ?? "GET";
      if (tracked) record("api-call", { method, path: url.pathname });
      const response = await nativeFetch(input, init);
      if (tracked) record("api-response", { method, status: response.status });
      return response;
    };
    const nativeClose = WebSocket.prototype.close;
    WebSocket.prototype.close = function (...args) {
      record("ws-close-call", { url: this.url });
      return nativeClose.apply(this, args);
    };
  });
  firstPage = await context.newPage();
  await firstPage.goto(`${origin}/?new=1`);
  const firstRequest = await firstCreateObserved.promise;
  await firstPage.waitForTimeout(250);
  assert.equal(
    events.filter((event) => event.kind === "ws-upgrade").length,
    0,
    "WS opened before allocation responded",
  );
  assert.equal(
    await firstPage.locator("#client-session-overlay").getAttribute("data-phase"),
    "starting",
  );
  assert.equal(new URL(firstPage.url()).searchParams.has("new"), false);
  checks.apiBeforeWebSocket = true;
  firstCreateGate.release();
  await ready(firstPage, "client-1");

  const secondPage = await context.newPage();
  await secondPage.goto(`${origin}/?new=1`);
  await ready(secondPage, "client-2");
  const secondRequest = creates.find((request) => request.clientKey !== firstRequest.clientKey);
  assert(secondRequest, "The second tab reused the first client key");
  assert.notEqual(firstRequest.clientKey, secondRequest.clientKey);
  assert.equal(new URL(secondPage.url()).searchParams.has("new"), false);
  assert.deepEqual(
    connections
      .filter((connection) => !connection.closed)
      .map(({ sid }) => sid)
      .sort(),
    ["client-1", "client-2"],
  );
  for (const sid of ["client-1", "client-2"]) {
    const reply = events.find((event) => event.kind === "create-response" && event.sid === sid);
    const upgrade = events.find((event) => event.kind === "ws-upgrade" && event.sid === sid);
    assert(reply && upgrade && reply.seq < upgrade.seq, `${sid}: allocation must precede its WS`);
  }
  checks.independentNewTabsAndSidSockets = true;

  const beforeRefresh = creates.length;
  await firstPage.reload();
  await ready(firstPage, "client-1");
  assert.equal(creates.length, beforeRefresh + 1);
  assert.equal(creates.at(-1).clientKey, firstRequest.clientKey);
  assert.equal(creates.at(-1).sid, "client-1");
  assert.equal(slots.size, 2);
  const address = firstPage.locator('#urlbar input[aria-label="Address"]');
  const remoteUrl = await address.inputValue();
  const title = "中文网页标题 · 即时更新";
  assert.equal(await firstPage.title(), slots.get("client-1").label);
  await address.fill("https://example.com/正在编辑");
  connections
    .find((entry) => entry.sid === "client-1" && !entry.closed)
    .socket.send(
      JSON.stringify({
        t: "tabs",
        tabs: [{ id: "fixture-client-1", title, url: remoteUrl, active: true }],
      }),
    );
  await firstPage.waitForFunction((title) => document.title === title, title);
  const tabTitle = firstPage.locator('.browser-tab[data-active="true"] .tab-title');
  assert.equal(await tabTitle.textContent(), title);
  assert.ok((await tabTitle.boundingBox()).width >= 20, "tab title has visible width");
  assert.equal(await address.inputValue(), "https://example.com/正在编辑");
  await address.fill(remoteUrl);
  await address.blur();
  assert.equal(await firstPage.locator(".address-site-title").count(), 0);
  checks.websiteTitleUpdatesWithoutReplacingAddressDraft = true;
  const viewButton = (mode) => firstPage.locator(`#shell-bar [data-view-mode="${mode}"]`);
  assert.deepEqual(
    await firstPage
      .locator("#shell-bar [data-view-mode]")
      .evaluateAll((buttons) => buttons.map((button) => button.dataset.viewMode)),
    ["chat", "dom", "px"],
  );
  // Switching views happens inside the unified page: no navigation, no reload.
  await firstPage.evaluate(() => (window.__samePage = true));
  await viewButton("chat").click();
  await firstPage.locator("#chat-view #draft").waitFor();
  assert.equal(await viewButton("chat").getAttribute("aria-pressed"), "true");
  assert.equal(await firstPage.evaluate(() => window.__samePage), true);
  const chat = new URL(firstPage.url());
  assert.equal(chat.pathname, "/");
  assert.equal(chat.searchParams.get("mode"), "chat");
  assert.equal(chat.searchParams.get("sid"), "client-1");
  assert.equal(await firstPage.locator("#mirror-host").isHidden(), true);
  await firstPage.locator("#messages .katex").first().waitFor({ state: "visible" });
  assert.equal(await firstPage.locator("#messages .katex").count(), 4);
  const nativeFonts = await firstPage.evaluate(() =>
    [
      document.querySelector("#messages .text"),
      document.querySelector("#draft"),
      document.querySelector("#send"),
    ].map((element) => getComputedStyle(element).fontFamily),
  );
  assert.equal(new Set(nativeFonts).size, 1);
  const presentation = await firstPage.evaluate(() => {
    const block = document.querySelector("#messages .chat-code-block");
    const code = block?.querySelector("code");
    return {
      language: block?.querySelector("figcaption span")?.textContent,
      codeFont: code && getComputedStyle(code).fontFamily,
      code: code?.textContent,
      stepIcon: !!document.querySelector("#messages .message-step[data-kind='search'] svg"),
      idleHidden: document.querySelector("#generation-status")?.hidden,
      resize: getComputedStyle(document.querySelector("#draft")).resize,
    };
  });
  assert.equal(presentation.language, "python");
  assert.match(presentation.codeFont, /mono/i);
  assert.equal(presentation.code, "def f(x):\n    return x\n");
  assert.equal(presentation.stepIcon, true);
  assert.equal(presentation.idleHidden, true);
  assert.equal(presentation.resize, "none");
  // Opening a collapsed row asks the remote page for its detail.
  const stepRequest = firstPage.waitForRequest((request) =>
    request.url().endsWith("/api/claude/step"),
  );
  await firstPage.locator("#messages .message-step summary").click();
  assert.deepEqual(
    (({ message, step }) => ({ message, step }))((await stepRequest).postDataJSON()),
    { message: 0, step: 0 },
  );
  await firstPage.locator("#messages .message-step summary").click();
  const draftBox = firstPage.locator("#draft");
  const draftBefore = (await draftBox.boundingBox()).height;
  await draftBox.fill("第一行\n第二行\n第三行\n第四行\n第五行\n第六行");
  assert.ok((await draftBox.boundingBox()).height > draftBefore, "composer grows with its text");
  await draftBox.fill("");
  assert.equal((await draftBox.boundingBox()).height, draftBefore, "composer shrinks back");
  // KaTeX's \\text{} spans also carry the class "text"; message styles must not reach them.
  const subscript = await firstPage.evaluate(() => {
    const math = document.querySelector("#messages .katex-display .katex");
    const text = math.querySelector(".text");
    return {
      math: parseFloat(getComputedStyle(math).fontSize),
      text: parseFloat(getComputedStyle(text).fontSize),
    };
  });
  assert.ok(
    subscript.text < subscript.math * 0.85,
    `\\text subscript is ${subscript.text}px in ${subscript.math}px math`,
  );
  checks.formulasAndUnifiedFonts = true;
  await firstPage.locator("#attach").waitFor({ state: "visible" });
  await firstPage.waitForFunction(() => document.querySelector("#attach")?.disabled === false);
  await firstPage.locator("#attach").click();
  await firstPage.locator("#file-picker").waitFor({ state: "visible" });
  await firstPage.locator("#file-picker").setInputFiles({
    name: "文字附件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("文字模式中文附件"),
  });
  await firstPage.waitForFunction(() =>
    document.querySelector("#upload-status")?.textContent.includes("已上传 1"),
  );
  assert.deepEqual(uploadedFiles.at(-1), {
    sid: "client-1",
    name: "文字附件.txt",
    text: "文字模式中文附件",
  });
  const textDownloadButton = firstPage.getByRole("button", { name: "↓ 结果.txt" });
  // A finished remote download starts in this browser by itself; no save click is needed.
  const [autoSaved] = await Promise.all([
    firstPage.waitForEvent("download", { timeout: 20000 }),
    textDownloadButton.click(),
  ]);
  assert.equal(await autoSaved.failure(), null);
  // The fixture's Content-Disposition says result.txt; browsers prefer it over the link's name.
  assert.ok(["结果.txt", "result.txt"].includes(autoSaved.suggestedFilename()));
  // The fallback link stays for a moment in case the browser blocked the automatic download.
  await firstPage.locator("#downloads a").waitFor({ state: "visible" });
  const [saved] = await Promise.all([
    firstPage.waitForEvent("download"),
    firstPage.locator("#downloads a").click(),
  ]);
  assert.equal(await saved.failure(), null);
  await firstPage.screenshot({
    path: resolve(artifacts, "client-ui-native-chat.png"),
    fullPage: true,
  });
  await firstPage.setViewportSize({ width: 375, height: 812 });
  await firstPage.screenshot({
    path: resolve(artifacts, "client-ui-native-chat-mobile.png"),
    fullPage: true,
  });
  assert.equal(await viewButton("chat").isVisible(), true);
  assert.equal(
    await firstPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await firstPage.setViewportSize({ width: 1360, height: 900 });
  checks.nativeAttachmentUploadAndDownload = true;
  await viewButton("dom").click();
  await ready(firstPage, "client-1");
  assert.equal(await firstPage.evaluate(() => window.__samePage), true);
  await firstPage.evaluate(() =>
    fetch("/s/client-1/uploads/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: "fixture-client-1" }),
    }),
  );
  await firstPage.getByRole("button", { name: "选择本机文件" }).waitFor();
  await firstPage.locator("#local-file-picker").setInputFiles([
    { name: "DOM附件一.txt", mimeType: "text/plain", buffer: Buffer.from("附件一") },
    { name: "DOM附件二.txt", mimeType: "text/plain", buffer: Buffer.from("附件二") },
  ]);
  await firstPage.getByText("附件已传至远端，请等待官网处理完成", { exact: true }).waitFor();
  assert.equal(uploadedFiles.at(-2).name, "DOM附件一.txt");
  assert.equal(uploadedFiles.at(-1).text, "附件二");
  await firstPage.locator("#upload-panel button").click();
  await viewButton("px").click();
  await firstPage.locator('#shell-bar [data-view-mode="px"][aria-pressed="true"]').waitFor();
  await firstPage.evaluate(() =>
    fetch("/s/client-1/uploads/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: "fixture-client-1" }),
    }),
  );
  await firstPage.getByRole("button", { name: "选择本机文件" }).waitFor();
  await firstPage.locator("#local-file-picker").setInputFiles({
    name: "图像附件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("图像模式中文附件"),
  });
  await firstPage.getByText("附件已传至远端，请等待官网处理完成", { exact: true }).waitFor();
  assert.equal(uploadedFiles.at(-1).text, "图像模式中文附件");
  await firstPage.locator("#upload-panel button").click();
  await viewButton("dom").click();
  await firstPage.locator('#shell-bar [data-view-mode="dom"][aria-pressed="true"]').waitFor();
  checks.domAndPixelAttachmentUploads = true;
  checks.refreshReusesSessionAndChatScope = true;
  checks.actualThreeModeNavigation = true;

  const thirdPage = await context.newPage();
  await thirdPage.goto(`${origin}/?new=1`);
  await thirdPage.getByRole("heading", { name: "会话名额已占用" }).waitFor();
  assert.equal(
    await thirdPage.locator("#client-session-overlay").getAttribute("data-phase"),
    "error",
  );
  assert.match(
    await thirdPage.locator("#client-session-overlay").innerText(),
    /历史、设置和额度共享/,
  );
  const ownedLinks = await thirdPage
    .locator(".owned-client-sessions a")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")).sort());
  assert.deepEqual(ownedLinks, ["/?sid=client-1", "/?sid=client-2"]);
  const thirdKey = creates.at(-1).clientKey;
  assert.notEqual(thirdKey, firstRequest.clientKey);
  assert.notEqual(thirdKey, secondRequest.clientKey);
  const beforeRetry = creates.length;
  const retryResponse = thirdPage.waitForResponse(
    (response) =>
      response.url().endsWith("/api/client/session") && response.request().method() === "POST",
  );
  await thirdPage.locator("#client-session-retry").click();
  assert.equal((await retryResponse).status(), 503);
  assert.equal(creates.length, beforeRetry + 1);
  assert.equal(creates.at(-1).clientKey, thirdKey);
  assert.equal(connections.filter((connection) => !connection.closed).length, 2);
  checks.capacityOverlayOwnedLinksAndStableRetry = true;

  await firstPage.locator("#shell-menu-toggle").click();
  const menu = firstPage.locator("#shell-menu");
  await menu.waitFor();
  await firstPage.waitForFunction(() =>
    document.querySelector("#shell-menu")?.textContent?.includes("在线设备2"),
  );
  assert.match(await menu.innerText(), /1\.2 \/ 1\.9 GiB/);
  assert.equal(
    await firstPage.locator("#presence-chrome").count(),
    0,
    "Independent clients show legacy shared driver UI",
  );
  const readyStatusRequests = await firstPage.evaluate(
    () =>
      window.__clientUiTrace.filter(
        (entry) => entry.kind === "api-call" && entry.path === "/api/status",
      ).length,
  );
  const capacityStatusRequests = await thirdPage.evaluate(
    () =>
      window.__clientUiTrace.filter(
        (entry) => entry.kind === "api-call" && entry.path === "/api/status",
      ).length,
  );
  cpuPercent = 47;
  broadcastStatus();
  await firstPage.waitForFunction(() =>
    document.querySelector("#shell-menu")?.textContent?.includes("CPU47%"),
  );
  await firstPage.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await thirdPage.waitForFunction(
    (before) =>
      window.__clientUiTrace.filter(
        (entry) => entry.kind === "api-call" && entry.path === "/api/status",
      ).length > before,
    capacityStatusRequests,
  );
  assert.equal(
    await firstPage.evaluate(
      () =>
        window.__clientUiTrace.filter(
          (entry) => entry.kind === "api-call" && entry.path === "/api/status",
        ).length,
    ),
    readyStatusRequests,
    "Ready page also polls HTTP status",
  );
  checks.liveWebSocketStatusAndCapacityHttpPolling = true;

  await firstPage.bringToFront();
  const headerHeight = await firstPage
    .locator("#shell-bar")
    .evaluate((header) => header.getBoundingClientRect().height);
  for (const socket of wss.clients) {
    if (socket.readyState === 1)
      socket.send(JSON.stringify({ t: "px-capacity", available: false }));
  }
  await firstPage.waitForFunction(
    () => document.querySelector('#shell-bar [data-view-mode="px"]')?.disabled === true,
  );
  assert.equal(
    await firstPage
      .locator("#shell-bar")
      .evaluate((header) => header.getBoundingClientRect().height),
    headerHeight,
  );
  for (const socket of wss.clients) {
    if (socket.readyState === 1) socket.send(JSON.stringify({ t: "px-capacity", available: true }));
  }
  await firstPage.waitForFunction(
    () => document.querySelector('#shell-bar [data-view-mode="px"]')?.disabled === false,
  );
  checks.pixelCapacityDisablesAndRestoresWithoutToolbarResize = true;

  await captureHeader(firstPage, "desktop", { width: 1360, height: 900 });
  await captureHeader(firstPage, "mobile", { width: 375, height: 812 });
  await firstPage.locator("#shell-menu-toggle").click();
  await firstPage.locator("#shell-menu").getByRole("button", { name: "深色", exact: true }).click();
  await firstPage.locator('#shell[data-theme="dark"]').waitFor();
  await firstPage.locator("#shell-menu").getByRole("button", { name: "浅色", exact: true }).click();
  await firstPage.locator('#shell[data-theme="light"]').waitFor();
  await firstPage.keyboard.press("Escape");
  checks.themeToggleKeepsGeometry = true;
  const settledViews = views.length;
  await firstPage.waitForTimeout(400);
  assert.equal(views.length, settledViews, "Toolbar layout causes continuing viewport requests");
  checks.desktopMobileHeaderLayoutAndStableViewport = true;

  assert.equal(await firstPage.locator("#end-client-session").count(), 0);
  assert.equal(await firstPage.locator("#upload-file").count(), 0);
  await firstPage.goto(origin + "/?closed=1");
  await firstPage.request.delete(origin + "/api/client/session/client-1");
  await firstPage.getByRole("heading", { name: "当前会话已结束" }).waitFor();
  const closedCreates = creates.length;
  const closedUpgrades = events.filter((event) => event.kind === "ws-upgrade").length;
  await firstPage.waitForTimeout(750);
  assert.equal(creates.length, closedCreates, "Ended UI automatically reclaimed a slot");
  assert.equal(
    events.filter((event) => event.kind === "ws-upgrade").length,
    closedUpgrades,
    "Ended UI kept reconnecting",
  );
  await firstPage.reload();
  await firstPage.getByRole("heading", { name: "当前会话已结束" }).waitFor();
  await firstPage.waitForTimeout(650);
  assert.equal(creates.length, closedCreates, "Reloading closed=1 allocated a session");
  assert.equal(slots.size, 1);
  checks.redundantToolbarButtonsRemovedAndClosedPageDoesNotReconnect = true;

  await firstPage.locator("#client-session-reopen").click();
  await ready(firstPage, "client-1");
  assert.equal(creates.length, closedCreates + 1);
  assert.notEqual(creates.at(-1).clientKey, firstRequest.clientKey);
  assert.notEqual(creates.at(-1).clientKey, secondRequest.clientKey);
  assert.equal(slots.size, 2);
  assert.equal(new URL(firstPage.url()).searchParams.has("new"), false);
  checks.explicitReopenGetsNewKeyAndReleasedSlot = true;

  await thirdPage.goto(`${origin}/?sid=client-1`);
  await ready(thirdPage, "client-1");
  await firstPage.getByRole("heading", { name: "此会话已在另一页面打开" }).waitFor();
  assert.equal(
    await firstPage.locator("#client-session-overlay").getAttribute("data-phase"),
    "replaced",
  );
  assert.equal(await firstPage.locator("#mirror-host iframe, #mirror-host canvas").count(), 0);
  assert.equal(await firstPage.locator("#mirror-host").evaluate((host) => host.inert), true);
  assert.match(await firstPage.locator(".client-session-actions").innerText(), /另开独立会话/);
  const replacedCreates = creates.length;
  const replacedUpgrades = events.filter((event) => event.kind === "ws-upgrade").length;
  await firstPage.waitForTimeout(1_200);
  assert.equal(creates.length, replacedCreates, "Replaced page automatically reallocates");
  assert.equal(
    events.filter((event) => event.kind === "ws-upgrade").length,
    replacedUpgrades,
    "Replaced page fights the new owner by reconnecting",
  );
  assert.equal(connections.filter((entry) => entry.sid === "client-1" && !entry.closed).length, 1);
  checks.replacedPageTearsDownWithoutReclaiming = true;
  assert.deepEqual(pageErrors, []);
  assert.equal(events.filter((event) => event.kind === "fixture-error").length, 0);
} catch (error) {
  failure = error;
  if (firstPage && !firstPage.isClosed()) {
    await firstPage
      .screenshot({ path: resolve(artifacts, "client-ui-failure.png") })
      .catch(() => {});
  }
} finally {
  if (statusTimer) clearInterval(statusTimer);
  firstCreateGate.release();
  heldDelete?.release();
  await browser?.close().catch(() => {});
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolveClose) => wss.close(resolveClose));
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  clearTimeout(watchdog);
  const report = {
    fixtureOnly: true,
    checks,
    layouts,
    pageErrors,
    creates,
    events,
    failure: failure ? String(failure.stack ?? failure) : null,
  };
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    resolve(artifacts, "client-ui-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      fixtureOnly: true,
      checks,
      screenshots: Object.keys(layouts),
      failure: report.failure,
    }),
  );
}
if (failure) throw failure;
