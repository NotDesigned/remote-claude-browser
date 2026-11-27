// A real ProseMirror composer in one temporary Chrome, mirrored to a desktop and a phone viewer
// through the real recorder, replay and gateway input relay. Several messages go out in a row,
// typing on straight after each send: each must reach the page once, as the page's input rules
// made it, the field sync must never fail, and both the page's composer and the one here must end
// up empty. Then one message at a time, sent every way a person sends one (Enter typed at once, a
// soft keyboard's Return with no key event, the send button, Ctrl+Enter, a page that clears after a
// round trip, a Backspace or an autocorrect just after sending): nothing may stay in either one.
//
// Input acks (MIRROR_INPUT_ACKS, "on" unless set) run as the gateway runs them, and the viewer's
// inputlab is checked: every input acknowledged once and in order, none refused, the page's field
// hash matching the replay's at the end of each burst, and the ack's round trip. A slow link
// (scripts/lib/slow-link.mts: SMOKE_RTT_MS, SMOKE_JITTER_MS, SMOKE_STALL_RATE) can sit between
// the gateway and the viewers. "slow-page" has the page apply IME text 400 ms late; "textarea"
// checks that a burst's last value is in the stream before its ack.
//
// SMOKE_INPUT=proxy runs single-writer input (MIRROR_PROXY_INPUT=on: the viewer types into its
// local proxy, the page gets trusted keys and text only); "legacy" (the default) does not.
// SMOKE_DEVICE=desktop|iphone|pixel picks the viewer device (Playwright's descriptors, on
// Chromium); COMPOSER_SMOKE_ONLY=gate runs the P1 gate (scripts/lib/proxy-gate.mts) on it and
// writes its measurements to SMOKE_GATE_OUT when set.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import {
  chromium,
  devices,
  type BrowserContextOptions,
  type CDPSession,
  type FrameLocator,
  type Page,
} from "playwright";
import { proxyGate } from "./lib/proxy-gate.mts";
import { createAgentBundle } from "../packages/agent/dist/index.js";
import {
  ChunkReassembler,
  LOCAL_RESYNC_REASON,
  type AgentMsg,
  type AgentCmdInput,
  type CmdRes,
  type Down,
  type Up,
} from "../packages/protocol/src/index";
import { TabHub } from "../packages/gateway/src/hub/tabhub";
import { createInputRelay, type InputMsg } from "../packages/gateway/src/input/relay";
import { viewerDist } from "./viewer-dist.mjs";
import { describeLink, slowLinkConfig, slowSocket, type SlowSocket } from "./lib/slow-link.mts";
import {
  coverageProblems,
  createAckHarness,
  percentile,
  readLabScript,
  smokeAckMode,
  type AckHarness,
} from "./lib/ack-harness.mts";
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
<input id="secret" type="password" autocomplete="off" style="margin:8px"><div id="thread"></div><textarea id="plain" rows="3" style="width:90%;margin:8px"></textarea><div id="bar"></div>
<script>${composerScript.replaceAll("</script", "<\\/script")}</script>
<script>
// Every keyboard and input event the page gets, with isTrusted: the gate counts them.
window.inputLog = [];
window.untrustedEvents = 0;
for (const type of ["keydown", "keypress", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend", "keyup"])
  document.addEventListener(type, (event) => {
    if (!event.isTrusted) window.untrustedEvents += 1;
    const target = event.target;
    const field = target && target.closest ? target.closest("#composer, #plain, #secret") : null;
    window.inputLog.push({
      type: event.type,
      isTrusted: event.isTrusted,
      inputType: event.inputType,
      data: event.data,
      key: event.key,
      keyCode: event.keyCode,
      target: field ? field.id : "other",
    });
    if (window.inputLog.length > 20000) window.inputLog.shift();
  }, true);
const thread = document.getElementById("thread");
window.sentMessages = [];
const send = (text) => {
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
};
const view = PMComposer.mount(document.getElementById("bar"), { onSend: send });
window.composerView = view;
// A slow page: with window.slowPage set, text typed in (an IME's commit, a paste) is applied by
// the editor 400 ms late, as a page busy with its own work does.
window.slowPage = false;
document.getElementById("bar").addEventListener("beforeinput", (event) => {
  if (!window.slowPage || event.inputType !== "insertText" || !event.data) return;
  event.preventDefault();
  const text = event.data;
  setTimeout(() => view.dispatch(view.state.tr.insertText(text)), 400);
}, true);
// claude.ai may clear its composer only after the message went out (a network round trip):
// with window.clearDelay set, Enter, Ctrl/Cmd+Enter and the send button send now and clear later.
window.clearDelay = null;
const sendLater = () => {
  const text = view.state.doc.textBetween(0, view.state.doc.content.size, "\\n");
  if (text.trim() === "") return;
  send(text);
  setTimeout(() => view.dispatch(view.state.tr.delete(0, view.state.doc.content.size)), window.clearDelay ?? 0);
};
document.getElementById("bar").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  if (window.clearDelay === null && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  sendLater();
}, true);
const button = document.createElement("button");
button.id = "send";
button.type = "button";
button.textContent = "Send";
button.addEventListener("mousedown", (event) => event.preventDefault());
button.addEventListener("click", () => sendLater());
document.getElementById("bar").append(button);
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
const link = slowLinkConfig();
const ackMode = smokeAckMode();
const proxyInput = (process.env.SMOKE_INPUT ?? "legacy") === "proxy";
if (!["proxy", "legacy"].includes(process.env.SMOKE_INPUT ?? "legacy"))
  throw new Error("SMOKE_INPUT must be proxy or legacy");
if (proxyInput && ackMode === "off") throw new Error("SMOKE_INPUT=proxy needs input acks");
const device = process.env.SMOKE_DEVICE ?? "";
if (!["", "desktop", "iphone", "pixel"].includes(device))
  throw new Error("SMOKE_DEVICE must be desktop, iphone or pixel");
console.log(
  `composer-input: ${describeLink(link)}, MIRROR_INPUT_ACKS=${ackMode}, input ${
    proxyInput ? "proxy" : "legacy"
  }${device ? `, ${device}` : ""}`,
);
/** The viewer's browser context for a run. */
const contextFor = (softKeyboard: boolean): BrowserContextOptions => {
  const named = device === "iphone" ? "iPhone 15" : device === "pixel" ? "Pixel 7" : null;
  if (named !== null) {
    const { defaultBrowserType: _browser, ...descriptor } = devices[named]!;
    return descriptor;
  }
  return softKeyboard
    ? { viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1100, height: 800 } };
};
const sockets = new Set<{ raw: any; slow: SlowSocket }>();
const chunks = new ChunkReassembler();
const pending = new Map<number, (reply: CmdRes) => void>();
const failures: string[] = [];
let reqId = 0;
const watchdog = setTimeout(() => process.exit(124), 480_000);
const broadcast = (message: Down) => {
  for (const socket of sockets) socket.slow.send(JSON.stringify(message));
};

