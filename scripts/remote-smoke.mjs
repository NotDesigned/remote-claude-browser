/** Tests the deployed A -> B path on a controlled data: page, before account login. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.SMOKE_ORIGIN || "https://claude.example.com";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Run through pnpm test:remote to enforce A's resource budget");
const env = Object.fromEntries(
  (await readFile("/etc/claude-browser/agent.env", "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/claude-test-chrome/chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await context.newPage();
const requests = [];
const errors = [];
const inputFrames = [];
page.on("request", (request) => requests.push(request.url()));
page.on("pageerror", (error) => errors.push(error.message));
page.on("websocket", (socket) =>
  socket.on("framesent", (frame) => {
    try {
      const data = JSON.parse(String(frame.payload));
      if (["ptr", "text", "value", "view", "view-ack"].includes(data.t)) inputFrames.push(data);
    } catch {}
  }),
);
const result = { origin, checks: {} };
try {
  const unauthenticated = await context.request.get(`${origin}/api/claude/metrics`, {
    maxRedirects: 0,
  });
  assert.equal(unauthenticated.status(), 302);
  result.checks.unauthenticatedRejected = true;
  await page.goto(origin);
  await page.locator('input[name="password"]').fill(env.MIRROR_ACCESS_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${origin}/`);
  await page.waitForFunction(
    () => document.querySelector("#connection-state")?.getAttribute("data-state") === "open",
  );
  const html = `<!doctype html><meta charset="utf-8"><title>Controlled mirror fixture</title><style>body{font:20px sans-serif;padding:32px}input,button{font:inherit;padding:12px}p{line-height:2}</style><h1>远程浏览器测试</h1><p id="runtime">loading</p><input id="field" aria-label="测试输入"><button id="apply">应用输入</button><p id="output">等待输入</p><script>window.remoteScriptMarker='B-only';document.querySelector('#runtime').textContent='JavaScript 在 B 执行';document.querySelector('#apply').onclick=()=>document.querySelector('#output').textContent=document.querySelector('#field').value;</script>`;
  await page
    .getByRole("textbox", { name: "Address", exact: true })
    .fill(`data:text/html,${encodeURIComponent(html)}`);
  await page.getByRole("textbox", { name: "Address", exact: true }).press("Enter");
  const frame = page.frameLocator("#mirror-host iframe");
  await frame.locator("#runtime").waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
  );
  assert.equal(await frame.locator("#runtime").innerText(), "JavaScript 在 B 执行");
  const scriptExecutedLocally = await frame
    .locator("body")
    .evaluate(() => window.remoteScriptMarker);
  assert.equal(scriptExecutedLocally, undefined);
  result.checks.remoteScriptsStayRemote = true;
  await frame.locator("#field").fill("中文输入与远端确认 123");
  await frame.locator("#apply").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#mirror-host iframe")?.contentDocument?.querySelector("#output")
        ?.textContent === "中文输入与远端确认 123",
    undefined,
    { timeout: 15000 },
  );
  result.checks.chineseInputAndRemoteClick = true;
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/dom-smoke.png" });
  await context.setOffline(true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await context.setOffline(false);
  await page.waitForFunction(
    () => document.querySelector("#connection-state")?.getAttribute("data-state") === "open",
    undefined,
    { timeout: 20000 },
  );
  await frame.locator("#output").waitFor();
  assert.equal(await frame.locator("#output").innerText(), "中文输入与远端确认 123");
  result.checks.reconnectRestoresState = true;
  await page.getByRole("textbox", { name: "Address", exact: true }).fill("https://claude.ai/");
  await page.getByRole("textbox", { name: "Address", exact: true }).press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 7000));
  await page.screenshot({ path: "artifacts/login-ready.png" });
  result.remoteAddress = await page
    .getByRole("textbox", { name: "Address", exact: true })
    .inputValue();
  const leaks = requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin);
  assert.deepEqual(leaks, []);
  result.checks.noDirectWebsiteRequests = true;
  result.requests = requests.length;
  result.browserErrors = errors;
  await writeFile("artifacts/remote-smoke.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/remote-smoke-failure.png" });
  console.error(
    JSON.stringify(
      {
        errors,
        inputFrames: inputFrames.slice(-20),
        frames: await Promise.all(
          page.frames().map(async (frame) => {
            try {
              return await frame.evaluate(() => ({
                url: location.href,
                text: document.body.innerText.slice(0, 600),
                value: document.querySelector("#field")?.value,
              }));
            } catch {
              return null;
            }
          }),
        ),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await context.close();
  await browser.close();
}
