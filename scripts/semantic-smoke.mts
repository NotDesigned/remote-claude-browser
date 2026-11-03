/** Full semantic path against a controlled fixture, never a real Claude account. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import Fastify from "../packages/gateway/node_modules/fastify/fastify.js";
import fastifyStatic from "../packages/gateway/node_modules/@fastify/static/index.js";
import { registerClaudeChat } from "../packages/gateway/src/claude/routes";
import type { BrowserHandle } from "../packages/gateway/src/browser/launch";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Run through pnpm test:semantic to enforce A's resource budget");
const dir = await mkdtemp(join(tmpdir(), "claude-semantic-smoke-"));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/claude-test-chrome/chrome",
  headless: true,
});
const authority = await browser.newContext();
const remote = await authority.newPage();
const cdp = await authority.newCDPSession(remote);
const fixture = `<!doctype html><meta charset="utf-8"><title>Controlled chat fixture</title><a href="/chat/fixture-history">历史测试会话</a><div id="messages"></div><div class="ProseMirror" role="textbox" contenteditable="true"></div><button aria-label="Send message">发送</button><script>
let timer;
document.querySelector('button').onclick=()=>{
 const input=document.querySelector('.ProseMirror');
 const user=document.createElement('div'); user.dataset.testid='user-message'; user.textContent=input.innerText; document.querySelector('#messages').append(user); input.textContent='';
 const answer=document.createElement('div'); answer.className='font-claude-response'; document.querySelector('#messages').append(answer);
 const stop=document.createElement('button'); stop.setAttribute('aria-label','Stop response'); stop.textContent='Stop'; document.body.append(stop);
 let n=0; timer=setInterval(()=>{answer.textContent+='测试流式回复。'; if(++n===60){clearInterval(timer);stop.remove();}},50);
 stop.onclick=()=>{clearInterval(timer);stop.remove();};
};</script>`;
await authority.route("https://claude.ai/**", (route) =>
  route.fulfill({ contentType: "text/html", body: fixture }),
);
let documentId = 1;
remote.on("framenavigated", () => documentId++);
await remote.goto("https://claude.ai/new");
const app = Fastify({ logger: false });
await app.register(fastifyStatic, { root: resolve("packages/viewer/dist") });
let mirrorHasController = false;
const controller = await registerClaudeChat(app, {
  browser: {
    send: (_session, method, params) => cdp.send(method as never, params as never),
  } as BrowserHandle,
  profileDir: dir,
  preHandler: async () => undefined,
  isOwner: () => true,
  mirrorHasController: () => mirrorHasController,
  targets: () => [{ type: "page", targetId: "fixture", sessionId: "fixture-cdp" }],
  metadata: () => ({ type: "page", targetId: "fixture", url: remote.url(), title: "Fixture" }),
  documentId: () => documentId,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
process.env.MIRROR_PUBLIC_ORIGIN = origin;
const client = await browser.newContext();
const page = await client.newPage();
const checks: Record<string, boolean> = {};
try {
  await page.goto(`${origin}/chat.html`);
  await page.waitForFunction(
    () => !(document.getElementById("send") as HTMLButtonElement).disabled,
  );
  const competing = await fetch(`${origin}/api/claude/events`);
  assert.equal(competing.status, 409);
  checks.singleController = true;
  await page.locator("#draft").fill("你好，这是受控测试 🙂");
  await page.locator("#send").click();
  await page.waitForFunction(
    () => document.querySelector("#action-status")?.textContent === "远端已确认",
  );
  assert.equal(await page.locator("#draft").inputValue(), "");
  assert.equal(
    await remote.locator('[data-testid="user-message"]').innerText(),
    "你好，这是受控测试 🙂",
  );
  checks.remoteSendReceiptAndDraft = true;
  await page.locator("#stop").waitFor({ state: "visible" });
  await page.locator("#stop").click();
  await page.waitForFunction(() => document.querySelector("#stop")?.hasAttribute("hidden"));
  checks.stopGeneration = true;
  const answer = await remote.locator(".font-claude-response").innerText();
  assert.equal(await page.locator(".message.assistant .text").innerText(), answer);
  checks.streamedTextMatchesAuthority = true;
  await page.locator("#draft").fill("未发送草稿");
  await page.reload();
  await page.waitForFunction(
    () => !(document.getElementById("send") as HTMLButtonElement).disabled,
  );
  assert.equal(await page.locator("#draft").inputValue(), "未发送草稿");
  assert.equal(await remote.locator('[data-testid="user-message"]').count(), 1);
  checks.reloadPreservesUnsentDraft = true;
  await page.getByRole("button", { name: "历史测试会话" }).click();
  await remote.waitForURL("https://claude.ai/chat/fixture-history");
  checks.historyUsesSameBrowser = true;
  await page.waitForFunction(
    () => document.querySelector("#action-status")?.textContent === "远端已确认",
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/semantic-smoke.png" });
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  mirrorHasController = true;
  assert.equal((await fetch(`${origin}/api/claude/events`)).status, 409);
  checks.mirrorControlIsExclusive = true;
  const result = { fixtureOnly: true, checks };
  await writeFile("artifacts/semantic-smoke.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  controller.close();
  await app.close();
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
