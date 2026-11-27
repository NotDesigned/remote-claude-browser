/**
 * Real Chromium with the real agent, for the live tree's acceptance run (../live-tree.accept.ts)
 * and bench (scripts/live-tree-bench.mts): fixture pages, the recorded rrweb stream of one tab,
 * and a second browser that replays streams with the viewer's patched @rrweb/replay and writes
 * out the DOM it built, to compare two replays.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType, resolveSheetRefs, type AgentMsg, type eventWithTime } from "@mirror/protocol";
import { createAgentLink } from "../../browser/agentlink";
import { launchBrowser, type BrowserHandle } from "../../browser/launch";
import type { AgentLink, TargetRef } from "../../types";

const repo = (path: string) => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url));

export const FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>frame</title>
<style>p{margin:2px}</style><body><p id="count">frame 0</p><ul id="list"></ul>
<script>
let n = 0;
addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.op !== "mutate") return;
  for (let i = 0; i < (data.n || 1); i++) {
    n += 1;
    document.getElementById("count").textContent = "frame " + n;
    const list = document.getElementById("list");
    const li = document.createElement("li");
    li.textContent = "item " + n;
    li.className = "c" + (n % 3);
    if (list.children.length > 4 && n % 2) list.firstElementChild.remove();
    list.insertBefore(li, n % 4 ? null : list.firstChild);
  }
});
</script>`;

/** The fuzz page: everything a page can change that rrweb records. */
export const FUZZ_HTML = `<!doctype html><meta charset="utf-8"><title>fuzz</title>
<style id="fuzz-style">.a{color:red} @media (min-width: 1px) { .m{color:blue} } .z{margin:0}</style>
<style id="fuzz-text">.t{color:green}</style>
<div id="fuzz"><p>start <b>bold</b></p><div id="scroller" style="height:60px;overflow:auto"><div style="height:400px">tall</div></div>
<div id="editable" contenteditable="true"><p>edit me</p></div>
<details id="details"><summary>more</summary><p>hidden text</p></details>
<input id="text-input" value="x"><input id="check" type="checkbox"><select id="select"><option value="a">A</option><option value="b">B</option></select><textarea id="area">t</textarea>
</div>
<div id="host"></div>
<iframe id="same" src="/conversation-frame.html?site=same"></iframe>
<iframe id="cross"></iframe>
<script>
const host = document.getElementById("host").attachShadow({ mode: "open" });
host.innerHTML = "<p>shadow <i>root</i></p><div class='inner'></div>";
const docSheet = new CSSStyleSheet();
docSheet.replaceSync(".adopted{color:purple}");
document.adoptedStyleSheets = [docSheet];
const shadowSheet = new CSSStyleSheet();
shadowSheet.replaceSync("p{font-weight:bold}");
host.adoptedStyleSheets = [shadowSheet];
const cross = new URLSearchParams(location.search).get("cross");
if (cross) document.getElementById("cross").src = cross + "/conversation-frame.html?site=cross";
const TAGS = ["div", "span", "p", "b", "i", "ul", "li", "section", "details", "textarea", "input", "select", "pre", "em"];
const WORDS = ["alpha", "beta", "gamma", "delta", "", " ", "x y", "<&>", "tab\\tz"];
const PROPS = ["color", "margin-top", "padding-left", "display", "--v", "border-top-width", "opacity"];
const VALUES = { color: ["red", "rgb(1, 2, 3)"], "margin-top": ["1px", "2em"], "padding-left": ["0px", "3px"], display: ["block", "none", "inline"], "--v": ["1", "a b"], "border-top-width": ["2px"], opacity: ["0.5", "1"] };
window.__fuzz = (seed, count) => {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const roots = () => {
    const list = [document.getElementById("fuzz"), host];
    const frame = document.getElementById("same").contentDocument;
    if (frame && frame.body) list.push(frame.body);
    for (const f of document.querySelectorAll("#fuzz iframe")) if (f.contentDocument && f.contentDocument.body) list.push(f.contentDocument.body);
    return list;
  };
  const elements = () => roots().flatMap((root) => [...(root instanceof ShadowRoot ? [] : [root]), ...root.querySelectorAll("*")]);
  const containers = () => elements().filter((e) => !["INPUT", "TEXTAREA", "SELECT", "IFRAME", "CANVAS", "STYLE", "SCRIPT", "OPTION", "BR"].includes(e.tagName));
  const removable = () => elements().filter((e) => !roots().includes(e) && e.id !== "editable" && e.id !== "scroller");
  const make = (doc) => {
    const tag = pick(TAGS);
    const el = doc.createElement(tag);
    if (tag === "select") for (const v of ["a", "b", "c"]) { const o = doc.createElement("option"); o.value = v; o.textContent = v.toUpperCase(); el.append(o); }
    else if (tag === "input") { if (rnd() < 0.3) el.type = "checkbox"; else el.value = pick(WORDS); }
    else if (tag === "textarea") el.value = pick(WORDS);
    else if (rnd() < 0.6) el.textContent = pick(WORDS);
    if (rnd() < 0.3) el.className = pick(["a", "m", "t", "adopted", "z"]);
    if (rnd() < 0.2) el.setAttribute("style", pick(["margin: 1px 2px; color: red", "padding: 0", "color: blue", "inset: 0; position: relative"]));
    return el;
  };
  const sheet = () => document.getElementById("fuzz-style").sheet;
  let done = 0;
  for (let step = 0; step < count; step++) {
    const r = rnd();
    try {
      if (r < 0.2) {
        const parent = pick(containers());
        const child = make(parent.ownerDocument);
        const ref = parent.childNodes.length && rnd() < 0.6 ? pick([...parent.childNodes]) : null;
        parent.insertBefore(child, ref);
      } else if (r < 0.27) {
        const parent = pick(containers());
        const ref = parent.childNodes.length && rnd() < 0.5 ? pick([...parent.childNodes]) : null;
        parent.insertBefore(parent.ownerDocument.createTextNode(pick(WORDS)), ref);
      } else if (r < 0.36) {
        const list = removable();
        if (list.length > 20) pick(list).remove();
      } else if (r < 0.43) {
        const node = pick(removable());
        const target = pick(containers());
        if (node && target && !node.contains(target) && node.ownerDocument === target.ownerDocument && node.getRootNode() === target.getRootNode()) {
          const ref = target.childNodes.length && rnd() < 0.5 ? pick([...target.childNodes]) : null;
          if (ref !== node) target.insertBefore(node, ref);
        }
      } else if (r < 0.5) {
        const texts = elements().flatMap((e) => [...e.childNodes].filter((n) => n.nodeType === 3 && e.tagName !== "STYLE" && e.tagName !== "TEXTAREA"));
        if (texts.length) pick(texts).data = pick(WORDS);
      } else if (r < 0.58) {
        const el = pick(removable().filter((e) => e.tagName !== "IFRAME"));
        if (el) { if (rnd() < 0.7) el.setAttribute(pick(["class", "title", "data-k", "hidden", "aria-label"]), pick(["a", "m", "", "x y"])); else el.removeAttribute(pick(["class", "title", "data-k", "hidden"])); }
      } else if (r < 0.66) {
        const el = pick(removable());
        if (el && el.style) { const p = pick(PROPS); if (rnd() < 0.7) el.style.setProperty(p, pick(VALUES[p]), rnd() < 0.1 ? "important" : ""); else el.style.removeProperty(p); }
      } else if (r < 0.7) {
        const inputs = elements().filter((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT");
        const el = pick(inputs);
        if (el) {
          if (el.type === "checkbox") el.checked = !el.checked;
          else if (el.tagName === "SELECT") el.value = pick(["a", "b", "c"]);
          else el.value = pick(WORDS);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } else if (r < 0.74) {
        const sh = sheet();
        const q = rnd();
        if (q < 0.4) sh.insertRule(".r" + step + "{color:rgb(" + (step % 255) + ",0,0)}", Math.floor(rnd() * (sh.cssRules.length + 1)));
        else if (q < 0.6 && sh.cssRules.length > 2) sh.deleteRule(Math.floor(rnd() * sh.cssRules.length));
        else if (q < 0.8) { const group = [...sh.cssRules].find((rule) => rule instanceof CSSMediaRule); if (group) { if (rnd() < 0.6) group.insertRule(".n" + step + "{color:teal}", 0); else if (group.cssRules.length > 1) group.deleteRule(0); } }
        else { const styled = [...sh.cssRules].find((rule) => rule.style); if (styled) styled.style.setProperty("color", pick(["red", "green"])); }
      } else if (r < 0.76) {
        document.getElementById("fuzz-text").textContent = ".t{color:" + pick(["green", "red", "blue"]) + "}";
      } else if (r < 0.79) {
        const q = rnd();
        if (q < 0.4) docSheet.replaceSync(".adopted{color:" + pick(["purple", "red"]) + "}");
        else if (q < 0.7) docSheet.insertRule(".ad" + step + "{color:red}", 0);
        else shadowSheet.replaceSync("p{font-weight:" + pick(["bold", "normal"]) + "}");
      } else if (r < 0.82) {
        const scroller = document.getElementById("scroller");
        scroller.scrollTop = Math.floor(rnd() * 300);
      } else if (r < 0.84) {
        const details = elements().filter((e) => e.tagName === "DETAILS");
        if (details.length) { const d = pick(details); d.open = !d.open; }
      } else if (r < 0.88) {
        const editable = document.getElementById("editable");
        const blocks = editable.querySelectorAll("p");
        if (rnd() < 0.6 || blocks.length < 2) { const p = document.createElement("p"); p.textContent = pick(WORDS); editable.append(p); }
        else blocks[0].remove();
      } else if (r < 0.9) {
        const frames = document.querySelectorAll("#fuzz iframe");
        if (frames.length < 2 && rnd() < 0.6) { const f = document.createElement("iframe"); f.srcdoc = "<p>frame " + step + "</p>"; pick(containers().filter((e) => e.ownerDocument === document && !(e.getRootNode() instanceof ShadowRoot))).append(f); }
        else if (frames.length) { const f = pick([...frames]); if (rnd() < 0.5) f.remove(); else f.srcdoc = "<p>again " + step + "</p>"; }
      } else if (r < 0.93) {
        const frame = document.getElementById("cross").contentWindow;
        if (frame) frame.postMessage({ op: "mutate", n: 1 + Math.floor(rnd() * 3) }, "*");
        const same = document.getElementById("same").contentWindow;
        if (same) same.postMessage({ op: "mutate", n: 1 }, "*");
      } else if (r < 0.96) {
        const el = pick(containers().filter((e) => !roots().includes(e)));
        if (el) el.textContent = pick(WORDS);
      } else {
        const inner = host.querySelector(".inner");
        if (inner && rnd() < 0.5) inner.append(make(document));
        else if (host.childNodes.length > 2) host.lastChild.remove();
      }
      done += 1;
    } catch (error) {
      // An operation the page refused (a move into its own child): try the next.
    }
  }
  return done;
};
document.body.dataset.ready = "yes";
</script>`;

