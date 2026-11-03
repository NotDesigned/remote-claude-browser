// Diagnose clicks on claude.ai/code through the DOM and pixel views of a temporary workspace.
// Sends no chat messages; only navigates and clicks UI controls. Run with limited-run.sh.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");

const origin = "https://claude.example.com";
const target = process.argv[2] || "https://claude.ai/code";
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

const report = { at: new Date().toISOString(), target, steps: [] };
const step = (name, extra = {}) => {
  report.steps.push({ name, at: new Date().toISOString(), ...extra });
  console.log(JSON.stringify({ step: name, ...extra }));
};
let sid, browser, page;
// Closing the browser fails every pending step, so `finally` still releases the workspace.
const watchdog = setTimeout(() => {
  console.error("code click probe watchdog");
  report.watchdog = true;
  void browser?.close().catch(() => {});
}, 420000);
const hardStop = setTimeout(() => process.exit(124), 480000);
hardStop.unref();
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
  // Count gateway messages and keep input/recovery notices, without retaining page content.
  await context.addInitScript(() => {
    if (window.top !== window) return;
    const Native = window.WebSocket;
    window.__probe = { down: {}, notices: [], up: {} };
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          try {
            const m = JSON.parse(event.data);
            window.__probe.down[m.t] = (window.__probe.down[m.t] || 0) + 1;
            if (["input-status", "resync", "tab-state", "mode", "hello"].includes(m.t))
              window.__probe.notices.push({ at: Date.now(), ...m, data: undefined });
            if (m.t === "snapshot")
              window.__probe.notices.push({
                at: Date.now(),
                t: "snapshot",
                reason: m.reason,
                epoch: m.epoch,
                bytes: event.data.length,
              });
          } catch {}
        });
        const send = this.send.bind(this);
        this.send = (data) => {
          try {
            const m = JSON.parse(data);
            window.__probe.up[m.t] = (window.__probe.up[m.t] || 0) + 1;
            if (["resync-req", "view", "view-ack", "mode"].includes(m.t))
              window.__probe.notices.push({ at: Date.now(), up: true, ...m });
          } catch {}
          return send(data);
        };
      }
    };
  });
  page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") (report.consoleErrors ??= []).push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (error) => (report.pageErrors ??= []).push(String(error).slice(0, 300)));

  await page.goto(`${origin}/?sid=${sid}&mode=dom`);
  await page.waitForFunction(
    () => document.querySelector("#mirror-host")?.getAttribute("data-input-ready") === "true",
    null,
    { timeout: 90000 },
  );
  step("dom-ready");
  const address = page.locator('#urlbar input[aria-label="Address"]');
  await address.fill(target);
  await address.press("Enter");
  await page.waitForTimeout(15000);

  const hostState = () =>
    page.evaluate(() => {
      const host = document.querySelector("#mirror-host");
      return {
        url: document.querySelector('#urlbar input[aria-label="Address"]')?.value,
        inputReady: host?.getAttribute("data-input-ready"),
        inert: host?.inert,
        mirrorState: host?.dataset.mirrorState,
        resyncPending: host?.dataset.resyncPending,
        stale: host?.dataset.connectionStale,
        overlayText: document.querySelector("#client-session-overlay")?.textContent?.slice(0, 200),
        probe: window.__probe,
      };
    });
  report.domAfterNavigate = await hostState();
  await page.screenshot({ path: "artifacts/code-probe-dom-1.png" });
  step("navigated", {
    url: report.domAfterNavigate.url,
    inputReady: report.domAfterNavigate.inputReady,
    mirrorState: report.domAfterNavigate.mirrorState,
  });

  // What does the mirrored page offer to click, and is anything covering it?
  const frame =
    page.frames().find((f) => f !== page.mainFrame() && f.url() !== "about:blank") ??
    page.frames().find((f) => f !== page.mainFrame());
  report.mirror = frame
    ? await frame
        .evaluate(() => {
          const visible = (e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
          };
          const controls = [...document.querySelectorAll('button, a[href], [role="button"]')]
            .filter(visible)
            .slice(0, 40)
            .map((e) => {
              const r = e.getBoundingClientRect();
              const x = r.left + r.width / 2,
                y = r.top + r.height / 2;
              const top = document.elementFromPoint(x, y);
              return {
                tag: e.tagName.toLowerCase(),
                label: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 50),
                x: Math.round(x),
                y: Math.round(y),
                hitSelf: top === e || e.contains(top),
                hitBy:
                  top && top !== e && !e.contains(top)
                    ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 60)}`
                    : null,
                pointerEvents: getComputedStyle(e).pointerEvents,
              };
            });
          return {
            title: document.title,
            nodes: document.getElementsByTagName("*").length,
            iframes: document.querySelectorAll("iframe").length,
            shadowHosts: [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).length,
            bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
            controls,
          };
        })
        .catch((error) => ({ error: String(error) }))
    : { error: "no mirror frame" };
  step("mirror-inspected", {
    nodes: report.mirror.nodes,
    controls: report.mirror.controls?.length,
    covered: report.mirror.controls?.filter((c) => !c.hitSelf).length,
  });

  // Click the first visible, uncovered control through the real viewer and watch for effects.
  // Never touch sign-in pages or account controls: this runs against the shared account.
  const AUTH_CONTROL =
    /google|apple|sign|log ?in|log ?out|continue|email|sso|account|登录|退出|继续|账号/i;
  const onAuthPage = /\/(login|logout|oauth|auth)\b/i.test(report.domAfterNavigate.url || "");
  const candidate = onAuthPage
    ? undefined
    : report.mirror.controls?.find((c) => c.hitSelf && c.label && !AUTH_CONTROL.test(c.label));
  if (onAuthPage) step("skipped-click-on-auth-page", { url: report.domAfterNavigate.url });
  if (candidate) {
    const box = await page.locator("#mirror-host iframe").first().boundingBox();
    const before = await hostState();
    await page.mouse.click(box.x + candidate.x, box.y + candidate.y);
    await page.waitForTimeout(5000);
    const after = await hostState();
    report.domClick = {
      candidate,
      before: { up: before.probe.up, down: before.probe.down },
      after: { up: after.probe.up, down: after.probe.down, url: after.url },
      notices: after.probe.notices.slice(-30),
    };
    await page.screenshot({ path: "artifacts/code-probe-dom-2.png" });
    step("dom-clicked", {
      label: candidate.label,
      ptrSent: (after.probe.up.ptr || 0) - (before.probe.up.ptr || 0),
      deltasAfter: (after.probe.down.delta || 0) - (before.probe.down.delta || 0),
      inputStatus: after.probe.notices.filter((n) => n.t === "input-status").slice(-3),
    });
  }

  // Pixel mode on the same page (never clicked on a sign-in page).
  if (onAuthPage) throw Object.assign(new Error("auth page"), { skip: true });
  await page.selectOption("#view-mode-select", "px").catch(() => {});
  await page.waitForTimeout(6000);
  const canvas = page.locator("#mirror-host canvas").first();
  if (await canvas.count()) {
    const box = await canvas.boundingBox();
    const before = await hostState();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(3000);
    const after = await hostState();
    report.pxClick = {
      ptrSent: (after.probe.up.ptr || 0) - (before.probe.up.ptr || 0),
      pxFrames: (after.probe.down.px || 0) - (before.probe.down.px || 0),
      inputReady: after.inputReady,
    };
    await page.screenshot({ path: "artifacts/code-probe-px.png" });
    step("px-clicked", report.pxClick);
  } else step("px-unavailable");
  report.final = await hostState();
} catch (error) {
  if (!error.skip) report.failure = String(error.stack || error);
  console.log(JSON.stringify({ failed: true, message: error.message }));
} finally {
  await browser?.close().catch(() => {});
  if (sid) {
    const released = await api(`/api/client/session/${sid}`, "DELETE").catch(() => null);
    report.released = Boolean(released && [200, 204].includes(released.status));
  }
  clearTimeout(watchdog);
  clearTimeout(hardStop);
  await writeFile("artifacts/code-click-probe.json", JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ done: true, released: report.released, failure: !!report.failure }));
}