interface Mirror {
  label: string;
  softKeyboard: boolean;
  page: Page;
  remote: Page;
  mirrored: FrameLocator;
  type(text: string, delay?: number): Promise<void>;
  compose(pinyin: string, text: string): Promise<void>;
  cdp: CDPSession;
  acks: AckHarness;
  counters: { editableResyncs: number; bytesUp: number; bytesDown: number };
}

/** The text checks; SMOKE_STRICT_TEXT=0 measures them without failing, for experiments. */
const strictText = process.env.SMOKE_STRICT_TEXT !== "0";
const textMisses: string[] = [];
const textCheck = {
  deepEqual(actual: unknown, expected: unknown, message: string) {
    if (strictText) assert.deepEqual(actual, expected, message);
    else if (JSON.stringify(actual) !== JSON.stringify(expected))
      textMisses.push(`${message}: ${JSON.stringify(actual)}`);
  },
  equal(actual: unknown, expected: unknown, message: string) {
    if (strictText) assert.equal(actual, expected, message);
    else if (actual !== expected) textMisses.push(`${message}: ${JSON.stringify(actual)}`);
  },
};

/** What each run measured, for the summary at the end. */
const measured: Array<Record<string, unknown>> = [];

async function run(
  label: string,
  softKeyboard: boolean,
  body: (mirror: Mirror) => Promise<void>,
): Promise<void> {
  const hub = new TabHub({ sessionId: "client-1", tabId: "composer" });
  const remote = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await remote.exposeFunction("__mirror_emit", (payload: string) => {
    const message = chunks.add(payload);
    if (!message) return;
    if (message.kind === "cmdres") {
      pending.get(message.reqId)?.(message);
      return;
    }
    const downs = hub.ingest(message as AgentMsg);
    acks.observe(downs);
    for (const down of downs) broadcast(down);
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
  const acks = createAckHarness({
    mode: ackMode,
    hub: () => hub,
    sendCmd,
    pageText: () =>
      remote.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active?.id === "plain") return (active as HTMLTextAreaElement).value;
        if (active?.closest("#composer")) {
          const view = (window as any).composerView;
          return view.state.doc.textBetween(0, view.state.doc.content.size, "\n") as string;
        }
        return null;
      }),
  });
  let viewport = { w: 390, h: 700 };
  const relay = createInputRelay({
    ...acks.relayDeps,
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
  acks.attach(relay);
  let queue = Promise.resolve();
  const counters = { editableResyncs: 0, bytesUp: 0, bytesDown: 0 };
  const onConnection = (raw: any) => {
    const slow = slowSocket(raw, link);
    const socket: SlowSocket = {
      ...slow,
      send(data) {
        counters.bytesDown += Buffer.byteLength(data);
        slow.send(data);
      },
    };
    const entry = { raw, slow: socket };
    sockets.add(entry);
    acks.route("viewer", (down) => socket.send(JSON.stringify(down)));
    raw.on("close", () => {
      sockets.delete(entry);
      socket.close();
    });
    socket.send(
      JSON.stringify({
        t: "hello",
        viewerId: "viewer",
        role: "driver",
        sessionId: "client-1",
        serverTs: Date.now(),
        ...(acks.caps.length > 0
          ? { caps: proxyInput ? [...acks.caps, "proxyin1"] : acks.caps }
          : {}),
      }),
    );
    socket.send(
      JSON.stringify({
        t: "tabs",
        tabs: [{ id: "composer", title: "Composer", url: remoteUrl, active: true }],
      }),
    );
    for (const down of hub.joinPayload()) socket.send(JSON.stringify(down));
    socket.onMessage((text) => {
      counters.bytesUp += Buffer.byteLength(text);
      const message = JSON.parse(text) as Up;
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
      // As the gateway does: an editor's catch-up is this viewer's alone, from the cached state.
      if (message.t === "resync-req") {
        if (message.reason === LOCAL_RESYNC_REASON) {
          counters.editableResyncs += 1;
          for (const down of hub.joinPayload()) socket.send(JSON.stringify(down));
        } else hub.requestSnapshot("resync");
      }
      if (["ptr", "key", "text", "value", "scroll", "ime"].includes(message.t))
        void relay("viewer", message as InputMsg);
    });
  };
  wss.on("connection", onConnection);
  const context = await browser.newContext(contextFor(softKeyboard));
  await context.addInitScript(() => {
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
  });
  const page: Page = await context.newPage();
  page.on("pageerror", (error) => console.error(`${label} viewer error`, error.message));
  try {
    await page.goto(origin + "/?sid=client-1&inputlab=1");
    await page.waitForFunction(
      () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    );
    const mirrored = page.frameLocator("#mirror-host iframe");
    await mirrored.locator("#composer").waitFor();
    if (proxyInput)
      await page.waitForFunction(() => (window as any).__mirrorInputLab?.caps().proxy === true);
    await mirrored.locator("#composer").click();
    await page.waitForTimeout(400);
    const cdp = await context.newCDPSession(page);
    const type = async (text: string, delay = 40) => {
      if (!softKeyboard) return page.keyboard.type(text, { delay });
      for (const character of text) {
        await page.keyboard.insertText(character);
        await page.waitForTimeout(delay);
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
    await body({
      label,
      softKeyboard,
      page,
      remote,
      mirrored,
      type,
      compose,
      cdp,
      acks,
      counters,
    });
    // The gate records the ack checks with its measurements instead of stopping on them.
    if (body !== gate) await checkAcks(label, body.name, page, acks);
  } finally {
    wss.off("connection", onConnection);
    for (const socket of sockets) {
      socket.slow.close();
      socket.raw.terminate();
    }
    sockets.clear();
    await context.close();
    hub.invalidateDocument();
    await remote.close();
  }
}

/** Several messages in a row, typing on straight after each send. */
async function rounds({ label, page, remote, mirrored, type, compose }: Mirror): Promise<void> {
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
  const pageText = await remote.evaluate(
    () => (window as any).composerView.state.doc.textContent as string,
  );
  console.log(JSON.stringify({ label, sent, composer, pageText, failures }));
  textCheck.deepEqual(sent, expected, `${label}: messages did not reach the page as typed`);
  assert.deepEqual(failures, [], `${label}: the field sync failed`);
  textCheck.equal(pageText, "", `${label}: the page's composer still holds text`);
  textCheck.equal(composer, "", `${label}: the composer here still shows text`);
  console.log(`${label}: a real ProseMirror composer sends each message once and stays in sync.`);
}

/**
 * One message at a time, then nothing more typed: some seconds after sending, the page's own
 * composer and the one here must both be empty. Typed fast and sent at once (the last key's edit
 * still on its way), with the send button, with Ctrl+Enter, after a pinyin composition, and with a
 * page that clears its composer only after a round trip.
 */
async function sends(mirror: Mirror) {
  const { label, softKeyboard, page, remote, mirrored, type, compose, cdp } = mirror;
  const cases: Array<{
    name: string;
    text: Array<string | [string, string]>;
    expected: string;
    how: "enter" | "button" | "ctrl-enter" | "soft-enter";
    /** Right before sending, and right after it (what a soft keyboard does around a send). */
    beforeSend?: () => Promise<void>;
    afterSend?: () => Promise<void>;
    clearDelay: number | null;
    typeDelay?: number;
    pause?: number;
  }> = [
    {
      name: "fast, Enter at once",
      text: ["quick note"],
      expected: "quick note",
      how: "enter",
      clearDelay: null,
      typeDelay: 5,
    },
    {
      name: "Enter, cleared after 300 ms",
      text: ["late clear one"],
      expected: "late clear one",
      how: "enter",
      clearDelay: 300,
    },
    {
      name: "fast, Enter, cleared after 1.5 s",
      text: ["late clear two"],
      expected: "late clear two",
      how: "enter",
      clearDelay: 1_500,
      typeDelay: 5,
    },
    {
      name: "send button",
      text: ["by the button"],
      expected: "by the button",
      how: "button",
      clearDelay: 200,
    },
    {
      name: "send button at once",
      text: ["button at once"],
      expected: "button at once",
      how: "button",
      clearDelay: null,
      typeDelay: 5,
    },
    {
      name: "Ctrl+Enter",
      text: ["with control"],
      expected: "with control",
      how: "ctrl-enter",
      clearDelay: 400,
    },
    {
      name: "pinyin last, Enter",
      text: ["ends in ", ["nihao", "你好"]],
      expected: "ends in 你好",
      how: "enter",
      clearDelay: 600,
    },
    {
      name: "Enter after a pause",
      text: ["waited a while"],
      expected: "waited a while",
      how: "enter",
      clearDelay: 800,
      pause: 1_500,
    },
    // A soft keyboard's Return that comes as text, with no key event.
    {
      name: "Return without a key event",
      text: ["no key event"],
      expected: "no key event",
      how: "soft-enter",
      clearDelay: 300,
    },
    // A predictive keyboard still composing a word when the send button is tapped commits it
    // after the tap, as iOS does on blur.
    {
      name: "send button with a word still composing",
      text: ["hello "],
      expected: "hello wor",
      how: "button",
      clearDelay: 300,
      beforeSend: () => setComposition("wor"),
      afterSend: async () => {
        await page.waitForTimeout(150);
        await cdp.send("Input.insertText", { text: "world" });
      },
    },
    // Autocorrect replacing a word just after the send button took the message.
    {
      name: "autocorrect after the send button",
      text: ["see teh"],
      expected: "see teh",
      how: "button",
      clearDelay: 300,
      afterSend: () => replaceWord("teh", "the", 150),
    },
    {
      name: "autocorrect just after Enter",
      text: ["meet teh"],
      expected: "meet teh",
      how: "enter",
      clearDelay: null,
      afterSend: () => replaceWord("teh", "the", 100),
    },
    {
      name: "Backspace just after Enter",
      text: ["oops typo"],
      expected: "oops typo",
      how: "enter",
      clearDelay: 200,
      afterSend: async () => {
        await page.waitForTimeout(400);
        await page.keyboard.press("Backspace");
      },
    },
  ];
  const setComposition = async (text: string) => {
    for (let length = 1; length <= text.length; length++)
      await cdp.send("Input.imeSetComposition", {
        text: text.slice(0, length),
        selectionStart: length,
        selectionEnd: length,
      });
  };
  /** Selects `word` in the composer here (focusing it again) and types `by` over it. */
  const replaceWord = async (word: string, by: string, delay: number) => {
    await page.waitForTimeout(delay);
    // With single-writer input the composer here is read-only: the word is in the proxy.
    if (proxyInput) {
      const selected = await page.evaluate((word) => {
        const field = document.querySelector("[data-proxy-input]") as HTMLTextAreaElement | null;
        const at = field?.value.lastIndexOf(word) ?? -1;
        if (field === null || at < 0) return false;
        field.focus();
        field.setSelectionRange(at, at + word.length);
        return true;
      }, word);
      if (selected) await cdp.send("Input.insertText", { text: by });
      return;
    }
    const found = await mirrored.locator("#composer").evaluate((editor, word) => {
      const document = editor.ownerDocument;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent!.lastIndexOf(word);
        if (at < 0) continue;
        (editor as HTMLElement).focus();
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
        return true;
      }
      return false;
    }, word);
    if (found) await cdp.send("Input.insertText", { text: by });
  };
  const problems: string[] = [];
  for (const scenario of cases) {
    await remote.evaluate((delay) => ((window as any).clearDelay = delay), scenario.clearDelay);
    const before = await remote.evaluate(() => (window as any).sentMessages.length as number);
    // The send button took focus here; the composer is clicked into again, as a person would.
    const typingHere = proxyInput
      ? await page.evaluate(
          () => document.activeElement?.getAttribute("data-proxy-input") === "true",
        )
      : await mirrored
          .locator("#composer")
          .evaluate((node) => node.ownerDocument.activeElement === node);
    if (!typingHere) {
      await mirrored.locator("#composer").click();
      await page.waitForTimeout(300);
    }
    for (const part of scenario.text)
      await (typeof part === "string" ? type(part, scenario.typeDelay) : compose(part[0], part[1]));
    if (scenario.pause) await page.waitForTimeout(scenario.pause);
    await scenario.beforeSend?.();
    if (scenario.how === "enter") await page.keyboard.press("Enter");
    else if (scenario.how === "soft-enter") {
      // The keyboard's placeholder key, then the Return it types: an insertParagraph alone.
      const placeholder = { key: "Unidentified", keyCode: 229, windowsVirtualKeyCode: 229 };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...placeholder });
      await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...placeholder });
    } else if (scenario.how === "ctrl-enter") await page.keyboard.press("Control+Enter");
    else if (softKeyboard) await mirrored.locator("#send").tap();
    else await mirrored.locator("#send").click();
    await scenario.afterSend?.();
    await page.waitForTimeout(3_500);
    const sent = await remote.evaluate(
      (from) => ((window as any).sentMessages as string[]).slice(from),
      before,
    );
    const pageText = await remote.evaluate(
      () => (window as any).composerView.state.doc.textContent as string,
    );
    const here = (await mirrored.locator("#composer").textContent()) ?? "";
    console.log(JSON.stringify({ label, case: scenario.name, sent, pageText, here }));
    const wrong = [
      ...(JSON.stringify(sent) === JSON.stringify([scenario.expected])
        ? []
        : [`sent ${JSON.stringify(sent)}`]),
      ...(pageText === "" ? [] : [`the page's composer holds ${JSON.stringify(pageText)}`]),
      ...(here === "" ? [] : [`the composer here shows ${JSON.stringify(here)}`]),
    ];
    if (wrong.length > 0) problems.push(`${label}, ${scenario.name}: ${wrong.join("; ")}`);
    // The next case starts from an empty composer on both sides.
    if (pageText !== "") {
      await remote.evaluate(() => {
        const view = (window as any).composerView;
        view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
      });
      await page.waitForTimeout(2_000);
    }
  }
  textCheck.deepEqual(problems, [], `${label}: a sent message stayed in a composer`);
  assert.deepEqual(failures, [], `${label}: the field sync failed`);
  console.log(`${label}: every way of sending leaves both composers empty.`);
}