export interface FixtureServer {
  origin: string;
  /** The same server under another site, for cross-site frames. */
  crossOrigin: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const longConversation = await readFile(repo("scripts/fixtures/long-conversation.html"), "utf8");
  const composer = await readFile(repo("scripts/fixtures/prosemirror-composer.js"), "utf8");
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("Cache-Control", "no-store");
    const send = (type: string, body: string) => {
      response.setHeader("Content-Type", type);
      response.end(body);
    };
    if (path === "/long") send("text/html", longConversation);
    else if (path === "/fuzz") send("text/html", FUZZ_HTML);
    else if (path === "/conversation-frame.html") send("text/html", FRAME_HTML);
    else if (path === "/prosemirror-composer.js") send("text/javascript", composer);
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    crossOrigin: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One tab of a real browser with the agent, and every rrweb event of its current document. */
export interface RecordedTab {
  browser: BrowserHandle;
  link: AgentLink;
  target: TargetRef;
  /** Agent messages of the current top document, in order. */
  messages: AgentMsg[];
  docId: number;
  navigate(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  /** Asks the page for a FullSnapshot and waits for it (and then for `settleMs`). */
  pageSnapshot(settleMs?: number): Promise<number>;
  close(): Promise<void>;
}

export async function openRecordedTab(chromePath: string): Promise<RecordedTab> {
  const profile = await mkdtemp(join(tmpdir(), "mirror-live-tree-"));
  const browser = await launchBrowser({
    executablePath: chromePath,
    headful: false,
    userDataDir: profile,
  });
  const link = createAgentLink(browser);
  const targets = new Map<string, TargetRef>();
  browser.onAttached((target) => targets.set(target.targetId, target));
  await waitFor("page target", () => [...targets.values()].some((t) => t.type === "page"));
  const target = [...targets.values()].find((t) => t.type === "page")!;
  let stopping = false;
  const tab: RecordedTab = {
    browser,
    link,
    target,
    messages: [],
    docId: 0,
    async navigate(url) {
      const before = tab.docId;
      await browser.send(target.sessionId, "Page.navigate", { url });
      await waitFor(
        "new document and its snapshot",
        () =>
          tab.docId !== before &&
          tab.messages.some((m) => m.kind === "rrweb" && m.e.type === EventType.FullSnapshot),
      );
      await waitFor("fixture ready", () =>
        tab.evaluate<boolean>("document.body?.dataset.ready === 'yes'"),
      );
    },
    async evaluate<T>(expression: string): Promise<T> {
      const response = (await browser.send(target.sessionId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: T }; exceptionDetails?: unknown };
      if (response.exceptionDetails !== undefined)
        throw new Error(
          `evaluation failed: ${expression.slice(0, 200)} ${JSON.stringify(response.exceptionDetails).slice(0, 500)}`,
        );
      return response.result?.value as T;
    },
    async pageSnapshot(settleMs = 600) {
      const count = () =>
        tab.messages.filter((m) => m.kind === "rrweb" && m.e.type === EventType.FullSnapshot)
          .length;
      const before = count();
      await link.sendCmd(target.targetId, { cmd: "snapshot" });
      await waitFor("page snapshot", () => count() > before);
      await sleep(settleMs);
      return tab.messages.length;
    },
    async close() {
      stopping = true;
      await browser.close();
      await rm(profile, { force: true, recursive: true });
    },
  };
  void (async () => {
    try {
      for await (const msg of link.msgs(target.targetId)) {
        if (msg.kind === "hello") {
          if (!msg.isTop || msg.docId === tab.docId) continue;
          tab.docId = msg.docId;
          tab.messages = [msg];
          void link.sendCmd(target.targetId, { cmd: "snapshot" }).catch(() => undefined);
          continue;
        }
        if ((msg.kind === "rrweb" || msg.kind === "fence") && msg.docId === tab.docId)
          tab.messages.push(msg);
      }
    } catch (error) {
      if (!stopping) throw error;
    }
  })();
  return tab;
}

/** The rrweb events of a recorded document. */
export function eventsOf(messages: readonly AgentMsg[]): eventWithTime[] {
  return messages.flatMap((m) => (m.kind === "rrweb" ? [m.e] : []));
}

/** A browser page with the viewer's (patched) Replayer, to replay streams and compare them. */
export interface ReplayedNode {
  attributes: Record<string, string> | null;
  text: string | null;
  /** Mapped children, then mapped shadow root children. */
  children: number[];
  rules?: string[] | null;
  adopted?: (string[] | null)[];
  value?: string;
  checked?: boolean;
  selected?: boolean;
}

export interface ReplayHarness {
  /** The DOM a Replayer builds from `events`, written out comparably. */
  replay(events: readonly eventWithTime[], sheets?: Map<string, string>): Promise<unknown>;
  /**
   * What a Replayer given `events` holds for each of `ids`, by rrweb id: attributes (as set),
   * the text of a text node, and child ids. Null for a node it does not have.
   */
  inspect(
    events: readonly eventWithTime[],
    ids: readonly number[] | null,
    sheets?: Map<string, string>,
  ): Promise<Record<number, ReplayedNode | null>>;
  close(): Promise<void>;
}

export async function openReplayHarness(chromePath: string): Promise<ReplayHarness> {
  const esbuild = await import("esbuild");
  const replayEntry = repo("packages/viewer/node_modules/@rrweb/replay/dist/replay.js");
  const bundle = await esbuild.build({
    stdin: {
      contents: `export { Replayer } from ${JSON.stringify(replayEntry)};`,
      resolveDir: repo("."),
    },
    bundle: true,
    format: "iife",
    globalName: "rrwebReplay",
    write: false,
    logLevel: "silent",
  });
  const script = bundle.outputFiles[0]!.text;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: chromePath });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: script });
  await page.addScriptTag({ content: CANONICAL_DOM });
  return {
    async replay(events, sheets) {
      const resolved = sheets
        ? resolveSheetRefs([...events], (hash) => sheets.get(hash))
        : [...events];
      assert(resolved !== null, "unknown stylesheet hash");
      return page.evaluate(
        (json) =>
          (window as unknown as { __replayAndWrite(json: string): unknown }).__replayAndWrite(json),
        JSON.stringify(resolved),
      );
    },
    async inspect(events, ids, sheets) {
      const resolved = sheets
        ? resolveSheetRefs([...events], (hash) => sheets.get(hash))
        : [...events];
      assert(resolved !== null, "unknown stylesheet hash");
      return page.evaluate(
        ([json, wanted]) =>
          (
            window as unknown as {
              __replayAndInspect(
                json: string,
                ids: number[] | null,
              ): Record<number, ReplayedNode | null>;
            }
          ).__replayAndInspect(json, wanted),
        [JSON.stringify(resolved), ids === null ? null : [...ids]] as [string, number[] | null],
      );
    },
    close: () => browser.close(),
  };
}

