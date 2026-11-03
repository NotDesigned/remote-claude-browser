// One isolated Chromium, two local fixture pages. Never connects to the authenticated browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import { createInputRelay } from "../packages/gateway/src/input/relay";
import { createAgentBundle } from "../packages/agent/dist/index.js";
import { ChunkReassembler } from "../packages/protocol/src/index";
import { editableText } from "../packages/protocol/src/index";
import type { Up, Down, eventWithTime } from "../packages/protocol/src/index";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const watchdog = setTimeout(() => process.exit(124), 90000);
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
const root = resolve("packages/viewer/dist");
const editorStyle =
  "position:absolute;left:20px;top:30px;width:400px;height:120px;border:1px solid black;font-size:18px;white-space:pre-wrap";
const remoteHtml = `<!doctype html><html><body style="margin:0"><div id="editor" contenteditable="true" role="textbox" style="${editorStyle}"><p><br></p></div></body></html>`;
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://fixture.test").pathname;
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
          { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
          "application/octet-stream",
      })
      .end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  executablePath: "/opt/claude-test-chrome/chrome",
  headless: true,
});
const wss = new WebSocketServer({ server, path: "/ws" });
let failureDetails: (() => Promise<unknown>) | undefined;
try {
  const remote = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const reassembler = new ChunkReassembler();
  const replies = new Map<number, (reply: any) => void>();
  await remote.exposeFunction("__mirror_emit", (payload: string) => {
    const message = reassembler.add(payload);
    if (message?.kind === "cmdres") replies.get(message.reqId)?.(message);
  });
  await remote.addInitScript({ content: createAgentBundle({ canvas: { enabled: false } }) });
  await remote.goto(origin + "/remote");
  await remote.evaluate((source) => {
    (window as any).__editableText = (0, eval)("(" + source + ")");
  }, editableText.toString());
  await remote.evaluate(() =>
    document.querySelector("#editor")!.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (key.key === "Enter" && !key.shiftKey) {
        event.preventDefault();
        (window as any).__submitted = (window as any).__editableText(event.currentTarget);
      }
    }),
  );
  await remote.waitForFunction(() => typeof (window as any).__mirror_cmd === "function");
  let nextCommand = 0;
  const remoteCdp = await remote.context().newCDPSession(remote);
  const received: Up[] = [],
    dispatches: Promise<unknown>[] = [];
  const relay = createInputRelay({
    send: async (_session, method, params) => remoteCdp.send(method as never, params as never),
    sessionFor: () => "fixture",
    isDriver: () => true,
    allowsInput: () => true,
    noteInput: () => {},
    viewportFor: () => ({ w: 1100, h: 850 }),
    agentLink: {
      async *msgs() {},
      async sendCmd(_tab, cmd) {
        if (cmd.cmd === "resolve") return { reqId: 1, ok: true, data: { kind: "local" } };
        if (cmd.cmd === "rect")
          return { reqId: 1, ok: true, data: { x: 20, y: 30, w: 402, h: 122, visible: true } };
        if (cmd.cmd === "value") {
          const reqId = ++nextCommand;
          const reply = new Promise<any>((resolve) => replies.set(reqId, resolve));
          await remote.evaluate(
            ({ cmd, reqId }) => {
              const w = window as any;
              let nodeId = -1;
              for (let id = 1; id < 1000; id++)
                if (w.__mirror_node(id) === document.querySelector("#editor")) {
                  nodeId = id;
                  break;
                }
              if (nodeId < 0) throw new Error("missing remote recorder id");
              w.__mirror_cmd({ ...cmd, nodeId, reqId });
            },
            { cmd, reqId },
          );
          const response = await reply;
          replies.delete(reqId);
          return response;
        }
        return { reqId: 1, ok: true };
      },
    },
  });
  let width = 1100,
    height = 700,
    seq = 0,
    epoch = 0,
    pixel = "";
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
            attributes: { style: "margin:0" },
            childNodes: [
              {
                type: 2,
                id: 6,
                tagName: "div",
                attributes: {
                  id: "editor",
                  contenteditable: "true",
                  role: "textbox",
                  style: editorStyle,
                },
                childNodes: [],
              },
            ],
          },
        ],
      },
    ],
  };
  let sendAuthoritativeClear = () => {};
  let editableResyncs = 0;
  wss.on("connection", (socket) => {
    let frameTimer: ReturnType<typeof setInterval> | undefined;
    const send = (message: Down) => socket.readyState === 1 && socket.send(JSON.stringify(message));
    const snapshot = (reason: "nav" | "viewport" | "resync") => {
      const timestamp = Date.now();
      send({
        t: "snapshot",
        tab: "fixture",
        epoch: ++epoch,
        seq: ++seq,
        reason,
        data: [
          { type: 4, timestamp, data: { href: origin + "/remote", width, height } },
          { type: 2, timestamp, data: { node: document, initialOffset: { top: 0, left: 0 } } },
        ] as eventWithTime[],
      });
    };
    sendAuthoritativeClear = () =>
      send({
        t: "delta",
        tab: "fixture",
        epoch,
        seq: ++seq,
        data: [
          {
            type: 3,
            timestamp: Date.now(),
            data: {
              source: 0,
              texts: [],
              attributes: [],
              adds: [],
              removes: [{ id: 999, parentId: 6 }],
            },
          },
        ],
      } as Down);
    const frame = () => send({ t: "px", tab: "fixture", data: pixel, w: width, h: height });
    send({
      t: "hello",
      viewerId: "driver",
      role: "driver",
      sessionId: "fixture",
      serverTs: Date.now(),
    });
    send({
      t: "tabs",
      tabs: [{ id: "fixture", title: "Input fixture", url: origin + "/remote", active: true }],
    });
    snapshot("nav");
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Up;
      if (message.t === "ping")
        send({ t: "pong", id: message.id, sentTs: message.sentTs, serverTs: Date.now() });
      if (message.t === "view") {
        width = message.w;
        height = message.h;
        snapshot("viewport");
      }
      if (message.t === "resync-req") {
        editableResyncs++;
        snapshot("resync");
      }
      if (message.t === "mode") {
        clearInterval(frameTimer);
        send(message);
        if (message.mode === "px") {
          frame();
          frameTimer = setInterval(frame, 100);
        } else snapshot("resync");
      }
      if (["ptr", "key", "text", "ime", "value"].includes(message.t)) {
        received.push(message);
        dispatches.push(relay("driver", message as Parameters<typeof relay>[1]));
      }
    });
    socket.on("close", () => clearInterval(frameTimer));
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  pixel = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 2;
    c.getContext("2d")!.fillRect(0, 0, 2, 2);
    return c.toDataURL("image/png");
  });
  const clientCdp = await page.context().newCDPSession(page);
  failureDetails = async () => ({
    received,
    remote: await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    local: await page.evaluate(() => ({
      active: document.activeElement?.tagName,
      editor: document
        .querySelector<HTMLIFrameElement>("#mirror-host iframe")
        ?.contentDocument?.querySelector("#editor")?.textContent,
      trace: (
        document.querySelector<HTMLIFrameElement>("#mirror-host iframe")
          ?.contentDocument as Document & { __imeTrace?: unknown[] }
      )?.__imeTrace,
      proxy: (document.querySelector(".px-ime-input") as HTMLTextAreaElement | null)?.value,
    })),
  });
  await page.goto(origin);
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  const cursor = await page.evaluate(() => {
    const host = document.querySelector("#mirror-host") as HTMLElement,
      el = host.querySelector(".replayer-mouse") as HTMLElement;
    el.style.setProperty("display", "block");
    const driver = getComputedStyle(el).display;
    host.dataset.viewportRole = "follower";
    const follower = getComputedStyle(el).display;
    host.dataset.viewportRole = "driver";
    return {
      driver,
      follower,
      native: host
        .querySelector("iframe")!
        .contentWindow!.getComputedStyle(host.querySelector("iframe")!.contentDocument!.body)
        .cursor,
    };
  });
  assert.equal(cursor.driver, "none");
  assert.notEqual(cursor.follower, "none");
  assert.notEqual(cursor.native, "none");
  const ready = async () => {
    await Promise.all(dispatches);
    await page.waitForTimeout(100);
    await Promise.all(dispatches);
  };
  const compose = async (preedit: string, commit: string) => {
    await clientCdp.send("Input.imeSetComposition", {
      text: preedit,
      selectionStart: preedit.length,
      selectionEnd: preedit.length,
    });
    await clientCdp.send("Input.insertText", { text: commit });
  };
  const typeMixed = async () => {
    await compose("fenxi", "分析");
    await page.keyboard.type("AI");
    await compose("wenti", "问题");
    await ready();
  };
  await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>("#mirror-host iframe")!
      .contentDocument as Document & { __imeTrace: unknown[] };
    doc.__imeTrace = [];
    for (const type of [
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "beforeinput",
      "input",
      "keydown",
      "keyup",
    ]) {
      doc.addEventListener(
        type,
        (e) => {
          const input = e as InputEvent,
            key = e as KeyboardEvent;
          doc.__imeTrace.push({
            type,
            data: input.data,
            inputType: input.inputType,
            composing: input.isComposing,
            trusted: e.isTrusted,
            key: key.key,
            code: key.keyCode,
            target: (e.target as Element)?.tagName,
            editable: (e.target as HTMLElement)?.isContentEditable,
            prevented: e.defaultPrevented,
          });
        },
        true,
      );
    }
  });
  await page.frameLocator("#mirror-host iframe").locator("#editor").click();
  await typeMixed();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    "分析AI问题",
    "DOM must forward all Chinese and English exactly once",
  );
  const domTextMessages = received
    .filter((m) => m.t === "text")
    .map((m) => (m as Extract<Up, { t: "text" }>).insert);
  await clientCdp.send("Input.insertText", { text: "，粘贴中文" });
  await ready();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    "分析AI问题，粘贴中文",
    "DOM native commit after composition must not stay latched",
  );
  const localEditor = page.frameLocator("#mirror-host iframe").locator("#editor");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("rapid selection replacement 123");
  await page.keyboard.press("Shift+ArrowLeft");
  await clientCdp.send("Input.insertText", { text: "中文替换" });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("next line");
  await ready();
  const visibleDraft = await localEditor.innerText();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    visibleDraft,
    "visible local selection, delete and newline must match B",
  );
  await page.keyboard.press("ControlOrMeta+A");
  await clientCdp.send("Input.insertText", { text: "中文😀 e\u0301 家庭👨‍👩‍👧‍👦" });
  await ready();
  await page.keyboard.press("ControlOrMeta+A");
  await clientCdp.send("Input.insertText", { text: "中文😃 e\u0300 家庭👨‍👩‍👧‍👦" });
  await ready();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    await localEditor.innerText(),
    "emoji and combining marks remain intact",
  );
  await page.keyboard.press("ControlOrMeta+A");
  await clientCdp.send("Input.insertText", { text: "分析AI问题，立即发送" });
  await page.keyboard.press("Enter");
  await ready();
  assert.equal(
    await remote.evaluate(() => (window as any).__submitted),
    await localEditor.innerText(),
    "immediate Enter must follow the complete visible draft",
  );
  await remote.locator("#editor").evaluate((element) => {
    element.textContent = "";
  });
  await localEditor.press("ControlOrMeta+A");
  await clientCdp.send("Input.insertText", { text: "分析AI问题，立即发送" });
  await ready();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    "分析AI问题，立即发送",
    "re-entering the same text must synchronize after a remote clear",
  );
  await remote.locator("#editor").evaluate((element) => {
    element.textContent = "";
  });
  await page.waitForTimeout(1100);
  sendAuthoritativeClear();
  await page.waitForFunction(
    () =>
      document
        .querySelector<HTMLIFrameElement>("#mirror-host iframe")
        ?.contentDocument?.querySelector("#editor")?.textContent === "",
  );
  assert.equal(editableResyncs, 1, "authoritative editor clear must reconcile once");
  assert.equal(
    await page
      .frameLocator("#mirror-host iframe")
      .locator("#editor")
      .evaluate((element) => element.ownerDocument.activeElement === element),
    true,
  );
  await page.locator("#view-mode-select").selectOption("px");
  await page.locator("#mirror-host canvas").waitFor();
  await remote.locator("#editor").evaluate((el) => {
    el.textContent = "";
  });
  received.length = 0;
  await page.locator("#mirror-host canvas").click({ position: { x: 90, y: 70 } });
  await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
  await typeMixed();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    "分析AI问题",
    "Pixel IME must reach the remote editor exactly once",
  );
  await clientCdp.send("Input.insertText", { text: "，粘贴中文" });
  await ready();
  assert.equal(
    await remote.locator("#editor").evaluate((el) => (window as any).__editableText(el)),
    "分析AI问题，粘贴中文",
  );
  const pixelTextMessages = received
    .filter((m) => m.t === "text")
    .map((m) => (m as Extract<Up, { t: "text" }>).insert);
  await page.locator("#view-mode-select").selectOption("dom");
  await page.locator("#mirror-host iframe").waitFor();
  assert.equal(await page.locator(".px-ime-input").count(), 0);
  const result = {
    fixtureOnly: true,
    cursor,
    checks: {
      driverUsesNativeCursor: true,
      followerKeepsRemoteCursor: true,
      domChineseEnglishExactlyOnce: true,
      domNativeCommittedInput: true,
      domSelectionReplacementDeleteAndNewlineMatch: true,
      domImmediateSendMatchesVisibleText: true,
      domSubmittedEditorClearsAndKeepsFocus: true,
      pixelLocalImeFocus: true,
      pixelChineseEnglishExactlyOnce: true,
      pixelCommittedInput: true,
      pixelCleanup: true,
    },
    domTextMessages,
    pixelTextMessages,
  };
  await writeFile("artifacts/input-latency-smoke.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (failureDetails)
    console.error("Fixture input diagnostics:", JSON.stringify(await failureDetails()));
  throw error;
} finally {
  clearTimeout(watchdog);
  await browser.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((r) => wss.close(r));
  await new Promise<void>((r) => server.close(() => r()));
}
