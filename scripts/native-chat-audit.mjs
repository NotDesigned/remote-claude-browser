// Diagnostic fixture using the built text-chat UI. It never connects to B or a real account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";
import { CHAT_EXPRESSION } from "../packages/gateway/src/claude/extract.ts";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const root = resolve("packages/viewer/dist");
const streams = new Set();
const requests = [];
const receipts = new Map();
const history = [
  { path: "/chat/audit-one", title: "对话一" },
  { path: "/chat/audit-two", title: "对话二" },
];
const report = {
  fixtureOnly: true,
  testedAt: new Date().toISOString(),
  localCpuQuotaPercent: 35,
  observations: {},
  issues: [],
  pageErrors: [],
};
let sequence = 0;
let state;
let actionMode = "confirmed";
let browser;
const watchdog = setTimeout(() => process.exit(124), 180000);
const baseState = () => ({
  tab: "fixture-tab",
  epoch: "fixture-one",
  url: "https://claude.ai/chat/audit-one",
  title: "对话一",
  ready: true,
  draft: "",
  generating: false,
  messages: [{ id: "answer", role: "assistant", text: "用于本地界面诊断的示例回答。" }],
  conversations: history,
});
const json = (response, status, value) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
function publish(value) {
  const seq = ++sequence;
  const frame = `data: ${JSON.stringify({ ...value, seq, controller: "audit-controller" })}\n\n`;
  for (const response of streams) response.write(frame);
  return seq;
}
function updateLast(text) {
  const index = state.messages.length - 1;
  state.messages[index] = { ...state.messages[index], text };
  return publish({
    type: "delta",
    epoch: state.epoch,
    edits: [{ index, message: state.messages[index] }],
    length: state.messages.length,
    url: state.url,
    title: state.title,
    ready: state.ready,
    draft: state.draft,
    generating: state.generating,
    conversations: state.conversations,
  });
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://fixture").pathname;
    if (path.endsWith("/api/claude/events")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      streams.add(response);
      response.on("close", () => streams.delete(response));
      publish({ type: "snapshot", state });
      return;
    }
    if (path.endsWith("/api/claude/action")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      const action = JSON.parse(body);
      requests.push({ type: action.type, text: action.text });
      if (actionMode === "conflict" || actionMode === "ambiguous") {
        json(response, 409, {
          error: "页面已切换，请等待同步后操作",
          ...(actionMode === "conflict" ? { started: false } : {}),
        });
        return;
      }
      receipts.set(action.id, { id: action.id, status: "confirmed" });
      if (actionMode === "lost-receipt") {
        // The effect is committed, but the response body cannot provide a usable receipt.
        response.writeHead(200, { "content-type": "application/json" }).end("{");
        return;
      }
      if (actionMode === "delayed") await new Promise((resolve) => setTimeout(resolve, 500));
      if (action.type === "new" || action.type === "switch") {
        const path = action.type === "new" ? "/new" : action.path;
        state = {
          ...baseState(),
          epoch: "fixture:" + path,
          url: "https://claude.ai" + path,
          title: history.find((item) => item.path === path)?.title || "新对话",
        };
        publish({ type: "snapshot", state });
      }
      json(response, 200, { id: action.id, status: "confirmed" });
      return;
    }
    if (path.includes("/api/claude/actions/"))
      return json(response, 200, receipts.get(path.split("/").at(-1)) || { status: "unknown" });
    if (path.endsWith("/downloads")) return json(response, 200, []);
    if (path === "/away") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><title>Away</title>Local fixture");
      return;
    }
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + "/")) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    const mime =
      {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      }[extname(file)] || "application/octet-stream";
    response.writeHead(200, { "content-type": mime }).end(body);
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: String(error) });
    else response.end();
  }
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: "/opt/claude-test-chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem("audit-preserve-storage")) {
      localStorage.clear();
      sessionStorage.clear();
    }
    window.__audit = { frames: [], lifecycle: [] };
    for (const type of ["pagehide", "pageshow"])
      addEventListener(type, (event) =>
        window.__audit.lifecycle.push({ type, persisted: event.persisted }),
      );
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          const started = performance.now();
          const value = JSON.parse(event.data);
          setTimeout(
            () =>
              window.__audit.frames.push({
                seq: value.seq,
                type: value.type,
                handlerAndSchedulingMs: performance.now() - started,
              }),
            0,
          );
        });
      }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  const reset = async (messages) => {
    if (page.url().startsWith(origin))
      await page.evaluate(() => sessionStorage.removeItem("audit-preserve-storage"));
    state = baseState();
    if (messages) state.messages = messages;
    actionMode = "confirmed";
    await page.goto(`${origin}/chat.html?sid=client-1`);
    await page.waitForFunction(() => document.querySelector("#new-chat")?.disabled === false);
  };
  const waitForFrame = (seq) =>
    page.waitForFunction((seq) => window.__audit.frames.some((frame) => frame.seq === seq), seq);

  await reset();
  const beforeEmpty = requests.length;
  const emptySendEnabled = await page.locator("#send").isEnabled();
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  report.observations.emptySend = {
    enabled: emptySendEnabled,
    requests: requests.length - beforeEmpty,
  };
  if (emptySendEnabled) report.issues.push("empty-draft-send-has-no-feedback");

  await page.setViewportSize({ width: 375, height: 812 });
  report.observations.mobile = {
    newChatVisible: await page.locator("#sidebar-show").isVisible(),
    historyVisible: await page.locator("#conversations").isVisible(),
    draftVisible: await page.locator("#draft").isVisible(),
    horizontalOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  };
  await page.locator("#sidebar-show").click();
  report.observations.mobile.historyVisible = await page.locator("#conversations").isVisible();
  await page.locator("#history-close").click();
  if (!report.observations.mobile.newChatVisible || !report.observations.mobile.historyVisible)
    report.issues.push("mobile-new-chat-and-history-hidden");
  await page.setViewportSize({ width: 1280, height: 900 });

  await reset();
  await page.locator("#draft").fill("对话一的未发送草稿");
  await page.locator("#new-chat").click();
  await page.waitForFunction(
    () => document.title === "新对话" && !document.querySelector("#new-chat").disabled,
  );
  const afterNew = await page.locator("#draft").inputValue();
  await page.locator("#draft").fill("新对话的另一份草稿");
  await page.locator('#conversations button[data-path="/chat/audit-one"]').click();
  await page.waitForFunction(
    () => document.title === "对话一" && !document.querySelector("#new-chat").disabled,
  );
  report.observations.conversationDrafts = {
    afterNew,
    afterReturn: await page.locator("#draft").inputValue(),
  };
  if (afterNew || report.observations.conversationDrafts.afterReturn !== "对话一的未发送草稿")
    report.issues.push("draft-shared-across-conversations");

  await reset();
  actionMode = "delayed";
  await page.locator("#draft").fill("正在提交的旧消息");
  await page.locator("#send").click();
  report.observations.optimisticSendFeedback = await page.locator(".pending-message").isVisible();
  await page.locator("#draft").fill("发送期间输入的下一条消息");
  await page.waitForFunction(
    () =>
      document.querySelector("#resolve-pending")?.hidden === true &&
      document.querySelector("#generation-status")?.textContent === "",
  );
  report.observations.newerDraftPreserved =
    (await page.locator("#draft").inputValue()) === "发送期间输入的下一条消息";

  await reset();
  actionMode = "conflict";
  await page.locator("#draft").fill("前置条件冲突测试");
  await page.locator("#send").click();
  await page.waitForFunction(() =>
    document.querySelector("#action-status").textContent.includes("页面已切换"),
  );
  report.observations.preExecutionConflict = {
    sendDisabled: await page.locator("#send").isDisabled(),
    manualReleaseVisible: await page.locator("#resolve-pending").isVisible(),
    status: await page.locator("#action-status").innerText(),
    draft: await page.locator("#draft").inputValue(),
  };
  if (report.observations.preExecutionConflict.sendDisabled)
    report.issues.push("pre-execution-409-requires-manual-unlock");

  await reset();
  actionMode = "ambiguous";
  await page.locator("#draft").fill("未知结果继续保护");
  await page.locator("#send").click();
  await page.locator("#resolve-pending").waitFor({ state: "visible" });
  report.observations.ambiguousActionStillProtected = await page.locator("#send").isDisabled();
  assert.equal(report.observations.ambiguousActionStillProtected, true);

  await reset();
  actionMode = "lost-receipt";
  await page.locator("#draft").fill("已执行但回执丢失");
  const requestsBeforeLostReceipt = requests.length;
  await page.locator("#send").click();
  await page.waitForFunction(() =>
    document.querySelector("#action-status").textContent.includes("结果未知"),
  );
  await page.evaluate(() => sessionStorage.setItem("audit-preserve-storage", "1"));
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector("#resolve-pending")?.hidden === true &&
      document.querySelector("#generation-status")?.textContent === "",
  );
  report.observations.confirmedReceiptRecovered = {
    draft: await page.locator("#draft").inputValue(),
    requests: requests.length - requestsBeforeLostReceipt,
  };
  assert.equal(report.observations.confirmedReceiptRecovered.draft, "");
  assert.equal(report.observations.confirmedReceiptRecovered.requests, 1);

  await reset([{ id: "answer", role: "assistant", text: "这段文字会在流式回复时被继续补全。" }]);
  const selectionBefore = await page.locator(".message .text").evaluate((element) => {
    const range = document.createRange();
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
    range.setStart(node, 0);
    range.setEnd(node, 8);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  await waitForFrame(updateLast(state.messages[0].text + "新的回复内容。"));
  const selectionAfter = await page.evaluate(() => getSelection().toString());
  report.observations.selectionDuringStreaming = { before: selectionBefore, after: selectionAfter };
  if (selectionBefore !== selectionAfter) report.issues.push("stream-update-clears-text-selection");

  const markdown =
    "# 标题\n\n**重点**\n\n- 列表一\n- 列表二\n\n[参考链接](https://example.com)\n\n|列一|列二|\n|---|---|\n|甲|乙|";
  await reset([{ id: "answer", role: "assistant", text: markdown }]);
  report.observations.markdown = await page.locator(".message .text").evaluate((element) => ({
    headings: element.querySelectorAll("h1,h2,h3").length,
    lists: element.querySelectorAll("ul,ol").length,
    tables: element.querySelectorAll("table").length,
    links: element.querySelectorAll("a").length,
    literalMarkdownVisible: element.textContent.includes("**重点**"),
  }));
  if (!report.observations.markdown.headings || !report.observations.markdown.links)
    report.issues.push("markdown-structure-and-links-unrendered");
  const authority = await context.newPage();
  await authority.setContent(
    `<!doctype html><div data-testid="assistant-message"><div class="font-claude-response"><h2>结构化标题</h2><p><strong>重点</strong>与<a href="https://example.com/reference">参考链接</a></p><ul><li>第一项</li><li>第二项</li></ul><table><tr><td>甲</td><td>乙</td></tr></table></div></div>`,
  );
  const extracted = await authority.evaluate(CHAT_EXPRESSION);
  report.observations.authoritativeExtraction = { text: extracted.messages[0].text };
  if (!extracted.messages[0].text.includes("https://example.com/reference"))
    report.issues.push("extraction-discards-link-target-and-document-structure");
  await authority.close();

  const paragraph = "用于滚动跟随诊断的一行文字。\n";
  await reset([{ id: "answer", role: "assistant", text: paragraph.repeat(50) }]);
  await page.waitForTimeout(700);
  await page
    .locator("#messages")
    .evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
  for (let chunk = 0; chunk < 12; chunk++) {
    updateLast(state.messages[0].text + paragraph.repeat(18));
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(900);
  report.observations.streamingAutoScroll = await page.locator("#messages").evaluate((element) => ({
    bottomGap: Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
    scrollHeight: element.scrollHeight,
    viewportHeight: element.clientHeight,
    jumpToLatestVisible: [...document.querySelectorAll("button")].some((button) =>
      /最新|回到底部/.test(button.textContent),
    ),
  }));
  if (report.observations.streamingAutoScroll.bottomGap > 120)
    report.issues.push("streaming-auto-scroll-loses-bottom-following");

  const longMessages = Array.from({ length: 150 }, (_, index) => ({
    id: String(index),
    role: index % 2 ? "assistant" : "user",
    text: "用于测量长对话本地渲染成本。".repeat(120),
  }));
  await reset(longMessages);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const measureUpdates = async (initial) => {
    const samples = [];
    for (let index = 0; index < 5; index++) {
      const seq = updateLast(initial + index);
      await waitForFrame(seq);
      samples.push(
        await page.evaluate(
          (seq) => window.__audit.frames.find((frame) => frame.seq === seq).handlerAndSchedulingMs,
          seq,
        ),
      );
    }
    return samples;
  };
  report.observations.longConversation = {
    messageCount: state.messages.length,
    plainHandlerAndSchedulingMs: await measureUpdates("普通流式文字。".repeat(150)),
    formulaHandlerAndSchedulingMs: await measureUpdates("公式 $x^2+y^2=z^2$ 的说明。\n".repeat(20)),
    jsHeapUsedBytes: (await cdp.send("Performance.getMetrics")).metrics.find(
      (metric) => metric.name === "JSHeapUsedSize",
    )?.value,
    domNodes: await page.evaluate(() => document.querySelectorAll("*").length),
  };
  await cdp.detach();

  await reset();
  await page.goto(origin + "/away");
  await page.goBack();
  await page.waitForTimeout(1000);
  report.observations.actualHistoryRestore = {
    lifecycle: await page.evaluate(() => window.__audit.lifecycle),
    liveStreams: streams.size,
    connectionText: await page.locator("#connection").textContent(),
  };
  await reset();
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await page.waitForTimeout(1000);
  report.observations.cachedLifecycleProbe = {
    simulatedLifecycle: true,
    liveStreams: streams.size,
    connectionText: await page.locator("#connection").textContent(),
    sendEnabled: await page.locator("#send").isEnabled(),
  };
  if (!streams.size) report.issues.push("cached-page-lifecycle-has-no-reconnect-handler");
  assert.equal(report.observations.newerDraftPreserved, true);
  if (process.env.NATIVE_QA_EXPECT_FIXED === "1") assert.deepEqual(report.issues, []);
} catch (error) {
  report.failure = String(error.stack || error);
  throw error;
} finally {
  await browser?.close();
  for (const response of streams) response.end();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(watchdog);
  await writeFile("artifacts/native-chat-audit.json", JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
