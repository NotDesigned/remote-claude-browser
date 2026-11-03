// Production probe for chat-mode rendering of math and Claude's thinking blocks.
// Uses its own temporary workspace and one QA conversation, which it deletes afterwards.
// Run with: bash scripts/limited-run.sh node scripts/thinking-probe.mjs
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");

const origin = "https://claude.example.com";
const stamp = "QA-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14);
// systemd-run (limited-run.sh) does not forward the environment, so options come from argv.
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const deleteOnly = argValue("--delete");
const inspectOnly = argValue("--inspect");
if (inspectOnly !== undefined && !/^\/chat\/[a-z0-9-]+$/i.test(inspectOnly))
  throw new Error("--inspect expects /chat/<id>");
if (deleteOnly !== undefined && !/^\/chat\/[a-z0-9-]+$/i.test(deleteOnly))
  throw new Error("--delete expects /chat/<id>");
const prompt =
  argValue("--prompt") ||
  `[${stamp}] 界面测试，请先认真思考再回答：计算 ∫₀¹ x² dx。回答中请用 LaTeX 写一个行内公式和一个独立显示的公式。`;
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

const report = { at: new Date().toISOString(), testId: stamp, prompt, steps: [] };
const step = (name, extra = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...extra });
  console.log(JSON.stringify({ step: name, ...extra }));
};
const watchdog = setTimeout(() => {
  console.error("thinking probe watchdog");
  process.exit(124);
}, 540000);

