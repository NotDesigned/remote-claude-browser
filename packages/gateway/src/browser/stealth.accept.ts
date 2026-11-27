/**
 * Can a website tell that the page view is recording it? Real-Chrome acceptance, judged the way a
 * site would judge it: the same Chrome loads the same probe pages twice,
 *   - run C (clean): no recorder is injected;
 *   - run M (mirrored): the production injection, bridge and input relay, default flags;
 * and the page's own fingerprint (scripts/fixtures/stealth/detector.js) of run M is compared with
 * run C's. Whatever differs is a leak.
 *
 * stealth-baseline.json lists the leaks known and owned by a later phase. The test fails when a leak
 * appears that is not listed, and also when a listed one is gone: a fix deletes its entry. One more
 * run with MIRROR_AGENT_HARDENING=0 (and MIRROR_ASSET_DIRECT_FALLBACK=all) must reproduce
 * stealth-baseline.legacy.json, the leaks as they were before the hardening, which proves the kill
 * switch restores the old behaviour.
 *
 * Run from the repository root after building @mirror/agent:
 *   pnpm run test:stealth
 * STEALTH_WRITE_BASELINE=1 rewrites the baseline of each run instead of checking it (reasons are
 * kept for keys already listed). It never prints what a page shows or what was typed.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventType, IncrementalSource, type AgentMsg } from "@mirror/protocol";
import { Agent } from "undici";

import { createAssetFetcher } from "../assets/fetch";
import { createInputRelay, type InputMsg } from "../input/relay";
import type { TargetRef } from "../types";
import { createAgentLink } from "./agentlink";
import { callAgentBridge, callFrameAgent } from "./bridge";
import { launchBrowser, type BrowserHandle } from "./launch";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const fixtures = join(repo, "scripts/fixtures/stealth");
const BASELINE = join(here, "stealth-baseline.json");
const LEGACY_BASELINE = join(here, "stealth-baseline.legacy.json");
const TIMEOUT_MS = 20_000;
const VIEWPORT = { w: 1000, h: 800 };
const PAGES = ["top", "zone", "shadow", "cssom", "typing"] as const;
type PageName = (typeof PAGES)[number];
/** CDP domains whose mere enabling a page can notice (console timing, debugger hooks). */
const FORBIDDEN_CDP = /^(Runtime\.enable|Debugger\.enable|Console\.enable|Log\.enable|Profiler\.)/;
/** Probes that are measured, never compared: their entry stays in the baseline as a metric. */
const METRICS = new Set(["perf.longtask:ms"]);

/** Owner and reason for a key, used when (re)writing a baseline. */
function reasonFor(key: string): string {
  if (key.startsWith("msg.any"))
    return "P2-E: a child frame still reports to its parent by message";
  if (key.startsWith("trust.value")) return "P1: value controls are still set from inside the page";
  if (key.startsWith("trust.editable"))
    return "P1: contenteditable text sync still uses execCommand";
  if (key.startsWith("xrealm.tostring")) return "P3: another realm's toString sees the wrappers";
  if (key.startsWith("stack.shape")) return "P3: wrappers add stack frames";
  if (key.startsWith("shadow.composed"))
    return "P3: the closed-root shim really opens closed roots";
  if (METRICS.has(key.split("@")[0]!)) return "metric";
  return "P0-A: today's leak, removed by workstream A";
}

type Fingerprint = Record<string, string | number | boolean>;
type Mode = "clean" | "mirrored" | "legacy";

async function waitFor<T>(description: string, read: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function startXvfb(): Promise<ChildProcess | undefined> {
  if (process.env.DISPLAY) return undefined;
  const displayNumber = 300 + (process.pid % 200);
  const display = `:${displayNumber}`;
  const child = spawn("Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  const failed = await new Promise<boolean>((done) => {
    child.once("error", () => done(true));
    void waitFor("Xvfb", async () => {
      try {
        await access(`/tmp/.X11-unix/X${displayNumber}`);
        return true;
      } catch {
        return undefined;
      }
    }).then(
      () => done(false),
      () => done(true),
    );
  });
  if (failed) {
    child.kill("SIGTERM");
    return undefined;
  }
  process.env.DISPLAY = display;
  return child;
}