/**
 * A page that applies IME text 400 ms late: what was typed reaches it exactly once, and both
 * composers are empty after Enter.
 */
async function slowPage({ label, page, remote, mirrored, type, compose }: Mirror): Promise<void> {
  await remote.evaluate(() => ((window as any).slowPage = true));
  const before = await remote.evaluate(() => (window as any).sentMessages.length as number);
  const expected: string[] = [];
  for (const [index, [start, pinyin, text, end]] of [
    ["slow ", "nihao", "你好", " one"],
    ["late ", "zaijian", "再见", ""],
  ].entries()) {
    await type(start!);
    await compose(pinyin!, text!);
    if (end) await type(end);
    // Enter once the page has applied what was typed (a person reads before sending).
    await page.waitForTimeout(900 + index * 300);
    await page.keyboard.press("Enter");
    expected.push(`${start}${text}${end}`);
    await page.waitForTimeout(1_500);
  }
  await remote.evaluate(() => ((window as any).slowPage = false));
  await page.waitForTimeout(2_000);
  const sent = await remote.evaluate(
    (from) => ((window as any).sentMessages as string[]).slice(from),
    before,
  );
  const pageText = await remote.evaluate(
    () => (window as any).composerView.state.doc.textContent as string,
  );
  const here = (await mirrored.locator("#composer").textContent()) ?? "";
  console.log(JSON.stringify({ label, case: "slow-page", sent, pageText, here }));
  textCheck.deepEqual(
    sent,
    expected,
    `${label}: a slow page did not get each message exactly once`,
  );
  textCheck.equal(pageText, "", `${label}: the slow page's composer still holds text`);
  textCheck.equal(here, "", `${label}: the composer here still shows text after a slow page`);
  console.log(`${label}: a page that applies text late gets it exactly once.`);
}

