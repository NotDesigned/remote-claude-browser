// Uses only a temporary owned workspace and clearly marked QA conversations.
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, webkit } from "playwright";
import { editableText } from "../packages/protocol/src/editable.ts";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const origin = "https://claude.example.com";
const marker = "DOM-QA-" + Date.now();
const mobile = process.env.DOM_QA_MOBILE === "1";
const webkitViewer = process.env.DOM_QA_ENGINE === "webkit";
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("MIRROR_ACCESS_PASSWORD="))
  .slice("MIRROR_ACCESS_PASSWORD=".length);
const login = await fetch(origin + "/gate", {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(login.status, 303);
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
    signal: AbortSignal.timeout(45000),
  });
const report = {
  marker,
  engine: webkitViewer ? "webkit" : "chromium",
  checks: {},
  paths: [],
  cleaned: [],
};
const cleanupOnlyPath = process.env.DOM_QA_CLEANUP_PATH;
if (cleanupOnlyPath) {
  const previous = JSON.parse(await readFile("artifacts/dom-input-production-smoke.json", "utf8"));
  assert.ok(previous.paths.includes(cleanupOnlyPath), "cleanup only a recorded owned QA path");
  report.paths = [cleanupOnlyPath];
  report.marker = previous.marker;
}

const leasePath = "/tmp/claude-dom-qa-lease.json";
const allocated = await api("/api/client/session", "POST", { clientKey: randomUUID() });
assert.equal(allocated.status, 200, "owned QA workspace");
const { sid } = await allocated.json();
await writeFile(leasePath, JSON.stringify({ sid, cookie, marker }), { mode: 0o600 });
let browser, page, frame, failed;
let cleanupStarted = false;
const watchdog = setTimeout(() => process.exit(124), 300000);
const ready = () =>
  page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    null,
    { timeout: 60000 },
  );
