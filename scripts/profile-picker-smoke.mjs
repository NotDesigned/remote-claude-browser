// Local fixture only: checks the assembled viewer without using a website account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium, webkit } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const root = resolve("packages/viewer/dist");
const accounts = [
  {
    id: "default",
    name: "默认配置",
    running: false,
    sessions: 0,
    signedIn: false,
    email: null,
    proxyId: null,
    proxyName: null,
  },
  {
    id: "p-0123456789",
    name: "工作",
    running: true,
    sessions: 1,
    signedIn: true,
    email: null,
    proxyId: "proxy-private",
    proxyName: "私有出口",
  },
];
const proxies = [
  { id: "proxy-shared", name: "共享出口", visibility: "shared" },
  { id: "proxy-private", name: "私有出口", visibility: "private" },
];
const proxyChanges = [];
const admissions = [];
const switches = [];
const renames = [];
const defaultChanges = [];
const deletions = [];
const sessionAccounts = new Map();
let current = "default";
let currentClientKey;
let defaultAccount = "default";
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
        proxyId: null,
        proxyName: null,
      };
      accounts.push(account);
      return json(res, account);
    }
    if (url.pathname === "/api/proxies") return json(res, { proxies });
    if (/^\/api\/accounts\/[^/]+\/proxy$/.test(url.pathname) && req.method === "PATCH") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { proxyId } = JSON.parse(Buffer.concat(chunks).toString());
      const account = accounts.find((item) => item.id === url.pathname.split("/")[3]);
      account.proxyId = proxyId;
      account.proxyName = proxies.find((item) => item.id === proxyId)?.name ?? null;
      proxyChanges.push({ id: account.id, proxyId });
      return json(res, account);
    }
    if (url.pathname.startsWith("/api/accounts/") && req.method === "PATCH") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { name } = JSON.parse(Buffer.concat(chunks).toString());
      const account = accounts.find(
        (item) => item.id === url.pathname.slice("/api/accounts/".length),
      );
      account.name = name.trim().replace(/\s+/g, " ");
      renames.push({ id: account.id, name: account.name });
      return json(res, account);
    }
    if (/^\/api\/accounts\/[^/]+\/default$/.test(url.pathname) && req.method === "POST") {
      defaultAccount = url.pathname.split("/")[3];
      defaultChanges.push(defaultAccount);
      return json(res, { account: defaultAccount });
    }
    if (url.pathname.startsWith("/api/accounts/") && req.method === "DELETE") {
      const id = url.pathname.slice("/api/accounts/".length);
      if (id === defaultAccount) return json(res, { error: "默认配置不能删除" }, 409);
      accounts.splice(
        accounts.findIndex((account) => account.id === id),
        1,
      );
      deletions.push(id);
      return res.writeHead(204).end();
    }
    if (url.pathname === "/api/accounts")
      return json(res, {
        accounts: [...accounts].sort(
          (a, b) => Number(b.id === defaultAccount) - Number(a.id === defaultAccount),
        ),
        current: url.searchParams.has("sid") ? current : null,
        default: defaultAccount,
      });
    if (url.pathname === "/api/client/session/client-1/account") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      current = body.account;
      sessionAccounts.set(currentClientKey, current);
      switches.push(body);
      return json(res, { account: current });
    }
    if (url.pathname === "/api/client/session") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      admissions.push(JSON.parse(Buffer.concat(chunks).toString()));
      const request = admissions.at(-1);
      currentClientKey = request.clientKey;
      current = sessionAccounts.get(currentClientKey) ?? request.account ?? defaultAccount;
      sessionAccounts.set(currentClientKey, current);
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

async function openCardMenu(page, name, touch = false) {
  const trigger = page.getByRole("button", { name: `管理「${name}」`, exact: true });
  if (touch) await trigger.tap();
  else await trigger.click();
}