let sid, browser, page, conversationPath;
/** The mirror iframe is rebuilt on every snapshot; poll until one exposes Claude's DOM. */
const mirrorFrame = async (timeoutMs = 120000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const ok = await frame
        .evaluate(() => !!document.querySelector("[data-testid], .ProseMirror"))
        .catch(() => false);
      // The mirror rebuilds its iframe after viewport and snapshot changes; wait until it settles.
      if (ok) {
        await page.waitForTimeout(3000);
        if (!frame.isDetached()) return frame;
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("mirror frame did not show the remote page");
};
const openDomMode = async () => {
  await page.goto(`${origin}/?sid=${sid}&mode=dom`);
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    null,
    { timeout: 90000 },
  );
};
/** Capture the last assistant turn's DOM structure, retrying across mirror rebuilds. */
const captureDom = async () => {
  if (!page.url().includes("mode=dom")) await openDomMode();
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const remote = await mirrorFrame();
      await page.waitForTimeout(1500);
      report.dom = await remote.evaluate(() => {
        const summarize = (el, depth, budget) => {
          if (budget.left-- <= 0) return { truncated: true };
          const attrs = {};
          for (const name of [
            "data-testid",
            "class",
            "role",
            "aria-label",
            "aria-expanded",
            "aria-hidden",
            "data-state",
            "data-is-streaming",
            "hidden",
            "open",
            "style",
          ]) {
            const value = el.getAttribute?.(name);
            if (value !== null && value !== undefined) attrs[name] = value.slice(0, 160);
          }
          const ownText = [...el.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join("")
            .trim();
          const node = { tag: el.tagName.toLowerCase(), ...attrs };
          if (ownText) node.text = ownText.slice(0, 120);
          if (depth < 22 && el.children.length) {
            node.children = [...el.children].map((child) => summarize(child, depth + 1, budget));
          }
          return node;
        };
        const responses = [
          ...document.querySelectorAll('[data-testid="assistant-message"], .font-claude-response'),
        ];
        const outer = responses.filter((e) => !responses.some((p) => p !== e && p.contains(e)));
        const last = outer.at(-1);
        const chain = [];
        for (let el = last, i = 0; el && i < 8; el = el.parentElement, i++)
          chain.push({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute("data-testid"),
            class: (el.getAttribute("class") || "").slice(0, 160),
            children: el.children.length,
          });
        // Three levels up normally holds the whole turn, including any thinking block.
        let turn = last;
        for (let i = 0; i < 3 && turn?.parentElement; i++) turn = turn.parentElement;
        const thinkingLike = [...document.querySelectorAll("button, summary, [data-testid]")]
          .filter((e) =>
            /think|thought|reason|思考|推理/i.test(
              [e.getAttribute("aria-label"), e.getAttribute("data-testid"), e.textContent]
                .filter(Boolean)
                .join(" ")
                .slice(0, 200),
            ),
          )
          .slice(0, 20)
          .map((e) => ({
            tag: e.tagName.toLowerCase(),
            testid: e.getAttribute("data-testid"),
            label: e.getAttribute("aria-label"),
            expanded: e.getAttribute("aria-expanded"),
            text: (e.textContent || "").trim().slice(0, 80),
          }));
        const composerButtons = [...document.querySelectorAll("fieldset button, form button")]
          .map((e) => ({
            label: e.getAttribute("aria-label"),
            testid: e.getAttribute("data-testid"),
            text: (e.textContent || "").trim().slice(0, 40),
            pressed: e.getAttribute("aria-pressed"),
          }))
          .slice(0, 40);
        return {
          responseCount: outer.length,
          chain,
          turn: turn ? summarize(turn, 0, { left: 1200 }) : null,
          thinkingLike,
          composerButtons,
        };
      });
      await page.screenshot({ path: "artifacts/thinking-probe-dom.png", fullPage: false });
      return;
    } catch (error) {
      lastError = error;
      step("capture-retry", { attempt, message: String(error.message).split("\n")[0] });
      await page.waitForTimeout(2000);
    }
  }
  throw lastError;
};
/** One attempt at deleting the QA conversation through Claude's own sidebar menu. */
const deleteOnce = async () => {
  const frame = await mirrorFrame();
  const anchor = frame.locator(`a[href$="${conversationPath}"]`).first();
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
  assert.ok(more, "conversation menu");
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
};
try {
  const allocated = await api("/api/client/session", "POST", { clientKey: randomUUID() });
  assert.equal(allocated.status, 200, "temporary workspace admission");
  sid = (await allocated.json()).sid;
  step("allocated", { sid });

  browser = await chromium.launch({
    executablePath: "/opt/claude-test-chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  // Record every chat SSE frame so the exact extracted markdown can be reconstructed.
  await context.addInitScript(() => {
    const Native = window.EventSource;
    if (!Native) return;
    window.__probeFrames = [];
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => window.__probeFrames.push(event.data));
      }
    };
  });
  page = await context.newPage();
  if (deleteOnly !== undefined) {
    conversationPath = deleteOnly;
    throw Object.assign(new Error("delete-only"), { deleteOnly: true });
  }
  if (inspectOnly !== undefined) {
    conversationPath = inspectOnly;
    await openDomMode();
    const address = page.locator('#urlbar input[aria-label="Address"]');
    await address.fill(`https://claude.ai${inspectOnly}`);
    await address.press("Enter");
    await page.waitForTimeout(6000);
    await captureDom();
    step("dom-captured", { thinkingLike: report.dom.thinkingLike.length });
    throw Object.assign(new Error("inspect-only"), { deleteOnly: true });
  }

  await page.goto(`${origin}/chat.html?sid=${sid}`);
  await page.waitForFunction(
    () =>
      document.querySelector("#new-chat")?.disabled === false &&
      document.querySelector("#notice")?.hidden,
    null,
    { timeout: 90000 },
  );
  step("chat-ready");
  await page.fill("#draft", prompt);
  await page.waitForFunction(() => !document.querySelector("#send").disabled, null, {
    timeout: 30000,
  });
  await page.click("#send");
  step("sent");
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".message.assistant").length > 0 &&
      document.querySelector("#generation-status")?.textContent === "就绪",
    null,
    { timeout: 240000, polling: 500 },
  );
  await page.waitForTimeout(2500);
  step("reply-complete");

  // Chat-mode rendering as the client shows it.
  report.chat = await page.evaluate(() => {
    const article = [...document.querySelectorAll(".message.assistant")].at(-1);
    return {
      html: article?.innerHTML.slice(0, 40000) ?? "",
      text: article?.innerText.slice(0, 8000) ?? "",
      katexInline: article?.querySelectorAll(".katex:not(.katex-display .katex)").length ?? 0,
      katexDisplay: article?.querySelectorAll(".katex-display").length ?? 0,
      katexErrors: article?.querySelectorAll(".katex-error").length ?? 0,
      title: document.title,
    };
  });
  await page.screenshot({ path: "artifacts/thinking-probe-chat.png", fullPage: false });

  // Reconstruct the final extracted state from SSE frames.
  const frames = await page.evaluate(() => window.__probeFrames ?? []);
  let state = null;
  for (const raw of frames) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (data.type === "snapshot") state = data.state;
    else if (data.type === "delta" && state && data.epoch === state.epoch) {
      for (const change of data.edits) {
        if (change.message) state.messages[change.index] = change.message;
        else if (state.messages[change.index] && change.edit) {
          const m = state.messages[change.index];
          m.text =
            m.text.slice(0, change.edit.at) +
            change.edit.insert +
            m.text.slice(change.edit.at + change.edit.delete);
        }
      }
      state.messages.length = data.length;
      Object.assign(state, { url: data.url, generating: data.generating });
    }
  }
  report.extracted = state
    ? {
        url: state.url,
        messages: state.messages.map((m) => ({ role: m.role, id: m.id, text: m.text })),
      }
    : null;
  if (state?.url) {
    const path = new URL(state.url).pathname;
    if (/^\/chat\/[a-z0-9-]+$/i.test(path)) conversationPath = path;
  }
  step("chat-captured", { conversationPath, frames: frames.length });

  // The real Claude DOM, as mirrored in DOM mode.
  await captureDom();
  step("dom-captured", { thinkingLike: report.dom.thinkingLike.length });
} catch (error) {
  if (!error.deleteOnly) report.failure = String(error.stack || error);
  console.log(JSON.stringify({ failed: true, message: error.message }));
} finally {
  // Delete the QA conversation from the shared account, then release the workspace.
  if (page && !page.isClosed() && sid && conversationPath) {
    try {
      if (!page.url().includes("mode=dom")) {
        await page.goto(`${origin}/?sid=${sid}&mode=dom`);
      }
      await page.waitForFunction(
        () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
        null,
        { timeout: 60000 },
      );
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          await deleteOnce();
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          step("delete-retry", { attempt, message: String(error.message).split("\n")[0] });
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
      if (lastError) throw lastError;
      report.deletedConversation = conversationPath;
    } catch (error) {
      report.cleanupFailure = String(error.stack || error);
      report.undeletedConversation = conversationPath;
    }
  }
  await browser?.close().catch(() => {});
  if (sid) {
    const released = await api(`/api/client/session/${sid}`, "DELETE").catch(() => null);
    report.releasedWorkspace = Boolean(released && [200, 204].includes(released.status));
  }
  clearTimeout(watchdog);
  await writeFile("artifacts/thinking-probe.json", JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      done: true,
      failure: report.failure ? report.failure.split("\n")[0] : null,
      deleted: report.deletedConversation ?? null,
      cleanupFailure: report.cleanupFailure ? report.cleanupFailure.split("\n")[0] : null,
      released: report.releasedWorkspace,
    }),
  );
}