/** Bursts into a plain textarea: the stream carries each burst's last value before its ack. */
async function textarea({ label, page, remote, mirrored, type }: Mirror): Promise<void> {
  await mirrored.locator("#plain").click();
  await page.waitForTimeout(300);
  const typed: string[] = [];
  for (const burst of ["first burst", " and a second", " then a third, with a comma", " fourth"]) {
    await type(burst, 15);
    typed.push(burst);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1_000);
  const value = await remote.evaluate(
    () => (document.getElementById("plain") as HTMLTextAreaElement).value,
  );
  const here = await mirrored.locator("#plain").inputValue();
  assert.equal(value, typed.join(""), `${label}: the textarea did not get what was typed`);
  textCheck.equal(here, value, `${label}: the textarea here differs from the page's`);
  console.log(`${label}: a plain textarea follows bursts of typing.`);
}

/** The ack checks for one run (nothing to check with MIRROR_INPUT_ACKS=off but that none came). */
async function checkAcks(label: string, name: string, page: Page, acks: AckHarness) {
  await page.waitForTimeout(500);
  await acks.settle();
  const report = await page.evaluate(readLabScript, "composer");
  if (acks.mode === "off") {
    assert.equal(report.acks.length, 0, `${label} ${name}: acks came with MIRROR_INPUT_ACKS=off`);
    assert.equal(report.stamped, 0, `${label} ${name}: input was stamped without ack1`);
    return;
  }
  const finals = report.settled.filter((settled) => settled.final);
  const compared = finals.filter((settled) => settled.localHash !== undefined && settled.edit);
  const matched = compared.filter((settled) => settled.localHash === settled.edit!.hash).length;
  const finalRtt = finals.flatMap((settled) => (settled.rtt === undefined ? [] : [settled.rtt]));
  const result = {
    label,
    run: name,
    link: describeLink(link),
    mode: acks.mode,
    stamped: report.stamped,
    acks: acks.sent.length,
    fences: acks.scheduler()?.fenceCount() ?? 0,
    finals: finals.length,
    fencesPerBurst:
      finals.length === 0
        ? null
        : Number(((acks.scheduler()?.fenceCount() ?? 0) / finals.length).toFixed(2)),
    maxAckBytes: Math.max(0, ...acks.sent.map((entry) => entry.bytes)),
    pageHash: `${acks.pageHash.match}/${acks.pageHash.match + acks.pageHash.mismatch}`,
    replayHash: `${matched}/${compared.length}`,
    textareaOrder: acks.ordering,
    windowCloseP95: percentile(finalRtt, 0.95),
    fenceP95: percentile(acks.fenceTimes, 0.95),
    guard: acks.guard,
    dispatchOnly: report.stats.dispatchOnlyAcks,
    decayWhileOutstanding: report.stats.decayWhileOutstanding,
    ackRtt: [report.stats.ackRttP50, report.stats.ackRttP95],
  };
  measured.push(result);
  console.log(`acks ${JSON.stringify(result)}`);
  assert.deepEqual(
    coverageProblems(report).slice(0, 5),
    [],
    `${label} ${name}: inputs not acknowledged once`,
  );
  assert.equal(report.stats.dispatchOnlyAcks, 0, `${label} ${name}: acks without a fence`);

  assert.deepEqual(
    acks.sent.filter((entry) => entry.viewerId !== "viewer"),
    [],
    `${label} ${name}: acks went to another viewer`,
  );
  assert.equal(acks.ordering.outOfOrder, 0, `${label} ${name}: a value came after its ack`);
  // At the end of each burst the page reports its own field's text: all of it for the textarea,
  // at least 99 % for ProseMirror (which may still be rendering). Over a lossy link input
  // arrives in bursts after each stall, and the text is read after the ack went out: the next
  // burst can already be in it, so 85 % there.
  const hashed = acks.pageHash.match + acks.pageHash.mismatch;
  const least = name === "textarea" ? 1 : link.lossRate > 0 ? 0.85 : 0.99;
  if (hashed > 0)
    assert.ok(
      acks.pageHash.match / hashed >= least,
      `${label} ${name}: the page's final hashes matched its text ${result.pageHash}`,
    );
  const budget = link.rttMs + link.jitterMs + 150;
  // Single-writer input has no echo window: its prediction goes with each page ack, not the
  // burst's final one.
  if (!proxyInput && link.stallRate === 0 && link.lossRate === 0 && result.windowCloseP95 !== null)
    assert.ok(
      result.windowCloseP95 <= budget,
      `${label} ${name}: the echo window closed after ${result.windowCloseP95} ms (p95)`,
    );
}

