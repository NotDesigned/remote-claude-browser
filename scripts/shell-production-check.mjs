// Read-only production check of the unified page: opens a temporary workspace, records the chat
// state and both views' screenshots, and never clicks inside the remote page.
// Run with: bash scripts/limited-run.sh node scripts/shell-production-check.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");

const origin = "https://claude.example.com";
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("MIRROR_ACCESS_PASSWORD="))
  .slice("MIRROR_ACCESS_PASSWORD=".length);
const login = await fetch(origin + "/gate", {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
  signal: AbortSignal.timeout(20000),
});
assert.equal(login.status, 303, "gate login");
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
const api = (path, method = "GET", body) =>
  fetch(origin + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(45000),
  });

const report = { at: new Date().toISOString() };
let sid, browser;
const watchdog = setTimeout(() => void browser?.close().catch(() => {}), 300000);
try {
  const allocated = await api("/api/client/session", "POST", { clientKey: randomUUID() });
  assert.equal(allocated.status, 200, "temporary workspace admission");
  sid = (await allocated.json()).sid;
  browser = await chromium.launch({
    executablePath: "/opt/claude-test-chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addCookies(
    cookie.split("; ").map((item) => {
      const i = item.indexOf("=");
      return {
        name: item.slice(0, i),
        value: item.slice(i + 1),
        url: origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      };
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
  await page.goto(`${origin}/?sid=${sid}`);
  await page.locator("#shell-bar").waitFor({ timeout: 60000 });
  await page.locator("#chat-view #draft").waitFor({ timeout: 60000 });
  await page.waitForTimeout(12000);
  report.chat = await page.evaluate(() => ({
    view: new URL(location.href).searchParams.get("mode"),
    status: document.querySelector("#shell-status")?.textContent,
    notice: document.querySelector("#chat-view #notice")?.hidden
      ? null
      : document.querySelector("#chat-view #notice")?.textContent,
    conversations: document.querySelectorAll("#chat-view #conversations button").length,
    newChatEnabled: document.querySelector("#chat-view #new-chat")?.disabled === false,
    title: document.title,
  }));
  await page.screenshot({ path: "artifacts/production-shell-chat.png" });
  await page.locator('#shell-bar [data-view-mode="dom"]').click();
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    null,
    { timeout: 90000 },
  );
  await page.waitForTimeout(3000);
  report.page = await page.evaluate(() => ({
    status: document.querySelector("#shell-status")?.textContent,
    url: document.querySelector('#urlbar input[aria-label="Address"]')?.value,
    tabs: document.querySelectorAll(".browser-tab").length,
  }));
  await page.screenshot({ path: "artifacts/production-shell-page.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#shell-bar [data-view-mode="chat"]').click();
  await page.locator("#chat-view #draft").waitFor();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "artifacts/production-shell-chat-mobile.png" });
  report.pageErrors = errors;
} catch (error) {
  report.failure = String(error.stack || error);
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
  if (sid) {
    const released = await api(`/api/client/session/${sid}`, "DELETE").catch(() => null);
    report.released = Boolean(released && [200, 204].includes(released.status));
  }
  await writeFile("artifacts/production-shell-check.json", JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
}
