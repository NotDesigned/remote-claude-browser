// Local fixture only: checks the assembled viewer without using a website account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium, webkit } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const root = resolve("packages/viewer/dist");
const accounts = [
  { id: "default", name: "默认配置", running: false, sessions: 0, signedIn: false, email: null },
  { id: "p-0123456789", name: "工作", running: true, sessions: 1, signedIn: true, email: null },
];
const admissions = [];
const switches = [];
let current = "default";
const engine = process.env.PROFILE_PICKER_BROWSER ?? "chromium";
const errors = [];
const json = (res, value, status = 200) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.test");
    if (url.pathname === "/api/me")
      return json(res, {
        user: { id: "fixture", username: "reader", role: "user", enabled: true, createdAt: 1 },
      });
    if (url.pathname === "/api/accounts" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { name } = JSON.parse(Buffer.concat(chunks).toString());
      const account = {
        id: "p-9876543210",
        name,
        running: false,
        sessions: 0,
        signedIn: false,
        email: null,
      };
      accounts.push(account);
      return json(res, account);
    }
    if (url.pathname === "/api/accounts")
      return json(res, { accounts, current: url.searchParams.has("sid") ? current : null });
    if (url.pathname === "/api/client/session/client-1/account") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      current = body.account;
      switches.push(body);
      return json(res, { account: current });
    }
    if (url.pathname === "/api/client/session") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      admissions.push(JSON.parse(Buffer.concat(chunks).toString()));
      current = admissions.at(-1).account ?? current;
      return json(res, {
        sid: "client-1",
        label: "Fixture",
        maxClients: 8,
        available: 7,
        sharedAccount: true,
      });
    }
    if (url.pathname.endsWith("/theme")) return json(res, { theme: "auto", applied: true });
    if (url.pathname.endsWith("/downloads")) return json(res, []);
    if (url.pathname === "/logout") return res.writeHead(204).end();
    if (url.pathname === "/gate")
      return res.writeHead(200, { "content-type": "text/html" }).end("<h1>登录</h1>");
    if (url.pathname.startsWith("/api/")) return json(res, {}, 404);
    const file = resolve(root, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
    if (!file.startsWith(root + "/")) return res.writeHead(403).end();
    const bytes = await readFile(file);
    res
      .writeHead(200, {
        "content-type":
          { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] ??
          "application/octet-stream",
      })
      .end(bytes);
  } catch (error) {
    if (error.code === "ENOENT") res.writeHead(404).end();
    else {
      errors.push(String(error));
      res.writeHead(500).end();
    }
  }
});
server.on("upgrade", (_request, socket) => socket.destroy());