/** The P1 gate on SMOKE_DEVICE (desktop unless set): measured, judged by p1-gate.sh. */
async function gate(mirror: Mirror): Promise<void> {
  const result = await proxyGate({
    ...mirror,
    device: device || "desktop",
    proxy: proxyInput,
    failures,
  });
  let ackChecks = "ok";
  try {
    await checkAcks(mirror.label, "gate", mirror.page, mirror.acks);
  } catch (error) {
    ackChecks = error instanceof Error ? error.message : String(error);
  }
  const record = {
    link: describeLink(link),
    rttMs: link.rttMs,
    lossRate: link.lossRate,
    ackChecks,
    ackSummary: measured.at(-1) ?? null,
    ...result,
  };
  console.log(`GATE ${JSON.stringify(record)}`);
  if (process.env.SMOKE_GATE_OUT)
    await writeFile(process.env.SMOKE_GATE_OUT, JSON.stringify(record));
}

// COMPOSER_SMOKE_ONLY=Desktop,rounds (any of Desktop, Phone, rounds, sends, slow-page, textarea)
// runs part of it; COMPOSER_SMOKE_ONLY=gate runs only the gate.
const only = (process.env.COMPOSER_SMOKE_ONLY ?? "").split(",").filter(Boolean);
const phone = device === "iphone" || device === "pixel";
const runs: Array<[string, boolean, (mirror: Mirror) => Promise<void>, string]> = [
  ["Desktop", false, rounds, "rounds"],
  ["Phone", true, rounds, "rounds"],
  ["Desktop", false, sends, "sends"],
  ["Phone", true, sends, "sends"],
  ["Desktop", false, slowPage, "slow-page"],
  ["Desktop", false, textarea, "textarea"],
];
try {
  if (only.includes("gate")) await run(phone ? "Phone" : "Desktop", phone, gate);
  else
    for (const [label, soft, body, name] of runs)
      if (only.every((part) => part === label || part === name)) await run(label, soft, body);
  console.log(`composer-input acks: ${JSON.stringify(measured)}`);
  if (!strictText)
    console.log(
      `composer-input text over ${describeLink(link)} (measured, not enforced): ${
        textMisses.length === 0 ? "all exact" : JSON.stringify(textMisses)
      }`,
    );
} finally {
  clearTimeout(watchdog);
  await browser.close();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
}