const recordPath = async () => {
  const path = new URL(await page.locator('#urlbar input[aria-label="Address"]').inputValue())
    .pathname;
  if (/^\/chat\/[a-z0-9-]+$/i.test(path) && !report.paths.includes(path)) report.paths.push(path);
};
try {
  browser = webkitViewer
    ? await webkit.launch({
        headless: process.env.DOM_QA_WEBKIT_HEADFUL !== "1",
        env: {
          ...process.env,
          LIBGL_ALWAYS_SOFTWARE: "1",
          LP_NUM_THREADS: "1",
          WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        },
      })
    : await chromium.launch({
        executablePath: "/opt/claude-test-chrome/chrome",
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
  const context = await browser.newContext(
    mobile
      ? {
          viewport: { width: 375, height: 812 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
        }
      : { viewport: { width: 1280, height: 900 } },
  );
  await context.addCookies(
    cookie.split("; ").map((item) => {
      const i = item.indexOf("=");
      return { name: item.slice(0, i), value: item.slice(i + 1), url: origin };
    }),
  );
  page = await context.newPage();
  report.pageEvents = [];
  page.on("close", () => report.pageEvents.push({ type: "close", cleanup: cleanupStarted }));
  page.on("crash", () => report.pageEvents.push({ type: "crash", cleanup: cleanupStarted }));
  page.on("framenavigated", (value) => {
    if (value === page.mainFrame())
      report.pageEvents.push({ type: "navigation", url: value.url() });
  });
  browser.on("disconnected", () =>
    report.pageEvents.push({ type: "browser-disconnected", cleanup: cleanupStarted }),
  );
  await page.goto(`${origin}/?sid=${sid}&mode=dom`);
  await ready();
  frame = page.frameLocator("#mirror-host iframe");
  assert.equal(await page.locator("#end-client-session, #upload-file").count(), 0);
  report.checks.redundantToolbarButtonsRemoved = true;
  const tabTitle = page.locator('.browser-tab[data-active="true"] .tab-title');
  await tabTitle.waitFor({ state: "visible" });
  const websiteTitle = await tabTitle.innerText();
  assert.ok(websiteTitle.trim(), "website title is visible in the tab strip");
  assert.ok((await tabTitle.boundingBox()).width >= 20, "tab title has visible width");
  assert.equal(await page.title(), websiteTitle);
  report.checks.websiteTitleInTabStripAndLocalTab = true;
  if (!cleanupOnlyPath) {
    const editor = frame.locator('.ProseMirror[contenteditable="true"]:visible').first();
    if (mobile) {
      report.incognitoControls = await frame
        .locator("button")
        .evaluateAll((buttons) =>
          buttons
            .filter((e) => /incognito|匿名/i.test(e.getAttribute("aria-label") ?? ""))
            .map((e) => ({ label: e.getAttribute("aria-label"), id: e.id })),
        );
      const incognito = frame.getByRole("button", { name: /incognito|匿名/i }).first();
      await incognito.tap();
      await page.waitForFunction(
        () => {
          const root = document.querySelector("#mirror-host iframe")?.contentDocument;
          return [...(root?.querySelectorAll("button[aria-label]") ?? [])].some(
            (button) =>
              /incognito|匿名/i.test(button.getAttribute("aria-label") ?? "") &&
              (button.getAttribute("aria-pressed") === "true" ||
                /exit|leave|end|关闭|退出/i.test(button.getAttribute("aria-label") ?? "")),
          );
        },
        null,
        { timeout: 20000 },
      );
      report.checks.mobileDomIncognitoEnters = true;
      console.log(JSON.stringify({ check: "mobileDomIncognitoEnters" }));
      await ready();
      report.activeIncognitoControls = await frame
        .locator("button[aria-label]")
        .evaluateAll((buttons) =>
          buttons
            .filter((button) =>
              /incognito|regular|normal|close|匿名|退出/i.test(
                button.getAttribute("aria-label") ?? "",
              ),
            )
            .map((button) => ({
              label: button.getAttribute("aria-label"),
              id: button.id,
              visible: button.getClientRects().length > 0,
            })),
        );
      console.log(JSON.stringify({ incognitoControls: report.activeIncognitoControls }));
      const exit = report.activeIncognitoControls.find(
        (button) =>
          button.visible && /exit|leave|end|regular|normal|关闭|退出/i.test(button.label ?? ""),
      );
      assert.ok(exit, "visible incognito exit control");
      await frame.locator(`button[id=${JSON.stringify(exit.id)}]`).tap();
      await frame
        .getByRole("button", { name: "Use incognito", exact: true })
        .waitFor({ state: "visible" });
      report.checks.mobileDomIncognitoToggle = true;
      const model = frame.locator('[data-testid="model-selector-dropdown"]');
      await model.tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#mirror-host iframe")
            ?.contentDocument?.querySelector('[data-testid="model-selector-dropdown"]')
            ?.getAttribute("aria-expanded") === "true",
        null,
        { timeout: 20000 },
      );
      await model.tap();
      await page.waitForFunction(
        () =>
          document
            .querySelector("#mirror-host iframe")
            ?.contentDocument?.querySelector('[data-testid="model-selector-dropdown"]')
            ?.getAttribute("aria-expanded") === "false",
        null,
        { timeout: 20000 },
      );
      report.checks.mobileDomMenuOpens = true;
      await editor.tap();
      assert.equal(await editor.evaluate((e) => e.ownerDocument.activeElement === e), true);
      report.checks.mobileDomTapFocusesEditor = true;
    }
    await editor.fill("这一版旧稿应被替换");
    await editor.press("ControlOrMeta+A");
    const prefix = `请仅回复通过。${marker} `;
    await page.keyboard.insertText(prefix);
    const cdp = webkitViewer ? null : await context.newCDPSession(page);
    for (const [preedit, text] of [
      ["fenxi", "分析"],
      ["AI", "AI"],
      ["wenti", "问题"],
    ]) {
      if (cdp)
        await cdp.send("Input.imeSetComposition", {
          text: preedit,
          selectionStart: preedit.length,
          selectionEnd: preedit.length,
        });
      if (cdp) await cdp.send("Input.insertText", { text });
      else await page.keyboard.insertText(text);
    }
    await editor.press("Shift+Enter");
    await page.keyboard.insertText("选中替换 XYZ");
    for (let i = 0; i < 3; i++) await editor.press("Shift+ArrowLeft");
    await page.keyboard.insertText("最终内容😃 e\u0300");
    if (mobile)
      for (let i = 0; i < 12; i++) {
        await editor.press("Shift+Enter");
        await page.keyboard.insertText(`滚动测试行 ${i + 1}，请仅回复通过。`);
      }
    const expected = await editor.evaluate(editableText);
    const intended =
      prefix +
      "分析AI问题\n选中替换 最终内容😃 e\u0300" +
      (mobile
        ? Array.from({ length: 12 }, (_, i) => `\n滚动测试行 ${i + 1}，请仅回复通过。`).join("")
        : "");
    assert.equal(expected, intended, "native edits stay equal to the intended draft");
    await frame
      .locator('button[aria-label="Send message"]:enabled')
      .waitFor({ state: "visible", timeout: 20000 });
    report.checks.mobileTypingEnablesSendButton = true;
    report.expectedEnter = expected;
    await editor.press("Enter");
    await page.waitForFunction(
      (expected) => {
        const root = document.querySelector("#mirror-host iframe")?.contentDocument;
        return (
          root &&
          [...root.querySelectorAll('[data-testid="user-message"]')].some(
            (e) => e.innerText.trim() === expected.trim(),
          )
        );
      },
      expected,
      { timeout: 60000 },
    );
    await recordPath();
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#mirror-host iframe")
          ?.contentDocument?.querySelector(".ProseMirror")
          ?.textContent.trim(),
      null,
      { timeout: 30000 },
    );
    report.checks.imeSelectionUnicodeMultilineEnterMatchesVisibleText = true;
    console.log(JSON.stringify({ check: "imeSelectionUnicodeMultilineEnterMatchesVisibleText" }));
    await page.waitForFunction(
      () => {
        const root = document.querySelector("#mirror-host iframe")?.contentDocument;
        return (
          root &&
          root.querySelector('[data-testid="assistant-message"]') &&
          ![...root.querySelectorAll("button[aria-label]")].some(
            (e) => /stop/i.test(e.getAttribute("aria-label")) && e.getClientRects().length,
          )
        );
      },
      null,
      { timeout: 90000 },
    );
    await editor.fill(`请仅回复通过。${marker} 点击发送 最终稿`);
    const expectedClick = await editor.evaluate(editableText);
    if (mobile) await frame.locator('button[aria-label="Send message"]').tap();
    else await frame.locator('button[aria-label="Send message"]').click();
    await page.waitForFunction(
      (expected) =>
        [
          ...(document
            .querySelector("#mirror-host iframe")
            ?.contentDocument?.querySelectorAll('[data-testid="user-message"]') || []),
        ].some((e) => e.innerText.trim() === expected.trim()),
      expectedClick,
      { timeout: 60000 },
    );
    await recordPath();
    report.checks.clickSendMatchesVisibleText = true;
    console.log(JSON.stringify({ check: "clickSendMatchesVisibleText" }));
    if (
      mobile &&
      !webkitViewer &&
      !(await page.locator('#view-mode-select option[value="px"]').isDisabled())
    ) {
      await page.waitForFunction(
        () => {
          const root = document.querySelector("#mirror-host iframe")?.contentDocument;
          return (
            root &&
            root.querySelectorAll('[data-testid="assistant-message"]').length >= 2 &&
            ![...root.querySelectorAll("button[aria-label]")].some(
              (e) => /stop/i.test(e.getAttribute("aria-label")) && e.getClientRects().length,
            )
          );
        },
        null,
        { timeout: 90000 },
      );
      const scrollTop = () =>
        frame
          .locator("body")
          .evaluate((body) =>
            Math.max(
              0,
              ...[...body.querySelectorAll("*")]
                .filter((e) => e.clientHeight > 100 && e.scrollHeight > e.clientHeight + 10)
                .map((e) => e.scrollTop),
            ),
          );
      const before = await scrollTop();
      assert.ok(before > 20, "test conversation is scrollable");
      await page.locator("#view-mode-select").selectOption("px");
      const canvas = page.locator("#mirror-host canvas");
      await canvas.waitFor();
      await page.waitForTimeout(700);
      const rect = await canvas.boundingBox();
      const touch = await context.newCDPSession(page);
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height * 0.45;
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 12; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y + (rect.height * 0.25 * step) / 12 }],
        });
        await page.waitForTimeout(25);
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(700);
      await touch.detach();
      await page.locator("#view-mode-select").selectOption("dom");
      await canvas.waitFor({ state: "hidden" });
      await ready();
      const after = await scrollTop();
      report.pixelScroll = { before, after };
      assert.ok(
        after < before - 20,
        "pixel touch pan changes the authoritative conversation scroll",
      );
      report.checks.mobilePixelTouchScrollsOfficialConversation = true;
    } else if (mobile && webkitViewer) report.pixelSwipeCoveredByChromium = true;
    else if (mobile) report.pixelSkippedBecauseOccupied = true;
  }
} catch (error) {
  failed = error;
  report.failure = String(error.stack || error);
  if (page) {
    await recordPath().catch(() => {});
    report.inputStatus = await page
      .locator("#input-state")
      .innerText()
      .catch(() => "");
    report.remoteMessages = await frame
      .locator('[data-testid="user-message"]')
      .allInnerTexts()
      .catch(() => []);
    await page.screenshot({ path: "artifacts/dom-input-production-failure.png" }).catch(() => {});
    try {
      const response = await fetch(
        `${origin}/s/${sid}/api/claude/events?connectionKey=${randomUUID()}`,
        { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) },
      );
      const reader = response.body.getReader();
      let pending = "";
      while (!report.actualRemoteDraft) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += new TextDecoder().decode(chunk.value);
        const frames = pending.split("\n\n");
        pending = frames.pop();
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const data = JSON.parse(frame.slice(6));
          if (data.type === "snapshot") {
            report.actualRemoteDraft = { text: data.state.draft, url: data.state.url };
            break;
          }
        }
      }
      await reader.cancel();
    } catch {}
  }
} finally {
  cleanupStarted = true;
  if (page && report.paths.length) {
    try {
      if (failed) await page.goto(`${origin}/?sid=${sid}&mode=dom`);
      if (mobile) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await ready();
      }
      await ready();
      for (const path of report.paths) {
        const anchor = frame.locator(`a[href$="${path}"]`).first();
        await anchor.waitFor({ state: "visible", timeout: 60000 });
        await anchor.hover();
        let row = anchor,
          more;
        for (let depth = 0; depth < 4; depth++) {
          row = row.locator("xpath=..");
          const candidate = row.locator('button[aria-label^="More options for"]');
          if ((await candidate.count()) === 1) {
            more = candidate;
            break;
          }
        }
        assert.ok(more);
        await more.click();
        const item = frame.getByRole("menuitem", { name: /delete|删除/i });
        if (
          !(await item.waitFor({ state: "visible", timeout: 5000 }).then(
            () => true,
            () => false,
          ))
        )
          await more.click();
        await item.click();
        const dialog = frame.locator('[role="dialog"], [role="alertdialog"]').last();
        await dialog.waitFor({ state: "visible", timeout: 15000 });
        await dialog.getByRole("button", { name: /delete|删除/i }).click();
        await anchor.waitFor({ state: "hidden", timeout: 30000 });
        report.cleaned.push(path);
      }
    } catch (error) {
      report.cleanupFailure = String(error);
    }
  }
  await browser?.close().catch(() => {});
  report.releasedOwnWorkspace = [200, 204].includes(
    (await api(`/api/client/session/${sid}`, "DELETE")).status,
  );
  if (report.releasedOwnWorkspace) await rm(leasePath, { force: true });
  clearTimeout(watchdog);
  await writeFile(
    cleanupOnlyPath
      ? "artifacts/dom-input-production-cleanup.json"
      : "artifacts/dom-input-production-smoke.json",
    JSON.stringify(report, null, 2),
    {
      mode: 0o600,
    },
  );
  console.log(JSON.stringify(report));
}
if (failed) throw failed;