const watchdog = setTimeout(() => process.exit(124), 120_000);
let browser;
try {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser =
    engine === "webkit"
      ? await webkit.launch()
      : await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  assert.equal(admissions.length, 0, "choosing a configuration must not allocate a session");
  assert.equal(await page.locator("#shell-bar").isVisible(), false);
  accounts[1].email = "work@example.com";
  await page.getByText("work@example.com", { exact: true }).waitFor({ timeout: 10_000 });
  accounts[1].unavailable = true;
  accounts[1].signedIn = false;
  accounts[1].email = null;
  await page.getByText("账号不可用", { exact: true }).waitFor({ timeout: 10_000 });
  accounts[1].unavailable = false;
  accounts[1].signedIn = true;
  accounts[1].email = "work@example.com";
  await page.getByText("work@example.com", { exact: true }).waitFor({ timeout: 10_000 });
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/profile-picker-light.png" });
  await page.getByRole("button", { name: "切换外观" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: "artifacts/profile-picker-dark.png" });
  await page.getByRole("button", { name: "新建浏览器配置" }).click();
  await page.getByLabel("浏览器配置名称").fill("临时配置");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: /工作.*work@example.com/ }).click();
  await page.waitForURL(/sid=client-1/);
  assert.equal(admissions.at(-1).account, "p-0123456789");
  const key = admissions.at(-1).clientKey;
  const resumed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/client/session",
  );
  await page.reload();
  await resumed;
  await page.locator("#client-session-overlay").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".profile-picker").count(), 0);
  assert.equal(admissions.at(-1).clientKey, key);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "选择浏览器配置…", exact: true }).click();
  await page.getByText("当前使用", { exact: true }).waitFor();
  const beforeBack = admissions.length;
  await page.getByRole("button", { name: "返回会话", exact: true }).click();
  assert.equal(admissions.length, beforeBack);
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "选择浏览器配置…", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /默认配置.*未登录/ }).click();
  assert.equal(switches.length, 0);
  await page.route("**/api/client/session/client-1/account", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "切换暂不可用" }),
    }),
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /默认配置.*未登录/ }).click();
  await page.getByRole("alert").filter({ hasText: "切换暂不可用" }).waitFor();
  await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/accounts");
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("alert").filter({ hasText: "切换暂不可用" }).isVisible(), true);
  await page.unroute("**/api/client/session/client-1/account");
  page.once("dialog", (dialog) => dialog.accept());
  const moved = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/account"),
  );
  await page.getByRole("button", { name: /默认配置.*未登录/ }).click();
  await moved;
  await page.locator(".profile-picker").waitFor({ state: "hidden" });
  assert.equal(switches.at(-1).account, "default");
  await page.goto(origin + "/?new=1&sid=client-1");
  await page.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  await page.getByRole("button", { name: "新建浏览器配置" }).click();
  await page.getByLabel("浏览器配置名称").fill("新工作");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/client/session" &&
      response.request().postDataJSON()?.account === "p-9876543210",
  );
  await page.getByRole("button", { name: "创建并打开" }).click();
  await created;
  await page.waitForURL(
    (url) => url.searchParams.get("sid") === "client-1" && !url.searchParams.has("new"),
  );
  assert.equal(admissions.at(-1).account, "p-9876543210");
  assert.notEqual(admissions.at(-1).clientKey, key);

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.route("**/api/accounts", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "配置暂不可用" }),
    }),
  );
  await phone.goto(origin);
  await phone.getByRole("alert").filter({ hasText: "配置暂不可用" }).waitFor();
  await phone.unroute("**/api/accounts");
  await phone.getByRole("button", { name: "重试", exact: true }).tap();
  accounts[1].email = "a-very-long-email-address-to-check-mobile-layout@example.com";
  await phone.getByText(accounts[1].email, { exact: true }).waitFor({ timeout: 10_000 });
  const layout = await phone.locator(".profile-picker").evaluate((node) => ({
    viewport: innerWidth,
    scroll: node.scrollWidth,
    width: node.clientWidth,
  }));
  assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
  await phone.screenshot({ path: "artifacts/profile-picker-phone.png" });
  const targets = await phone
    .locator(".profile-tools button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  assert.ok(targets.every((height) => height >= 44));
  for (let i = 0; i < 5; i++)
    accounts.push({
      id: `p-fixture-${i}`,
      name: `配置 ${i + 4}`,
      running: false,
      sessions: 0,
      signedIn: false,
      email: null,
    });
  accounts[1].name = "工作配置".repeat(10);
  await phone.setViewportSize({ width: 320, height: 568 });
  await phone.getByText("配置 8", { exact: true }).waitFor({ timeout: 10_000 });
  await phone.getByRole("button", { name: "新建浏览器配置", exact: true }).tap();
  await phone.getByLabel("浏览器配置名称").fill("手机新配置");
  const inputLayout = await phone.getByLabel("浏览器配置名称").evaluate((input) => ({
    font: parseFloat(getComputedStyle(input).fontSize),
    bottom: input.getBoundingClientRect().bottom,
    viewport: innerHeight,
  }));
  assert.ok(
    inputLayout.font >= 16 && inputLayout.bottom <= inputLayout.viewport + 1,
    JSON.stringify(inputLayout),
  );
  await phone.getByRole("button", { name: "取消", exact: true }).tap();
  const phoneSession = phone.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/client/session",
  );
  await phone
    .locator(".profile-card")
    .filter({ has: phone.getByText(accounts[1].email, { exact: true }) })
    .tap();
  await phoneSession;
  await phone.getByRole("button", { name: "更多", exact: true }).tap();
  await phone.getByRole("button", { name: "选择浏览器配置…", exact: true }).tap();
  await phone.getByText("当前使用", { exact: true }).waitFor();
  await phone.getByRole("button", { name: "返回会话", exact: true }).tap();
  await phone.getByRole("button", { name: "更多", exact: true }).tap();
  await phone.getByRole("button", { name: "选择浏览器配置…", exact: true }).tap();
  phone.once("dialog", (dialog) => dialog.accept());
  const phoneMoved = phone.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/account"),
  );
  await phone.getByRole("button", { name: /默认配置.*未登录/ }).tap();
  await phoneMoved;
  await phone.getByRole("button", { name: "更多", exact: true }).tap();
  await phone.getByRole("button", { name: "选择浏览器配置…", exact: true }).tap();
  await phone.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await phone
      .locator(".profile-picker")
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  await phone.screenshot({ path: `artifacts/profile-picker-${engine}-phone-switch.png` });
  await phone.getByRole("button", { name: "退出登录", exact: true }).tap();
  await phone.waitForURL(origin + "/gate");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      localFixtureOnly: true,
      engine,
      dynamicEmailAndUnavailableState: true,
      noAdmissionBeforePick: true,
      chosenAccount: true,
      reloadResumes: true,
      newLoginChooses: true,
      createAndOpen: true,
      phoneLayout: layout,
      loadRetry: true,
      pickerLogout: true,
      menuPickerReturnAndSwitch: true,
      phoneSmallScreenAndLandscape: true,
    }),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  clearTimeout(watchdog);
}