async function chromePath(): Promise<string> {
  for (const candidate of [process.env.CLAUDE_TEST_CHROME, process.env.CHROME_PATH])
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) return candidate;
  if (existsSync("/usr/bin/google-chrome")) return "/usr/bin/google-chrome";
  const { chromium } = await import("playwright");
  return chromium.executablePath();
}

interface RequestRecord {
  path: string;
  range: boolean;
  /** Browsers always say what kind of fetch it is; a server-side client does not. */
  browser: boolean;
}

function fixtureServer(log: RequestRecord[]): Server {
  return createServer((request: IncomingMessage, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    log.push({
      path,
      range: request.headers.range !== undefined,
      browser: request.headers["sec-fetch-mode"] !== undefined,
    });
    response.setHeader("Cache-Control", "no-store");
    if (path === "/asset.txt") {
      response.setHeader("Content-Type", "text/plain");
      response.end("asset body");
      return;
    }
    const file =
      path === "/prosemirror-composer.js"
        ? join(repo, "scripts/fixtures/prosemirror-composer.js")
        : join(fixtures, path.replace(/^\/+/, ""));
    if (!file.startsWith(fixtures + "/") && !file.endsWith("prosemirror-composer.js")) {
      response.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (body) => {
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
        };
        response.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" });
        response.end(body);
      },
      () => response.writeHead(404).end(),
    );
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

/** Rrweb ids of the elements whose DOM id is listed, from a FullSnapshot. */
function nodeIds(event: unknown, wanted: readonly string[]): Map<string, number> {
  const ids = new Map<string, number>();
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const node = value as { id?: unknown; attributes?: { id?: unknown }; childNodes?: unknown[] };
    const domId = node.attributes?.id;
    if (typeof node.id === "number" && typeof domId === "string" && wanted.includes(domId))
      ids.set(domId, node.id);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit((event as { data?: { node?: unknown } }).data?.node);
  return ids;
}

interface RunResult {
  fingerprints: Map<PageName, Fingerprint>;
  checks: string[];
}

async function runMode(
  mode: Mode,
  executablePath: string,
  headful: boolean,
  topPort: number,
  childPort: number,
  log: RequestRecord[],
): Promise<RunResult> {
  const mirrored = mode !== "clean";
  if (mode === "legacy") {
    process.env.MIRROR_AGENT_HARDENING = "0";
    process.env.MIRROR_ASSET_DIRECT_FALLBACK = "all";
  } else {
    delete process.env.MIRROR_AGENT_HARDENING;
    delete process.env.MIRROR_ASSET_DIRECT_FALLBACK;
  }
  process.env.MIRROR_CANVAS_SITES = "127.0.0.1";
  const profile = await mkdtemp(join(tmpdir(), "mirror-stealth-"));
  const browser: BrowserHandle = await launchBrowser({
    executablePath,
    headful,
    userDataDir: profile,
  });
  const rawSend = browser.send;
  const sent = new Set<string>();
  browser.send = (sessionId, method, params) => {
    sent.add(method);
    return rawSend(sessionId, method, params);
  };
  const targets = new Map<string, TargetRef>();
  browser.onAttached((target) => {
    targets.set(target.targetId, target);
    // Without a recorder nothing resumes the frames Chromium holds for the debugger.
    if (!mirrored)
      void rawSend(target.sessionId, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
  });
  const link = mirrored ? createAgentLink(browser) : undefined;
  const fingerprints = new Map<PageName, Fingerprint>();
  const checks: string[] = [];
  const evaluate = async <T>(sessionId: string, expression: string): Promise<T> => {
    const reply = (await rawSend(sessionId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (reply.exceptionDetails !== undefined)
      throw new Error(`probe failed: ${reply.exceptionDetails.text ?? "exception"}`);
    return reply.result?.value as T;
  };

  try {
    const page = await waitFor("page target", () =>
      [...targets.values()].find((target) => target.type === "page"),
    );
    await rawSend(page.sessionId, "Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.w,
      height: VIEWPORT.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Everything the recorder streams, kept for the checks below.
    const hellos: string[] = [];
    const snapshots: unknown[] = [];
    const fontEvents: string[] = [];
    const incremental: Array<{ source: number; json: string }> = [];
    if (link !== undefined)
      void (async () => {
        for await (const message of link.msgs(page.targetId) as AsyncIterable<AgentMsg>) {
          if (message.kind === "hello") hellos.push(message.url);
          if (message.kind !== "rrweb") continue;
          if (message.e.type === EventType.FullSnapshot) snapshots.push(message.e);
          if (message.e.type === EventType.IncrementalSnapshot)
            incremental.push({ source: message.e.data.source, json: JSON.stringify(message.e) });
          // rrweb's own font events (collectFonts), which the replayer adds to its document.
          if (
            message.e.type === EventType.IncrementalSnapshot &&
            message.e.data.source === IncrementalSource.Font
          )
            fontEvents.push(message.e.data.family);
        }
      })().catch(() => undefined);

    for (const name of PAGES) {
      const url = `http://127.0.0.1:${topPort}/${name}.html?child=${childPort}`;
      await rawSend(page.sessionId, "Page.navigate", { url });
      await waitFor(`${name} loaded`, async () => {
        try {
          return await evaluate<boolean>(
            page.sessionId,
            `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`,
          );
        } catch {
          return undefined;
        }
      });
      if (link !== undefined) await waitFor(`${name} recorder`, () => hellos.includes(url));
      // Frames stitch, fonts load and the recorder settles.
      await sleep(600);

      if (link !== undefined && name === "top") {
        const before = snapshots.length;
        assert.equal((await link.sendCmd(page.targetId, { cmd: "snapshot" })).ok, true);
        const snapshot = await waitFor("snapshot", () => snapshots[before]);
        // A font the page added from script after load still reaches the replay: in the snapshot's
        // CSS (font-capture.ts) or as rrweb's own font event.
        checks.push(
          JSON.stringify(snapshot).includes("fx-late-font")
            ? "late font in snapshot"
            : fontEvents.includes("fx-late-font")
              ? "late font as a font event"
              : "FAIL: the late font never reached the replay",
        );
      }
      if (link !== undefined && name === "typing")
        checks.push(...(await driveTyping(browser, link, page, snapshots, evaluate)));
      // Changes made by script once recording runs, in every run so the pages stay alike. The
      // hardened recorder observes them in other ways (prototype setters, microtasks), and they
      // must still reach the replay.
      if (name === "cssom") {
        const before = incremental.length;
        await evaluate(page.sessionId, SCRIPTED_CHANGES);
        if (link !== undefined) checks.push(await scriptedChangesArrived(incremental, before));
      }

      const result = await evaluate<{ own: Fingerprint; frames: Record<string, Fingerprint> }>(
        page.sessionId,
        `__fx.collect({ deep: ${name === "top" || name === "shadow"} })`,
      );
      const fingerprint: Fingerprint = { ...result.own };
      for (const [frame, values] of Object.entries(result.frames))
        for (const [key, value] of Object.entries(values)) fingerprint[`${key}@${frame}`] = value;
      fingerprints.set(name, fingerprint);
    }

    // Lane B: an asset the browser could not load must not be fetched by the server itself
    // (its TLS and headers are not the browser's), except a Range request.
    const lanePage = fingerprints.get("top")!;
    if (mirrored) {
      const fetcher = createAssetFetcher({
        send: browser.send,
        sessionFor: () => page.sessionId,
        // A frame the browser does not have: the browser's own fetch fails.
        frameFor: () => "no-such-frame",
        directDispatcher: () => new Agent(),
      });
      const ref = {
        url: `http://127.0.0.1:${topPort}/asset.txt`,
        sessionId: "stealth",
        tabId: page.targetId,
        documentUrl: `http://127.0.0.1:${topPort}/top.html`,
      };
      for (const range of [undefined, "bytes=0-3"]) {
        try {
          const response = await fetcher.fetch(range === undefined ? { ref } : { ref, range });
          response.body.resume();
        } catch {
          // Refused: the route answers 502.
        }
      }
      await fetcher.close();
    }
    lanePage["net.laneB:nonRange"] = log.some(
      (entry) => entry.path === "/asset.txt" && !entry.browser && !entry.range,
    );
    for (const method of [...sent].filter((method) => FORBIDDEN_CDP.test(method)).sort())
      lanePage[`cdp.footprint:${method}`] = true;
    log.length = 0;
    return { fingerprints, checks };
  } finally {
    await browser.close();
    await rm(profile, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** After load: sheets adopted by the document and by a shadow root, and a value set by script. */
const SCRIPTED_CHANGES = `(async () => {
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("p { word-spacing: 3px; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const inner = new CSSStyleSheet();
  inner.replaceSync("b { word-spacing: 4px; }");
  const input = document.createElement("input");
  document.body.append(input);
  await pause(100);
  root.adoptedStyleSheets = [inner];
  input.value = "set by script";
  await pause(50);
  return true;
})()`;

async function scriptedChangesArrived(
  incremental: ReadonlyArray<{ source: number; json: string }>,
  from: number,
): Promise<string> {
  const wanted = [
    ["the document's adopted sheet", IncrementalSource.AdoptedStyleSheet, "word-spacing: 3px"],
    ["a shadow root's adopted sheet", IncrementalSource.AdoptedStyleSheet, "word-spacing: 4px"],
    ["a value set by script", IncrementalSource.Input, "set by script"],
  ] as const;
  const missing = () =>
    wanted.filter(
      ([, source, text]) =>
        !incremental
          .slice(from)
          .some((event) => event.source === source && event.json.includes(text)),
    );
  await waitFor("scripted changes", () => missing().length === 0).catch(() => undefined);
  const left = missing();
  return left.length === 0
    ? "scripted sheets and values recorded"
    : `FAIL: not recorded: ${left.map(([label]) => label).join(", ")}`;
}

/** Typing, value sync, scrolling and a click, as a viewer sends them, through the real relay. */
async function driveTyping(
  browser: BrowserHandle,
  link: ReturnType<typeof createAgentLink>,
  page: TargetRef,
  snapshots: unknown[],
  evaluate: <T>(sessionId: string, expression: string) => Promise<T>,
): Promise<string[]> {
  const checks: string[] = [];
  const before = snapshots.length;
  assert.equal((await link.sendCmd(page.targetId, { cmd: "snapshot" })).ok, true);
  const snapshot = await waitFor("typing snapshot", () => snapshots[before]);
  const ids = nodeIds(snapshot, ["inp", "ce", "scroller"]);
  assert.equal(ids.size, 3, "typing fixture ids");
  const relay = createInputRelay({
    agentLink: link,
    send: browser.send,
    callBridge: (session, method, args) => callAgentBridge(browser, session, method, args),
    callFrame: (session, frame, method, args) =>
      callFrameAgent(browser, session, frame, method, args),
    sessionFor: (tab) => (tab === page.targetId ? page.sessionId : undefined),
    isDriver: () => true,
    allowsInput: () => true,
    noteInput: () => undefined,
    viewportFor: () => VIEWPORT,
  });
  const tab = page.targetId;
  const send = async (message: InputMsg) => {
    if (!(await relay("viewer", message))) checks.push(`FAIL: relay refused ${message.t}`);
  };
  const key = async (value: string, code: string) => {
    await send({ t: "key", tab, kind: "down", key: value, code, mods: 0 });
    await send({ t: "key", tab, kind: "up", key: value, code, mods: 0 });
  };
  const click = async (nodeId: number) => {
    const ptr = { t: "ptr", tab, nodeId, rx: 0.5, ry: 0.5, vx: 0, vy: 0, button: 0, mods: 0 };
    await send({ ...ptr, kind: "down", buttons: 1 } as InputMsg);
    await send({ ...ptr, kind: "up", buttons: 0 } as InputMsg);
  };
  await click(ids.get("ce")!);
  await key("a", "KeyA");
  await key("b", "KeyB");
  await key("Backspace", "Backspace");
  await key("Enter", "Enter");
  await send({ t: "text", tab, insert: "xy" });
  await send({ t: "ime", tab, text: "zhongwen", selStart: 8, selEnd: 8 });
  await send({ t: "text", tab, insert: "中文" });
  await send({ t: "value", tab, nodeId: ids.get("ce")!, value: "fx" });
  await send({ t: "value", tab, nodeId: ids.get("inp")!, value: "typed" });

  // A viewer reports its scroller as it moves: where it is, then 400 px further up.
  const start = await evaluate<{ stuck: boolean; top: number; bottom: number }>(
    page.sessionId,
    "__fx.scroll()",
  );
  const scroller = ids.get("scroller")!;
  await send({ t: "scroll", tab, nodeId: scroller, x: 0, y: start.top });
  await send({ t: "scroll", tab, nodeId: scroller, x: 0, y: start.top - 400 });
  const end = await waitFor("scroll to settle", async () => {
    await sleep(300);
    const state = await evaluate<{ stuck: boolean; top: number; bottom: number }>(
      page.sessionId,
      "__fx.scroll()",
    );
    return Math.abs(state.top - (start.top - 400)) <= 2 ? state : undefined;
  }).catch(() => undefined);
  checks.push(
    end === undefined
      ? "FAIL: the scroller did not land 400 px up"
      : end.stuck
        ? "FAIL: the page still follows its end after a person scrolled up"
        : "scrolled up and the page let go of its end",
  );
  return checks;
}

/** Keys whose values differ between the runs, over every page. */
function leaks(clean: RunResult, mirrored: RunResult): Map<string, string> {
  const found = new Map<string, string>();
  for (const page of PAGES) {
    const c = clean.fingerprints.get(page) ?? {};
    const m = mirrored.fingerprints.get(page) ?? {};
    for (const key of new Set([...Object.keys(c), ...Object.keys(m)])) {
      if (METRICS.has(key)) {
        found.set(key, `${page}: metric ${String(m[key])} (clean ${String(c[key])})`);
        continue;
      }
      if (c[key] === m[key]) continue;
      if (!found.has(key))
        found.set(
          key,
          `${page}: clean ${String(c[key]).slice(0, 160)} | mirrored ${String(m[key]).slice(0, 160)}`,
        );
    }
  }
  return found;
}

async function readBaseline(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function checkAgainst(
  label: string,
  path: string,
  found: Map<string, string>,
): Promise<string[]> {
  const baseline = await readBaseline(path);
  if (process.env.STEALTH_WRITE_BASELINE === "1") {
    const next: Record<string, string> = {};
    for (const key of [...found.keys()].sort()) next[key] = baseline[key] ?? reasonFor(key);
    await writeFile(path, JSON.stringify(next, null, 2) + "\n");
    console.log(`stealth ${label}: wrote ${found.size} entries to ${path}`);
    return [];
  }
  const errors: string[] = [];
  for (const [key, detail] of found)
    if (!(key in baseline)) errors.push(`${label}: new leak ${key} — ${detail}`);
  for (const key of Object.keys(baseline))
    if (!found.has(key))
      errors.push(`${label}: ${key} no longer leaks; delete it from ${path.split("/").pop()}`);
  return errors;
}

async function main(): Promise<void> {
  const started = Date.now();
  const log: RequestRecord[] = [];
  const top = fixtureServer(log);
  const child = fixtureServer(log);
  const topPort = await listen(top);
  const childPort = await listen(child);
  const xvfb = await startXvfb();
  const headful = process.env.DISPLAY !== undefined && process.env.STEALTH_HEADLESS !== "1";
  const executablePath = await chromePath();
  const errors: string[] = [];
  try {
    const clean = await runMode("clean", executablePath, headful, topPort, childPort, log);
    for (const mode of ["mirrored", "legacy"] as const) {
      const mirrored = await runMode(mode, executablePath, headful, topPort, childPort, log);
      for (const check of mirrored.checks)
        if (check.startsWith("FAIL")) errors.push(`${mode}: ${check}`);
      const found = leaks(clean, mirrored);
      const path = mode === "mirrored" ? BASELINE : LEGACY_BASELINE;
      errors.push(...(await checkAgainst(mode, path, found)));
      const metric = [...found].find(([key]) => METRICS.has(key))?.[1];
      console.log(
        `stealth ${mode}: ${found.size} differing keys (${[...found.keys()].filter((key) => !METRICS.has(key)).length} leaks); ` +
          `checks: ${mirrored.checks.join("; ")}; longest task ${metric ?? "n/a"}`,
      );
    }
  } finally {
    await closeServer(top);
    await closeServer(child);
    xvfb?.kill("SIGTERM");
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(`stealth: FAILED in ${seconds}s`);
    process.exitCode = 1;
    return;
  }
  console.log(`stealth: pages see no recorder beyond the listed baseline (${seconds}s)`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
