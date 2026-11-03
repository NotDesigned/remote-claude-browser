// Own temporary workspace and QA conversation only. Run with scripts/limited-run.sh.
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const origin = "https://claude.example.com";
const stamp = "QA-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14);
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
    redirect: "manual",
    signal: AbortSignal.timeout(45000),
  });
const report = {
  at: new Date().toISOString(),
  testId: stamp,
  checks: {},
  pageErrors: [],
  actionResults: [],
  resourceSamples: [],
  conversationPaths: [],
  releasedOwnWorkspace: false,
};
const leasePath = "/tmp/claude-native-qa-lease.json";
const previousReport = await readFile("artifacts/native-chat-production-smoke.json", "utf8")
  .then(JSON.parse)
  .catch(() => ({}));
const previousPaths = (previousReport.conversationPaths || []).filter(
  (path) => !(previousReport.cleanedConversationPaths || []).includes(path),
);
const previousLease = await readFile(leasePath, "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (previousLease?.cookie && previousLease?.sid) {
  const cleanup = await fetch(origin + `/api/client/session/${previousLease.sid}`, {
    method: "DELETE",
    headers: { Cookie: previousLease.cookie, Origin: origin },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (cleanup && [200, 204, 403, 404].includes(cleanup.status))
    await rm(leasePath, { force: true });
}
const mark = (name) => {
  report.checks[name] = true;
  console.log(JSON.stringify({ check: name, at: new Date().toISOString() }));
};
let sid, browser, page, context, failed;
const watchdog = setTimeout(() => {
  console.error("Native chat QA watchdog");
  process.exit(124);
}, 600000);
try {
  const allocated = await api("/api/client/session", "POST", { clientKey: randomUUID() });
  assert.equal(allocated.status, 200, "temporary workspace admission");
  sid = (await allocated.json()).sid;
  await writeFile(leasePath, JSON.stringify({ sid, cookie, testId: stamp }), { mode: 0o600 });
  browser = await chromium.launch({
    executablePath: "/opt/claude-test-chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
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
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await context.addInitScript(() => {
    const Native = window.EventSource;
    window.__qa = {
      frames: 0,
      deltas: 0,
      paths: [],
      state: null,
      sources: [],
      actions: [],
      sseBytes: 0,
      historyMetadataBytes: 0,
      changedMessageFrames: 0,
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const [input, init] = args;
      let action;
      if (String(input).endsWith("/api/claude/action") && init?.body) {
        const body = JSON.parse(init.body);
        const messages = window.__qa.state?.messages || [];
        action = {
          type: body.type,
          startedAt: Date.now(),
          textLength: body.text?.length || 0,
          priorUsers: messages.filter((message) => message.role === "user").length,
          priorAssistants: messages.filter((message) => message.role === "assistant").length,
        };
        window.__qa.actions.push(action);
      }
      try {
        const response = await nativeFetch(...args);
        if (action) {
          action.receivedAt = Date.now();
          action.http = response.status;
        }
        return response;
      } catch (error) {
        if (action) action.failedAt = Date.now();
        throw error;
      }
    };
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.__qa.sources.push(this);
        this.addEventListener("message", (event) => {
          let data;
          try {
            data = JSON.parse(event.data);
          } catch {
            return;
          }
          const qa = window.__qa;
          qa.frames++;
          qa.sseBytes += new TextEncoder().encode(event.data).byteLength;
          if (data.conversations)
            qa.historyMetadataBytes += new TextEncoder().encode(
              JSON.stringify(data.conversations),
            ).byteLength;
          if (data.edits?.length) qa.changedMessageFrames++;
          if (data.type === "snapshot") {
            qa.state = data.state;
            qa.state.conversations = [];
          }
          if (data.type === "delta" && qa.state) {
            qa.deltas++;
            for (const change of data.edits) {
              if (change.message) qa.state.messages[change.index] = change.message;
              else if (change.edit && qa.state.messages[change.index]) {
                const old = qa.state.messages[change.index].text,
                  e = change.edit;
                qa.state.messages[change.index].text =
                  old.slice(0, e.at) + e.insert + old.slice(e.at + e.delete);
              }
            }
            qa.state.messages.length = data.length;
            Object.assign(qa.state, {
              url: data.url,
              generating: data.generating,
              ready: data.ready,
            });
          }
          if (qa.state?.url) {
            const path = new URL(qa.state.url).pathname;
            if (/^\/chat\//.test(path) && !qa.paths.includes(path)) qa.paths.push(path);
          }
          if (qa.state) {
            const users = qa.state.messages.filter((message) => message.role === "user");
            const assistants = qa.state.messages.filter((message) => message.role === "assistant");
            for (const action of qa.actions.filter((item) => item.type === "send")) {
              if (!action.userSeenAt && users.length > action.priorUsers)
                action.userSeenAt = Date.now();
              if (
                !action.firstReplyAt &&
                assistants.length > action.priorAssistants &&
                assistants.at(-1)?.text
              )
                action.firstReplyAt = Date.now();
              if (action.firstReplyAt && !action.completedAt && !qa.state.generating)
                action.completedAt = Date.now();
            }
          }
        });
      }
    };
  });
  page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/claude/action")) {
      try {
        report.actionResults.push({ http: response.status(), ...(await response.json()) });
      } catch {}
    }
  });
  await page.goto(`${origin}/chat.html?sid=${sid}`);
  await page.waitForFunction(
    () => window.__qa.state?.ready && document.querySelector("#new-chat")?.disabled === false,
    null,
    { timeout: 60000 },
  );
  mark("initialConnection");
  const idleBefore = await api(`/s/${sid}/api/claude/metrics`).then((response) => response.json());
  const idleStartedAt = Date.now();
  report.resourceSamples.push({
    phase: "native-idle-start",
    ...(await api("/api/status").then((response) => response.json())),
  });
  await page.waitForTimeout(10000);
  const idleAfter = await api(`/s/${sid}/api/claude/metrics`).then((response) => response.json());
  report.idleMeasurement = {
    durationMs: Date.now() - idleStartedAt,
    polls: idleAfter.polls - idleBefore.polls,
    frames: idleAfter.snapshots + idleAfter.deltas - idleBefore.snapshots - idleBefore.deltas,
    bytes: idleAfter.bytes - idleBefore.bytes,
  };
  report.resourceSamples.push({
    phase: "native-idle-end",
    ...(await api("/api/status").then((response) => response.json())),
  });
  assert.equal(await page.locator("#view-mode-select").inputValue(), "chat");
  await page.locator("#draft").fill("分析AI问题");
  await page.locator("#draft").press("Shift+Enter");
  assert.equal(await page.locator("#draft").inputValue(), "分析AI问题\n");
  await page.locator("#theme-toggle").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.locator("#theme-toggle").click();
  mark("chineseDraftNewlineAndTheme");
  const send = async (text) => {
    const startedAt = Date.now();
    await page.locator("#draft").fill(text);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForFunction(() => !document.querySelector("#send").disabled, null, {
        timeout: 45000,
      });
      const receipt = page
        .waitForResponse(
          (response) =>
            response.url().endsWith("/api/claude/action") && response.request().method() === "POST",
          { timeout: 30000 },
        )
        .catch((error) => error);
      await page.locator("#send").click();
      const response = await receipt;
      if (response instanceof Error) throw response;
      const result = await response.json();
      if (
        response.status() === 503 &&
        result.status === "not-started" &&
        result.started === false
      ) {
        assert.equal(await page.locator("#draft").inputValue(), text);
        assert.equal(await page.locator("#resolve-pending").isVisible(), false);
        report.safePreflightRetries = (report.safePreflightRetries || 0) + 1;
        await page.waitForTimeout(1500);
        continue;
      }
      assert.equal(response.status(), 200);
      assert.equal(result.status, "confirmed", JSON.stringify(result));
      (report.sendReceiptMs ??= []).push(Date.now() - startedAt);
      return;
    }
    throw new Error("远端页面未能准备好发送");
  };
  await send(
    `这是远程网页客户端功能测试 ${stamp}。请仅回复“测试通过：中文 AI 123”，不要添加其他文字。`,
  );
  mark("sendReceiptConfirmed");
  await page.waitForFunction(
    () =>
      window.__qa.state?.messages.some(
        (message) => message.role === "assistant" && message.text.includes("测试通过"),
      ) && !window.__qa.state.generating,
    null,
    { timeout: 60000 },
  );
  assert.match(await page.locator("#messages").innerText(), /测试通过/);
  assert.equal(await page.locator("#draft").inputValue(), "");
  mark("realSendAndReply");
  await page
    .locator("#messages .message.assistant")
    .last()
    .getByRole("button", { name: "复制文字", exact: true })
    .click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /测试通过/);
  assert.equal(await page.locator("#clipboard-prompt-layer").count(), 0);
  mark("localClipboardWithoutPrompt");
  await send(
    "公式排版测试。请写一句含行内公式 E=mc^2 的中文，再单独显示二分之一的分式，使用标准 LaTeX 公式格式即可。",
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".message.assistant .katex").length >= 2 &&
      document.querySelector(".message.assistant .katex-display") &&
      !window.__qa.state.generating,
    null,
    { timeout: 60000 },
  );
  const formulaFonts = await page.evaluate(() => [
    getComputedStyle(document.querySelector(".message .text")).fontFamily,
    getComputedStyle(document.querySelector("#draft")).fontFamily,
    getComputedStyle(document.querySelector("#send")).fontFamily,
  ]);
  assert.equal(new Set(formulaFonts).size, 1);
  mark("realFormulaExtractionAndUnifiedFonts");
  const beforeReconnectActions = report.actionResults.length;
  await page.locator("#draft").fill("分析AI问题\n网络恢复草稿");
  await context.setOffline(true);
  await page.evaluate(() => {
    const source = window.__qa.sources.at(-1);
    source.close();
    source.dispatchEvent(new Event("error"));
  });
  await page.waitForTimeout(1300);
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector("#new-chat")?.disabled === false, null, {
    timeout: 45000,
  });
  assert.equal(await page.locator("#draft").inputValue(), "分析AI问题\n网络恢复草稿");
  assert.equal(report.actionResults.length, beforeReconnectActions);
  await page.locator("#draft").fill("");
  mark("reconnectKeepsDraftWithoutSending");

  await send(
    `继续执行 ${stamp} 流式传输测试。请从 1 写到 150，每行写一个数字并附带一句简短中文说明。`,
  );
  await page.locator("#stop").waitFor({ state: "visible", timeout: 60000 });
  const stopReceipt = page
    .waitForResponse((response) => response.url().endsWith("/api/claude/action"), {
      timeout: 20000,
    })
    .catch((error) => error);
  await page.locator("#stop").click();
  const stopped = await stopReceipt;
  if (stopped instanceof Error) throw stopped;
  assert.equal((await stopped.json()).status, "confirmed");
  await page.waitForFunction(() => window.__qa.state && !window.__qa.state.generating, null, {
    timeout: 30000,
  });
  mark("stopGeneration");
  const marker = stamp + "_UPLOAD_OK";
  await page.locator("#attach").click();
  await page.locator("#file-picker").waitFor({ state: "visible", timeout: 20000 });
  await page.locator("#file-picker").setInputFiles({
    name: "中文回归附件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(marker + "\n中文附件读取测试\n"),
  });
  await page.waitForFunction(
    () => document.querySelector("#upload-status")?.textContent.includes("已上传 1"),
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1800);
  await send("请读取刚上传的附件，只回复第一行的标记。");
  await page.waitForFunction(
    (mark) =>
      window.__qa.state?.messages.some(
        (message) => message.role === "assistant" && message.text.includes(mark),
      ) && !window.__qa.state.generating,
    marker,
    { timeout: 150000 },
  );
  mark("realAttachmentRead");
  await send(
    `文件下载功能测试 ${stamp}。请使用创建文件工具生成一个可下载的 qa-download.csv 文件，内容仅为 name,value 两列表头和 test,123 一行数据，并给出下载链接。`,
  );
  await page.waitForFunction(
    () =>
      window.__qa.state?.messages.some((message) => message.files?.length > 0) &&
      !window.__qa.state.generating,
    null,
    { timeout: 180000 },
  );
  const downloadButton = page.locator(".message-files button").last();
  await downloadButton.click();
  await page.locator("#downloads a").last().waitFor({ state: "visible", timeout: 45000 });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#downloads a").last().click(),
  ]);
  assert.equal(await download.failure(), null);
  const contents = await readFile(await download.path(), "utf8");
  assert.match(contents, /test,123/);
  mark("realGeneratedFileDownload");
  const beforePath = await page.evaluate(() => new URL(window.__qa.state.url).pathname);
  await page.locator("#new-chat").click();
  await page.waitForFunction(
    () => window.__qa.state?.url.endsWith("/new") && !document.querySelector("#new-chat").disabled,
    null,
    { timeout: 30000 },
  );
  await page.locator("#conversations button").first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator(`#conversations button[data-path="${beforePath}"]`).click();
  await page.waitForFunction(
    (path) => new URL(window.__qa.state?.url || location.href).pathname === path,
    beforePath,
    { timeout: 30000 },
  );
  mark("newAndHistorySwitch");
  report.nativePhaseStats = await page.evaluate(() => {
    const { frames, deltas, sseBytes, historyMetadataBytes, changedMessageFrames, actions } =
      window.__qa;
    return { frames, deltas, sseBytes, historyMetadataBytes, changedMessageFrames, actions };
  });
  report.resourceSamples.push({
    phase: "native-after-generation-and-files",
    ...(await api("/api/status").then((response) => response.json())),
  });
  await page.locator("#draft").fill("切换视图后保留草稿");
  await page.locator("#view-mode-select").selectOption("dom");
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.locator("#clipboard-prompt-layer").count(), 0);
  const domPrompt = `DOM 输入框清空回归 ${stamp}，请仅回复“通过”。`;
  const domFrame = page.frameLocator("#mirror-host iframe");
  const domEditor = domFrame.locator('.ProseMirror[contenteditable="true"]:visible').first();
  await domEditor.fill(domPrompt);
  await domEditor.press("ControlOrMeta+A");
  await page.keyboard.insertText("这一版旧稿应当被完整替换");
  await domEditor.press("ControlOrMeta+A");
  await page.keyboard.insertText(domPrompt);
  await domEditor.press("Shift+Enter");
  await page.keyboard.insertText("第二行 中文 AI 123");
  const visibleDomPrompt = await domEditor.innerText();
  await domEditor.press("Enter");
  await page.waitForFunction(
    (prompt) => {
      const root = document.querySelector("#mirror-host iframe")?.contentDocument;
      const editor = root?.querySelector('.ProseMirror[contenteditable="true"]');
      return (
        editor &&
        !editor.textContent.trim() &&
        [...root.querySelectorAll('[data-testid="user-message"]')].some(
          (e) => e.innerText.trim() === prompt.trim(),
        )
      );
    },
    visibleDomPrompt,
    { timeout: 45000 },
  );
  mark("realDomSubmittedEditorClears");
  mark("realDomSelectionReplacementAndMultilineSendMatchVisibleText");
  await domFrame.locator('[data-testid="user-message-copy"]').last().click();
  await page.waitForFunction(
    (prompt) => navigator.clipboard.readText().then((text) => text.includes(prompt)),
    visibleDomPrompt,
    { timeout: 15000 },
  );
  assert.equal(await page.locator("#clipboard-prompt-layer").count(), 0);
  mark("realDomCopyDirectlyToLocalClipboard");
  await page.locator("#view-mode-select").selectOption("chat");
  await page.waitForFunction(() => window.__qa.state?.ready, null, { timeout: 60000 });
  assert.equal(await page.locator("#draft").inputValue(), "切换视图后保留草稿");
  mark("modeRoundTripKeepsConversationAndDraft");

  await page.screenshot({
    path: "artifacts/native-chat-production-desktop.png",
    style: "#conversations{visibility:hidden}",
  });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator("#draft").isVisible(), true);
  assert.equal(await page.locator("#view-mode-select").isVisible(), true);
  await page.screenshot({
    path: "artifacts/native-chat-production-mobile.png",
    style: "#conversations{visibility:hidden}",
  });
  mark("mobileLayout");
  report.stats = await page.evaluate(() => ({
    frames: window.__qa.frames,
    deltas: window.__qa.deltas,
    messages: window.__qa.state?.messages.length,
  }));
  report.chatMetrics = await api(`/s/${sid}/api/claude/metrics`).then((response) =>
    response.json(),
  );
  report.conversationPaths = await page.evaluate(() => window.__qa.paths);
  report.checks.noJavascriptErrors = report.pageErrors.length === 0;
} catch (error) {
  failed = error;
  report.failure = String(error.stack || error);
  report.chatMetrics = await api(`/s/${sid}/api/claude/metrics`)
    .then((r) => r.json())
    .catch(() => null);
  console.log(JSON.stringify({ failed: true, checks: report.checks, message: error.message }));
  if (page && !page.isClosed()) {
    report.lastState = await page
      .evaluate(() => ({
        qa: window.__qa
          ? { frames: window.__qa.frames, deltas: window.__qa.deltas, state: window.__qa.state }
          : null,
        status: document.querySelector("#action-status")?.textContent,
        notice: document.querySelector("#notice")?.textContent,
      }))
      .catch(() => null);
    report.conversationPaths = await page.evaluate(() => window.__qa?.paths || []).catch(() => []);
    await writeFile(
      "artifacts/native-chat-production-smoke.json",
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    try {
      await page.goto(`${origin}/?sid=${sid}&mode=dom`);
      await page.waitForFunction(
        () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
        null,
        { timeout: 60000 },
      );
      const frame = await (
        await page.locator("#mirror-host iframe").elementHandle()
      ).contentFrame();
      assert.ok(frame, "DOM inspection frame");
      const address = await page.locator('#urlbar input[aria-label="Address"]').inputValue();
      const addressPath = new URL(address).pathname;
      if (/^\/chat\//.test(addressPath)) report.conversationPaths.push(addressPath);
      const remoteMeta = await frame.evaluate(
        () =>
          document.querySelector('link[rel="canonical"]')?.href ||
          document.querySelector('meta[property="og:url"]')?.content ||
          "",
      );
      if (remoteMeta) {
        const path = new URL(remoteMeta).pathname;
        if (/^\/chat\//.test(path)) report.conversationPaths.push(path);
      }
      report.remoteFailureDetails = await frame.evaluate(() => ({
        editors: [...document.querySelectorAll('[contenteditable="true"], textarea')].map((e) => ({
          text: (e.value || e.innerText || "").slice(0, 1000),
          className: e.className,
          role: e.getAttribute("role"),
        })),
        sendButtons: [...document.querySelectorAll("button")]
          .filter((e) =>
            /send|stop/i.test(
              (e.getAttribute("aria-label") || "") + " " + (e.getAttribute("data-testid") || ""),
            ),
          )
          .map((e) => ({
            label: e.getAttribute("aria-label"),
            testId: e.getAttribute("data-testid"),
            disabled: e.disabled,
            visible: e.getClientRects().length > 0,
            display: getComputedStyle(e).display,
            visibility: getComputedStyle(e).visibility,
            html: e.outerHTML.slice(0, 5000),
          })),
        fileControls: [...document.querySelectorAll('button, a, [role="button"]')]
          .filter((e) =>
            /qa download|qa-download|download|csv/i.test(
              [e.getAttribute("aria-label"), e.getAttribute("data-testid"), e.textContent].join(
                " ",
              ),
            ),
          )
          .slice(-25)
          .map((e) => e.outerHTML.slice(0, 8000)),
        alerts: [...document.querySelectorAll('[role="alert"], [role="dialog"]')].map((e) =>
          e.innerText.slice(0, 1000),
        ),
        messageNodes: [
          ...document.querySelectorAll(
            '[data-testid*="message"], [class*="font-claude"], [class*="font-user"]',
          ),
        ]
          .slice(0, 30)
          .map((e) => ({
            testId: e.getAttribute("data-testid"),
            className: e.className,
            text: e.innerText?.slice(0, 1000),
          })),
        mainText: document.querySelector("main")?.innerText.slice(0, 10000),
        currentPath:
          document.querySelector('meta[property="og:url"]')?.content || location.pathname,
      }));
    } catch (error) {
      report.remoteInspectionFailure = String(error);
    }
    await page
      .screenshot({
        path: "artifacts/native-chat-production-failure.png",
        style: "#conversations{visibility:hidden}",
      })
      .catch(() => {});
  }
} finally {
  report.conversationPaths = [...new Set([...previousPaths, ...report.conversationPaths])];
  if (page && !page.isClosed() && sid && report.conversationPaths.length > 0) {
    report.cleanedConversationPaths = [];
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${origin}/?sid=${sid}&mode=dom`);
      await page.waitForFunction(
        () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
        null,
        { timeout: 60000 },
      );
      const frame = page.frameLocator("#mirror-host iframe");
      const cleanupAddress = page.locator('#urlbar input[aria-label="Address"]');
      await cleanupAddress.fill("https://claude.ai/new");
      await cleanupAddress.press("Enter");
      await frame
        .locator('[data-testid="user-message"]')
        .first()
        .waitFor({ state: "hidden", timeout: 30000 });
      await frame
        .locator('.ProseMirror[contenteditable="true"]:visible')
        .first()
        .waitFor({ state: "visible", timeout: 30000 });
      await page.waitForFunction(
        () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
        null,
        { timeout: 30000 },
      );
      for (const path of report.conversationPaths) {
        assert.match(path, /^\/chat\/[a-z0-9-]+$/i);
        const anchor = frame.locator(`a[href$="${path}"]`).first();
        await anchor.waitFor({ state: "visible", timeout: 30000 });
        await anchor.hover();
        let row = anchor;
        let more;
        for (let depth = 0; depth < 4; depth++) {
          row = row.locator("xpath=..");
          const candidate = row.locator('button[aria-label^="More options for"]');
          if ((await candidate.count()) === 1) {
            more = candidate;
            break;
          }
        }
        assert.ok(more, "owned conversation menu");
        await more.click();
        const deleteItem = frame.getByRole("menuitem", { name: /delete|删除/i });
        if (
          !(await deleteItem.waitFor({ state: "visible", timeout: 5000 }).then(
            () => true,
            () => false,
          ))
        )
          await more.click();
        await deleteItem.click();
        const dialog = frame.locator('[role="dialog"], [role="alertdialog"]').last();
        await dialog.waitFor({ state: "visible", timeout: 15000 });
        await dialog.getByRole("button", { name: /delete|删除/i }).click();
        await anchor.waitFor({ state: "hidden", timeout: 30000 });
        report.cleanedConversationPaths.push(path);
      }
      mark("cleanedTestConversations");
    } catch (error) {
      report.cleanupFailure = String(error.stack || error);
    }
  }
  await browser?.close().catch(() => {});
  if (sid) {
    const released = await api(`/api/client/session/${sid}`, "DELETE").catch(() => null);
    report.releasedOwnWorkspace = Boolean(released && [200, 204].includes(released.status));
    if (report.releasedOwnWorkspace || released?.status === 403)
      await rm(leasePath, { force: true });
  }
  clearTimeout(watchdog);
  await writeFile(
    "artifacts/native-chat-production-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      checks: report.checks,
      failure: report.failure || null,
      conversationPaths: report.conversationPaths,
      releasedOwnWorkspace: report.releasedOwnWorkspace,
    }),
  );
}
if (failed) throw failed;
