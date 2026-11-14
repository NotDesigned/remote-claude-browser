// Local mock service only: exercises user management without touching any live account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const watchdog = setTimeout(() => process.exit(124), 120000);
const root = resolve("packages/viewer/dist");
const admin = {
  id: "fixture-admin",
  username: "admin",
  role: "admin",
  enabled: true,
  createdAt: 1,
};
const regular = {
  id: "fixture-user",
  username: "reader",
  role: "user",
  enabled: true,
  createdAt: 2,
};
const users = new Map([[admin.id, { ...admin }]]);
const checks = {};
const pageErrors = [];
let lastPasswordChanged = false;
let lastChangeKeys = [];
let userSerial = 0;
const json = (response, status, body) =>
  response
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(body));
const bodyJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture.test");
    const current = request.headers.cookie?.includes("fixture-role=user") ? regular : admin;
    if (url.pathname === "/api/me") return json(response, 200, { user: current });
    if (url.pathname === "/logout") return response.writeHead(204).end();
    if (url.pathname === "/gate")
      return response.writeHead(200, { "content-type": "text/html" }).end("<h1>登录</h1>");
    if (url.pathname === "/api/users" || url.pathname.startsWith("/api/users/")) {
      if (current.role !== "admin") return json(response, 403, { error: "没有管理用户的权限" });
      if (request.method === "GET") return json(response, 200, { users: [...users.values()] });
      const id = decodeURIComponent(url.pathname.slice("/api/users/".length));
      if (request.method === "DELETE") {
        users.delete(id);
        return response.writeHead(204).end();
      }
      const body = await bodyJson(request);
      if ([...users.values()].some((user) => user.username === body.username && user.id !== id))
        return json(response, 409, { error: "用户名已存在" });
      lastPasswordChanged = typeof body.password === "string" && body.password.length > 0;
      lastChangeKeys = Object.keys(body).sort();
      const { password: discardedPassword, ...changes } = body;
      const saved =
        request.method === "POST"
          ? {
              id: `fixture-created-${++userSerial}`,
              username: body.username,
              role: body.role,
              enabled: true,
              createdAt: Date.now(),
            }
          : { ...users.get(id), ...changes };
      users.set(saved.id, saved);
      return json(response, 200, { user: saved });
    }
    if (url.pathname === "/api/client/session")
      return json(response, 200, {
        sid: "client-1",
        label: "Fixture",
        maxClients: 8,
        available: 7,
        sharedAccount: true,
      });
    if (url.pathname === "/api/accounts")
      return json(response, 200, {
        current: "default",
        default: "default",
        accounts: [{ id: "default", name: "默认配置", running: true, sessions: 1 }],
      });
    if (url.pathname.endsWith("/theme"))
      return json(response, 200, { theme: "auto", applied: true });
    if (url.pathname.endsWith("/downloads")) return json(response, 200, []);
    if (url.pathname.startsWith("/api/"))
      return json(response, 404, { error: "Fixture endpoint missing" });
    const file = resolve(root, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
    if (!file.startsWith(root + "/")) return response.writeHead(403).end();
    const bytes = await readFile(file);
    response
      .writeHead(200, {
        "content-type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
          }[extname(file)] ?? "application/octet-stream",
      })
      .end(bytes);
  } catch (error) {
    if (error.code === "ENOENT") response.writeHead(404).end();
    else {
      pageErrors.push(String(error));
      json(response, 500, { error: "Fixture failure" });
    }
  }
});
let browser;
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/opt/claude-test-chrome/chrome",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--renderer-process-limit=1",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(origin);
  await page.getByRole("button", { name: /默认配置.*未登录/ }).click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "用户管理", exact: true });
  await panel.getByLabel("用户名", { exact: true }).fill("fixture-reader");
  await panel.getByLabel("初始密码", { exact: true }).fill("fixture-only-password");
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/api/users") && response.request().method() === "POST",
    ),
    panel.getByRole("button", { name: "创建用户", exact: true }).click(),
  ]);
  await panel.getByText("已创建用户「fixture-reader」。", { exact: true }).waitFor();
  const createdId = [...users.values()].find((user) => user.username === "fixture-reader").id;
  assert.equal(users.get(createdId).role, "user");
  checks.adminCreate = true;
  await panel.getByLabel("用户名", { exact: true }).fill("fixture-renamed");
  await panel.getByLabel("新密码（留空则保持）", { exact: true }).fill("fixture-new-password");
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PATCH"),
    panel.getByRole("button", { name: "保存更改", exact: true }).click(),
  ]);
  await panel.getByText("更改已保存。", { exact: true }).waitFor();
  assert.equal(users.get(createdId).username, "fixture-renamed");
  assert.equal(lastPasswordChanged, true);
  assert.deepEqual(lastChangeKeys, ["password", "username"]);
  assert.equal(await panel.getByLabel("新密码（留空则保持）", { exact: true }).inputValue(), "");
  checks.adminRenameAndPasswordReset = true;
  await panel.getByLabel("允许登录", { exact: true }).uncheck();
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "PATCH"),
    panel.getByRole("button", { name: "保存更改", exact: true }).click(),
  ]);
  await panel.getByRole("button", { name: /fixture-renamed.*已停用/ }).waitFor();
  assert.equal(users.get(createdId).enabled, false);
  assert.equal(lastPasswordChanged, false, "an empty reset field must not change the password");
  assert.deepEqual(lastChangeKeys, ["enabled"]);
  checks.adminDisable = true;
  await panel.getByRole("button", { name: "＋ 新建用户", exact: true }).click();
  await panel.getByLabel("用户名", { exact: true }).fill("admin");
  await panel.getByLabel("初始密码", { exact: true }).fill("fixture-only-password");
  await panel.getByRole("button", { name: "创建用户", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "用户名已存在" }).waitFor();
  checks.apiFailureFeedback = true;
  await panel.getByRole("button", { name: /fixture-renamed.*已停用/ }).click();
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === "DELETE"),
    panel.getByRole("button", { name: "删除用户", exact: true }).click(),
  ]);
  await panel.getByText("用户已删除。", { exact: true }).waitFor();
  assert.equal(users.has(createdId), false);
  checks.adminDelete = true;
  const persisted = await page.evaluate(() =>
    JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]),
  );
  assert.equal(/fixture-(?:only|new)-password/.test(persisted), false);
  checks.passwordNotPersisted = true;
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.querySelector("#shell-menu-toggle") === document.activeElement,
  );
  assert.equal(
    await page
      .locator("#shell-menu-toggle")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  checks.modalFocusRestored = true;
  await context.close();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (error) => pageErrors.push(error.message));
  await phone.goto(origin);
  await phone.getByRole("button", { name: /默认配置.*未登录/ }).tap();
  await phone.getByRole("button", { name: "更多", exact: true }).tap();
  await phone.getByRole("button", { name: "用户管理", exact: true }).tap();
  const phonePanel = phone.getByRole("dialog", { name: "用户管理", exact: true });
  await phonePanel.getByLabel("用户名", { exact: true }).tap();
  await phonePanel.getByLabel("用户名", { exact: true }).fill("手机用户");
  const layout = await phonePanel.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      viewport: innerWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  assert.ok(layout.left >= 0 && layout.right <= layout.viewport + 1);
  assert.ok(layout.scrollWidth <= layout.clientWidth + 1);
  assert.equal(await phonePanel.getByLabel("用户名", { exact: true }).inputValue(), "手机用户");
  await phonePanel.getByRole("button", { name: "关闭用户管理", exact: true }).tap();
  checks.phoneTouchAndLayout = true;
  await mobile.close();
  const ordinary = await browser.newContext();
  await ordinary.addCookies([{ name: "fixture-role", value: "user", url: origin }]);
  const reader = await ordinary.newPage();
  reader.on("pageerror", (error) => pageErrors.push(error.message));
  await reader.goto(origin);
  await reader.getByRole("button", { name: /默认配置.*未登录/ }).click();
  await reader.getByRole("button", { name: "更多", exact: true }).click();
  await reader
    .getByRole("group", { name: "当前用户", exact: true })
    .getByText("reader", { exact: true })
    .waitFor();
  assert.equal(await reader.getByRole("button", { name: "用户管理", exact: true }).count(), 0);
  assert.equal(await reader.evaluate(async () => (await fetch("/api/users")).status), 403);
  checks.regularUserNoAdminEntry = true;
  await reader.getByRole("button", { name: "退出登录", exact: true }).click();
  await reader.waitForURL(origin + "/gate");
  checks.logoutReturnsToLogin = true;
  await ordinary.close();
  assert.deepEqual(pageErrors, []);
  await mkdir("artifacts", { recursive: true });
  const result = { localMockOnly: true, checks, phoneLayout: layout };
  await writeFile("artifacts/user-ui-smoke.json", JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  clearTimeout(watchdog);
}
