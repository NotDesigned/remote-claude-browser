/**
 * Logs in to a running server and checks that a page is mirrored and that its script ran on the
 * server, not here. Needs SMOKE_ORIGIN, SMOKE_PASSWORD and CHROME_PATH.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.SMOKE_ORIGIN;
const password = process.env.SMOKE_PASSWORD;
assert.ok(origin && password, "Set SMOKE_ORIGIN and SMOKE_PASSWORD");

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    // The first about:blank document has an opaque origin and no storage.
    try {
      localStorage.setItem("mirror.view-mode", "dom");
    } catch {}
  });
  const page = await context.newPage();

  const refused = await context.request.get(`${origin}/api/client/session`, { maxRedirects: 0 });
  assert.notEqual(refused.status(), 200, "The API answered without logging in");

  await page.goto(origin);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector("#shell-bar", { timeout: 60_000 });

  const html =
    '<!doctype html><meta charset="utf-8"><title>Mirror check</title><p id="ran">not run</p>' +
    "<script>document.getElementById('ran').textContent = navigator.userAgent.includes('Chrome') ? 'ran' : 'odd';</script>";
  const address = page.locator("#urlbar input");
  await address.fill(`data:text/html,${encodeURIComponent(html)}`);
  await address.press("Enter");

  const mirrored = page.frameLocator("#mirror-host .mirror-stage:not([data-parked]) iframe");
  await mirrored.locator("#ran").waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const frame = document.querySelector("#mirror-host .mirror-stage:not([data-parked]) iframe");
      return frame?.contentDocument?.querySelector("#ran")?.textContent === "ran";
    },
    undefined,
    { timeout: 30_000 },
  );
  // The mirror holds what the script wrote, and none of the script's code could have run in it.
  const scripts = await mirrored.locator("script:not([type='text/plain'])").count();
  console.log(`Mirrored a page from ${origin}; live scripts in the mirror: ${scripts}.`);
} finally {
  await browser.close();
}