/** Runs in the harness page: replays and writes the built DOM out (shadow roots, frames, sheets). */
const CANONICAL_DOM = `
// Declarations in a stable order: set again, a property moves to the end, which changes nothing.
window.__styleOf = (node) => node.style.cssText.split(/;\\s*/).filter(Boolean).sort().join("; ");
window.__replayAndInspect = (json, ids) => {
  const replayer = window.__replay(JSON.parse(json));
  const mirror = replayer.getMirror();
  const rules = (sheet) => { try { return sheet ? [...sheet.cssRules].map((r) => r.cssText) : null; } catch { return null; } };
  const result = {};
  for (const id of ids ?? mirror.getIds()) {
    const node = mirror.getNode(id);
    if (!node) { result[id] = null; continue; }
    let attributes = null;
    if (node.attributes) {
      attributes = Object.fromEntries([...node.attributes].map((a) => [a.name, a.value]));
      if (attributes.style !== undefined) attributes.style = window.__styleOf(node);
    }
    const host = node.shadowRoot ? [...node.shadowRoot.childNodes] : [];
    const entry = {
      attributes,
      text: node.nodeType === 3 || node.nodeType === 8 ? node.data : null,
      children: [...node.childNodes, ...host].map((child) => mirror.getId(child)).filter((child) => child >= 0),
    };
    if (node.tagName === "STYLE" || node.tagName === "LINK") entry.rules = rules(node.sheet);
    const scope = node.nodeType === 9 ? node : node.shadowRoot;
    if (scope && scope.adoptedStyleSheets) entry.adopted = scope.adoptedStyleSheets.map(rules);
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") entry.value = node.value;
    if (node.tagName === "INPUT") entry.checked = node.checked;
    if (node.tagName === "OPTION") entry.selected = node.selected;
    result[id] = entry;
  }
  replayer.destroy();
  return result;
};
window.__replay = (events) => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const replayer = new rrwebReplay.Replayer(events, {
    root, UNSAFE_replayCanvas: false, mouseTail: false, useVirtualDom: false,
    pauseAnimation: false, showWarning: false, triggerFocus: false, liveMode: false,
  });
  const first = events[0].timestamp, last = events[events.length - 1].timestamp;
  replayer.play(Math.max(0, last - first) + 1);
  replayer.pause();
  return replayer;
};
window.__replayAndWrite = (json) => {
  const replayer = window.__replay(JSON.parse(json));
  const rules = (sheet) => { try { return sheet ? [...sheet.cssRules].map((r) => r.cssText) : null; } catch { return "unreadable"; } };
  const adopted = (scope) => (scope.adoptedStyleSheets || []).map(rules);
  const write = (node) => {
    switch (node.nodeType) {
      case 1: {
        const out = { t: node.tagName.toLowerCase(), a: {} };
        for (const attribute of node.attributes) if (attribute.name !== "style") out.a[attribute.name] = attribute.value;
        if (node.getAttribute("style") !== null) out.a.style = window.__styleOf(node);
        if (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) out.v = node.value;
        if (node.tagName === "INPUT") out.k = node.checked;
        if (node.tagName === "STYLE" || node.tagName === "LINK") out.r = rules(node.sheet);
        if (node.tagName === "DETAILS") out.o = node.open;
        if (node.shadowRoot) out.s = { c: [...node.shadowRoot.childNodes].map(write), as: adopted(node.shadowRoot) };
        if (node.tagName === "IFRAME") out.d = node.contentDocument ? write(node.contentDocument) : null;
        out.c = node.tagName === "STYLE" ? [] : [...node.childNodes].map(write);
        return out;
      }
      case 3: return { x: node.data };
      case 4: return { cd: node.data };
      case 8: return { m: node.data };
      case 9: return { doc: [...node.childNodes].map(write), as: adopted(node) };
      case 10: return { dt: node.name };
      default: return { other: node.nodeType };
    }
  };
  const doc = replayer.iframe.contentDocument;
  const written = write(doc);
  replayer.destroy();
  return written;
};`;

/** The first place two written DOMs differ, as a path, or null. */
export function firstDifference(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object")
    return `${path}: ${JSON.stringify(a)?.slice(0, 200)} != ${JSON.stringify(b)?.slice(0, 200)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  if (Array.isArray(a) && (a as unknown[]).length !== (b as unknown[]).length)
    return `${path}: length ${(a as unknown[]).length} != ${(b as unknown[]).length} (${JSON.stringify(a).slice(0, 300)} vs ${JSON.stringify(b).slice(0, 300)})`;
  for (const key of keys) {
    const found = firstDifference(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (found !== null) return found;
  }
  return null;
}