const exitWarningChecks = [];
async function checkExitWarnings(page, touch = false) {
  const account = accounts.find((entry) => entry.id === "p-0123456789");
  const original = { ...account };
  const messages = [];
  let accept = false;
  const onDialog = (dialog) => {
    messages.push(dialog.message());
    return accept ? dialog.accept() : dialog.dismiss();
  };
  page.on("dialog", onDialog);
  const editor = page.locator("form.profile-proxy-editor");
  const select = page.getByLabel(`「${account.name}」的网络出口`, { exact: true });
  const press = (button) => (touch ? button.tap() : button.click());
  async function edit(value) {
    await openCardMenu(page, account.name, touch);
    await press(page.getByRole("button", { name: "设置出口", exact: true }));
    await select.selectOption(value);
  }
  async function save({ confirm, proceed, patch, previous, next, running = false }) {
    accept = proceed;
    const before = { dialogs: messages.length, patches: proxyChanges.length };
    const response = patch
      ? page.waitForResponse(
          (value) =>
            value.request().method() === "PATCH" &&
            new URL(value.url()).pathname === `/api/accounts/${account.id}/proxy`,
        )
      : null;
    await press(page.getByRole("button", { name: "保存出口", exact: true }));
    if (response) await response;
    assert.equal(
      messages.length,
      before.dialogs + Number(confirm),
      "one confirmation per actual bound-exit change",
    );
    if (confirm) {
      const message = messages.at(-1);
      assert.ok(message.includes(`「${previous}」`) && message.includes(`「${next}」`));
      assert.ok(
        message.includes(
          "频繁更换账号的出口 IP 可能触发平台风控，要求重新验证或限制账号。请确认你了解影响并希望继续。",
        ),
      );
      assert.equal(message.includes("关闭该配置在所有设备上打开的页面"), running);
    }
    assert.equal(proxyChanges.length, before.patches + Number(patch));
    if (confirm && !proceed) assert.equal(await editor.isVisible(), true);
    else await editor.waitFor({ state: "hidden" });
  }
  try {
    account.running = false;
    account.signedIn = false;
    await page.reload();
    await edit("proxy-shared");
    await save({
      confirm: true,
      proceed: false,
      patch: false,
      previous: "私有出口",
      next: "共享出口",
    });
    assert.equal(account.proxyId, "proxy-private");
    assert.equal(
      await select.inputValue(),
      "proxy-shared",
      "cancel keeps the open editor and proposed selection",
    );
    await save({
      confirm: true,
      proceed: true,
      patch: true,
      previous: "私有出口",
      next: "共享出口",
    });
    assert.equal(account.proxyId, "proxy-shared");
    await edit("proxy-shared");
    const url = page.url();
    let navigations = 0;
    const navigated = (frame) => {
      if (frame === page.mainFrame()) navigations++;
    };
    page.on("framenavigated", navigated);
    await save({ confirm: false, proceed: true, patch: false });
    page.off("framenavigated", navigated);
    assert.equal(navigations, 0, "same-node save must not reload");
    assert.equal(page.url(), url);
    await edit("");
    await save({
      confirm: true,
      proceed: true,
      patch: true,
      previous: "共享出口",
      next: "未选择出口（禁止打开）",
    });
    assert.equal(account.proxyId, null);
    await edit("proxy-private");
    await save({ confirm: false, proceed: true, patch: true });
    assert.equal(
      account.proxyId,
      "proxy-private",
      "first assignment has no IP-change confirmation",
    );
    account.running = true;
    await page.reload();
    await edit("proxy-shared");
    await save({
      confirm: true,
      proceed: false,
      patch: false,
      previous: "私有出口",
      next: "共享出口",
      running: true,
    });
    assert.equal(account.proxyId, "proxy-private");
    await save({
      confirm: true,
      proceed: true,
      patch: true,
      previous: "私有出口",
      next: "共享出口",
      running: true,
    });
    assert.equal(account.proxyId, "proxy-shared");
    exitWarningChecks.push({
      touch,
      stoppedAndSignedOutWarned: true,
      runningWarningCombined: true,
      cancelledBindingUnchanged: true,
      sameNodeNoRequestOrReload: true,
      clearingWarned: true,
      firstBindingNoWarning: true,
    });
  } finally {
    page.off("dialog", onDialog);
    Object.assign(account, original);
    await page.reload();
    await page.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  }
}

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
  page.on("pageerror", (error) =>
    errors.push({ url: page.url(), message: error.message, stack: error.stack }),
  );
  await page.goto(origin);
  await page.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  assert.equal(admissions.length, 0, "choosing a configuration must not allocate a session");
  assert.equal(await page.locator("#shell-bar").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: /默认配置.*未登录/ }).isDisabled(), true);
  await page.getByText("请通过 ⋯ 设置出口并绑定节点后打开", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "管理「默认配置」" }).isEnabled(), true);
  await openCardMenu(page, "默认配置");
  await page.getByRole("button", { name: "重命名「默认配置」", exact: true }).waitFor();
  assert.equal(admissions.length, 0);
  assert.equal(switches.length, 0);
  await page.keyboard.press("Escape");
  await page.locator(".profile-actions").waitFor({ state: "hidden" });
  await openCardMenu(page, "默认配置");
  await page.getByRole("heading", { name: "选择浏览器配置" }).click();
  await page.locator(".profile-actions").waitFor({ state: "hidden" });
  await openCardMenu(page, "默认配置");
  await page.getByRole("button", { name: "重命名「默认配置」", exact: true }).click();
  const rename = page.locator("form.profile-rename-form");
  const newName = page.getByLabel("配置新名称", { exact: true });
  assert.equal(await newName.inputValue(), "默认配置");
  await newName.fill("不保存的名字");
  await rename.getByRole("button", { name: "取消", exact: true }).click();
  await openCardMenu(page, "默认配置");
  await page.getByRole("button", { name: "重命名「默认配置」", exact: true }).click();
  await newName.fill("Escape 取消");
  await newName.press("Escape");
  await rename.waitFor({ state: "hidden" });
  assert.equal(renames.length, 0);
  await openCardMenu(page, "默认配置");
  await page.getByRole("button", { name: "重命名「默认配置」", exact: true }).click();
  assert.equal(await newName.getAttribute("maxlength"), "40");
  await newName.fill("   ");
  assert.equal(await rename.getByRole("button", { name: "保存", exact: true }).isEnabled(), false);
  await newName.fill("  研究   配置  ");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "管理「研究 配置」", exact: true }).waitFor();
  assert.deepEqual(renames.at(-1), { id: "default", name: "研究 配置" });
  await page.reload();
  await page.getByRole("button", { name: "管理「研究 配置」", exact: true }).waitFor();
  await openCardMenu(page, "研究 配置");
  await page.getByRole("button", { name: "重命名「研究 配置」", exact: true }).click();
  await newName.fill("失败后重试");
  await page.route("**/api/accounts/default", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "重命名暂不可用" }),
    }),
  );
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "重命名暂不可用" }).waitFor();
  assert.equal(await newName.inputValue(), "失败后重试");
  assert.equal(accounts[0].name, "研究 配置");
  await page.unroute("**/api/accounts/default");
  await newName.fill("默认配置");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "管理「默认配置」", exact: true }).waitFor();
  assert.equal(admissions.length, 0, "renaming before selection must not allocate a session");
  assert.equal(switches.length, 0, "renaming must not switch configurations");
  await openCardMenu(page, "默认配置");
  await page.getByRole("button", { name: "设置出口", exact: true }).click();
  const defaultProxy = page.getByLabel("「默认配置」的网络出口", { exact: true });
  assert.equal(
    await defaultProxy.inputValue(),
    "",
    "an unbound profile must not select the first node",
  );
  assert.equal(
    await defaultProxy.locator('option[value=""]').textContent(),
    "未选择出口（禁止打开）",
  );
  await defaultProxy.selectOption("proxy-shared");
  await page.getByRole("button", { name: "保存出口", exact: true }).click();
  await page.getByRole("button", { name: /默认配置.*共享出口/ }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('button.profile-card[data-exit-required="true"]'),
  );
  assert.equal(admissions.length, 0, "binding an exit must not open the profile");
  await checkExitWarnings(page);
  await openCardMenu(page, "工作");
  await page.getByRole("button", { name: "设「工作」为默认", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("button.profile-card .profile-name")?.textContent === "工作",
  );
  assert.equal(defaultChanges.at(-1), "p-0123456789");
  await openCardMenu(page, "工作");
  await page.getByRole("button", { name: "重命名「工作」", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "设「工作」为默认", exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: "删除「工作」", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await page.locator(".profile-actions").waitFor({ state: "hidden" });
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("button.profile-card .profile-name")?.textContent === "工作",
  );
  assert.equal(defaultAccount, "p-0123456789");
  await openCardMenu(page, "默认配置");
  await page.getByRole("button", { name: "设「默认配置」为默认", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("button.profile-card .profile-name")?.textContent === "默认配置",
  );
  accounts.push({
    id: "p-2222222222",
    name: "可删除配置",
    running: false,
    sessions: 0,
    signedIn: false,
    email: null,
  });
  await page
    .getByRole("button", { name: "管理「可删除配置」", exact: true })
    .waitFor({ timeout: 10_000 });
  page.once("dialog", (dialog) => dialog.dismiss());
  await openCardMenu(page, "可删除配置");
  await page.getByRole("button", { name: "删除「可删除配置」", exact: true }).click();
  assert.equal(deletions.length, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await openCardMenu(page, "可删除配置");
  await page.getByRole("button", { name: "删除「可删除配置」", exact: true }).click();
  await page
    .getByRole("button", { name: "管理「可删除配置」", exact: true })
    .waitFor({ state: "hidden" });
  assert.deepEqual(deletions, ["p-2222222222"]);
  await page.reload();
  await page.getByRole("button", { name: "管理「默认配置」", exact: true }).waitFor();
  assert.equal(await page.getByText("可删除配置", { exact: true }).count(), 0);
  assert.equal(admissions.length, 0);
  assert.equal(switches.length, 0);
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
  const initialized = Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/accounts" &&
        new URL(response.url()).searchParams.has("sid"),
    ),
    page.waitForResponse((response) => new URL(response.url()).pathname === "/s/client-1/theme"),
  ]);
  await page.getByRole("button", { name: /工作.*work@example.com/ }).click();
  await page.waitForURL(/sid=client-1/);
  await initialized;
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
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器配置", exact: true }).click();
  await page.getByText("当前使用", { exact: true }).waitFor();
  const beforeBack = admissions.length;
  await openCardMenu(page, "工作");
  await page.getByRole("button", { name: "重命名「工作」", exact: true }).click();
  await newName.fill("当前工作配置");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "管理「当前工作配置」", exact: true }).waitFor();
  await page.getByText("当前使用", { exact: true }).waitFor();
  assert.equal(current, "p-0123456789");
  assert.equal(admissions.length, beforeBack);
  assert.equal(switches.length, 0);
  await openCardMenu(page, "当前工作配置");
  await page.getByRole("button", { name: "重命名「当前工作配置」", exact: true }).click();
  await newName.fill("工作");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "管理「工作」", exact: true }).waitFor();
  await page.getByRole("button", { name: "返回会话", exact: true }).click();
  assert.equal(admissions.length, beforeBack);
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器配置", exact: true }).click();
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
  const switchInitialized = Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/accounts" &&
        new URL(response.url()).searchParams.has("sid"),
    ),
    page.waitForResponse((response) => new URL(response.url()).pathname === "/s/client-1/theme"),
  ]);
  await page.getByRole("button", { name: /默认配置.*未登录/ }).click();
  await moved;
  await page.locator(".profile-picker").waitFor({ state: "hidden" });
  await switchInitialized;
  assert.equal(switches.at(-1).account, "default");
  await page.goto(origin + "/?new=1&sid=client-1");
  await page.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  await page.getByRole("button", { name: "新建浏览器配置" }).click();
  await page.getByLabel("浏览器配置名称").fill("新工作");
  const beforeCreate = { admissions: admissions.length, switches: switches.length };
  await page.getByRole("button", { name: "创建并设置出口" }).click();
  const createdProxy = page.getByLabel("「新工作」的网络出口", { exact: true });
  await createdProxy.waitFor();
  assert.equal(await createdProxy.inputValue(), "", "a new profile must have no selected node");
  assert.equal(await page.getByRole("button", { name: /新工作.*未登录/ }).isDisabled(), true);
  assert.equal(admissions.length, beforeCreate.admissions);
  assert.equal(switches.length, beforeCreate.switches);
  await createdProxy.selectOption("proxy-private");
  await page.getByRole("button", { name: "保存出口", exact: true }).click();
  await page.getByRole("button", { name: /新工作.*私有出口/ }).waitFor();
  assert.equal(admissions.length, beforeCreate.admissions, "saving the exit must not auto-open");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/client/session" &&
      response.request().postDataJSON()?.account === "p-9876543210",
  );
  await page.getByRole("button", { name: /新工作.*私有出口/ }).click();
  await created;
  await page.waitForURL(
    (url) => url.searchParams.get("sid") === "client-1" && !url.searchParams.has("new"),
  );
  assert.equal(admissions.at(-1).account, "p-9876543210");
  assert.notEqual(admissions.at(-1).clientKey, key);
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "浏览器配置", exact: true }).click();
  await page.getByRole("button", { name: "新建浏览器配置", exact: true }).click();
  await page.getByLabel("浏览器配置名称", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "创建并设置出口", exact: true }).count(), 1);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "返回会话", exact: true }).click();

  const resumeFailure = await context.newPage();
  let rejectedResumes = 0;
  await resumeFailure.route("**/api/client/session", (route) => {
    rejectedResumes++;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "EXIT_REQUIRED" }),
    });
  });
  await resumeFailure.goto(origin + "/?sid=client-1");
  await resumeFailure
    .getByText("此浏览器配置尚未绑定出口节点，请返回选择配置并设置出口。", { exact: true })
    .waitFor();
  await resumeFailure.getByRole("link", { name: "重新选择配置并设置出口", exact: true }).click();
  await resumeFailure.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  assert.equal(rejectedResumes, 1, "an unbound resume must not silently retry another exit");
  await resumeFailure.close();
  await context.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await mobile.newPage();
  phone.on("pageerror", (error) =>
    errors.push({ url: phone.url(), message: error.message, stack: error.stack }),
  );
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
  await phone.getByRole("heading", { name: "选择浏览器配置" }).waitFor();
  await checkExitWarnings(phone, true);
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
  const beforePhoneRename = { admissions: admissions.length, switches: switches.length };
  await openCardMenu(phone, "默认配置", true);
  await phone.getByRole("button", { name: "重命名「默认配置」", exact: true }).tap();
  const phoneRename = phone.locator("form.profile-rename-form");
  const phoneName = phone.getByLabel("配置新名称", { exact: true });
  await phoneName.fill("手机配置");
  const renameLayout = await phoneRename.evaluate((form) => ({
    font: parseFloat(getComputedStyle(form.querySelector("input")).fontSize),
    buttons: [...form.querySelectorAll("button")].map(
      (button) => button.getBoundingClientRect().height,
    ),
    left: form.getBoundingClientRect().left,
    right: form.getBoundingClientRect().right,
    viewport: innerWidth,
    scrollWidth: form.scrollWidth,
    clientWidth: form.clientWidth,
  }));
  assert.ok(renameLayout.font >= 16 && renameLayout.buttons.every((height) => height >= 44));
  assert.ok(renameLayout.left >= 0 && renameLayout.right <= renameLayout.viewport + 1);
  assert.ok(renameLayout.scrollWidth <= renameLayout.clientWidth + 1);
  await phoneRename.getByRole("button", { name: "保存", exact: true }).tap();
  await phone.getByRole("button", { name: "管理「手机配置」", exact: true }).waitFor();
  await phone.reload();
  await phone.getByRole("button", { name: "管理「手机配置」", exact: true }).waitFor();
  await openCardMenu(phone, "手机配置", true);
  await phone.getByRole("button", { name: "重命名「手机配置」", exact: true }).tap();
  await phoneName.fill("默认配置");
  await phoneRename.getByRole("button", { name: "保存", exact: true }).tap();
  await phone.getByRole("button", { name: "管理「默认配置」", exact: true }).waitFor();
  assert.equal(admissions.length, beforePhoneRename.admissions);
  assert.equal(switches.length, beforePhoneRename.switches);
  await openCardMenu(phone, "新工作", true);
  const menuLayout = await phone.locator(".profile-actions").evaluate((menu) => ({
    left: menu.getBoundingClientRect().left,
    right: menu.getBoundingClientRect().right,
    viewport: innerWidth,
    scrollWidth: menu.scrollWidth,
    clientWidth: menu.clientWidth,
    targets: [...menu.querySelectorAll("button")].map(
      (button) => button.getBoundingClientRect().height,
    ),
  }));
  assert.ok(menuLayout.left >= 0 && menuLayout.right <= menuLayout.viewport + 1);
  assert.ok(menuLayout.scrollWidth <= menuLayout.clientWidth + 1);
  assert.ok(menuLayout.targets.every((height) => height >= 44));
  await phone.getByRole("button", { name: "设「新工作」为默认", exact: true }).tap();
  await phone.waitForFunction(
    () => document.querySelector("button.profile-card .profile-name")?.textContent === "新工作",
  );
  assert.equal(defaultAccount, "p-9876543210");
  await openCardMenu(phone, "新工作", true);
  await phone.getByRole("button", { name: "重命名「新工作」", exact: true }).waitFor();
  assert.equal(
    await phone.getByRole("button", { name: "设「新工作」为默认", exact: true }).count(),
    0,
  );
  assert.equal(await phone.getByRole("button", { name: "删除「新工作」", exact: true }).count(), 0);
  await phone.keyboard.press("Escape");
  await phone.locator(".profile-actions").waitFor({ state: "hidden" });
  await phone.reload();
  await phone.waitForFunction(
    () => document.querySelector("button.profile-card .profile-name")?.textContent === "新工作",
  );
  await openCardMenu(phone, "默认配置", true);
  await phone.getByRole("button", { name: "设「默认配置」为默认", exact: true }).tap();
  await phone.waitForFunction(
    () => document.querySelector("button.profile-card .profile-name")?.textContent === "默认配置",
  );
  const beforePhoneDelete = deletions.length;
  phone.once("dialog", (dialog) => dialog.dismiss());
  await openCardMenu(phone, "配置 7", true);
  await phone.getByRole("button", { name: "删除「配置 7」", exact: true }).tap();
  assert.equal(deletions.length, beforePhoneDelete);
  phone.once("dialog", (dialog) => dialog.accept());
  await openCardMenu(phone, "配置 7", true);
  await phone.getByRole("button", { name: "删除「配置 7」", exact: true }).tap();
  await phone
    .getByRole("button", { name: "管理「配置 7」", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(deletions.at(-1), "p-fixture-3");
  assert.equal(admissions.length, beforePhoneRename.admissions);
  assert.equal(switches.length, beforePhoneRename.switches);
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
  await phone.getByRole("button", { name: "工作台", exact: true }).tap();
  await phone.getByRole("button", { name: "浏览器配置", exact: true }).tap();
  await phone.getByText("当前使用", { exact: true }).waitFor();
  await phone.getByRole("button", { name: "返回会话", exact: true }).tap();
  await phone.getByRole("button", { name: "工作台", exact: true }).tap();
  await phone.getByRole("button", { name: "浏览器配置", exact: true }).tap();
  phone.once("dialog", (dialog) => dialog.accept());
  const phoneMoved = phone.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/account"),
  );
  await phone.getByRole("button", { name: /默认配置.*未登录/ }).tap();
  await phoneMoved;
  await phone.getByRole("button", { name: "工作台", exact: true }).tap();
  await phone.getByRole("button", { name: "浏览器配置", exact: true }).tap();
  await phone.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await phone
      .locator(".profile-picker")
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    true,
  );
  await phone.screenshot({
    path: `artifacts/exit-required-profile-picker-${engine}-phone-switch.png`,
  });
  await phone.getByRole("button", { name: "工作台", exact: true }).tap();
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
      unboundCardBlockedAndMenuUsable: true,
      noAutomaticFirstExit: true,
      createThenBindThenExplicitOpen: true,
      shellCreateUsesUnifiedPicker: true,
      unboundResumeReturnsToPicker: true,
      exitWarningChecks,
      proxyChanges,
      phoneLayout: layout,
      loadRetry: true,
      pickerLogout: true,
      menuPickerReturnAndSwitch: true,
      phoneSmallScreenAndLandscape: true,
      renameCancelEscapeSaveAndRetry: true,
      renamePersistsAfterReload: true,
      renameCurrentWithoutSwitching: true,
      phoneRenameLayout: renameLayout,
      phoneMenuLayout: menuLayout,
      cardMenuEscapeAndOutsideClose: true,
      defaultConfigPersistsAndSortsFirst: true,
      nonDefaultDeleteCancelAndConfirm: true,
      phoneDefaultAndDeleteWithoutSwitching: true,
    }),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  clearTimeout(watchdog);
}
