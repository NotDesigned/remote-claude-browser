// Local fixture only: exercises proxy and CPA management without importing real secrets.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium, webkit } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");
const root = resolve("packages/viewer/dist");
const engine = process.env.NETWORK_UI_BROWSER ?? "chromium";
const sources = [
  {
    id: "source-shared",
    name: "共享节点",
    visibility: "shared",
    ownerId: "admin",
    nodeCount: 1,
    subscription: false,
    updatedAt: 1,
  },
];
const proxies = [
  {
    id: "proxy-shared",
    sourceId: "source-shared",
    name: "共享出口",
    type: "socks5",
    visibility: "shared",
    ownerId: "admin",
  },
];
proxies.push(
  {
    id: "proxy-private",
    sourceId: "source-private",
    name: "私有出口",
    type: "socks5",
    visibility: "private",
    ownerId: "reader",
  },
  {
    id: "proxy-admin",
    sourceId: "source-admin",
    name: "管理员出口",
    type: "socks5",
    visibility: "private",
    ownerId: "admin",
  },
);
const instances = [
  {
    id: "cpa-shared",
    ownerId: null,
    scope: "shared",
    desiredState: "running",
    status: "running",
    createdAt: 1,
  },
];
const credentials = new Map();
const oauthProxies = new Map();
const keys = new Map();
const operations = [];
const errors = [];
let profileProxyId = null;
const sessions = [];
const json = (response, body, status = 200) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
};
let serial = 0;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture.test");
    const user = request.headers.cookie?.includes("fixture-role=user")
      ? { id: "reader", username: "reader", role: "user" }
      : { id: "admin", username: "admin", role: "admin" };
    const manage = (item) => user.role === "admin" || item.ownerId === user.id;
    const visibleProxy = (id) =>
      typeof id === "string" &&
      proxies.some((item) => item.id === id && (item.visibility === "shared" || manage(item)));
    if (url.pathname === "/api/me") return json(response, { user });
    if (url.pathname === "/api/accounts")
      return json(response, {
        accounts: [
          {
            id: "default",
            name: "默认配置",
            running: false,
            sessions: 0,
            signedIn: false,
            proxyId: profileProxyId,
            proxyName: proxies.find((item) => item.id === profileProxyId)?.name ?? null,
          },
        ],
        current: url.searchParams.has("sid") ? "default" : null,
        default: "default",
      });
    if (url.pathname === "/api/accounts/default/proxy" && request.method === "PATCH") {
      const input = await body(request);
      profileProxyId = input.proxyId;
      operations.push({ type: "profile-proxy", input });
      return json(response, { id: "default", proxyId: profileProxyId });
    }
    if (url.pathname === "/api/client/session" && request.method === "POST") {
      sessions.push(await body(request));
      return json(response, {
        sid: "client-1",
        label: "Fixture",
        maxClients: 8,
        available: 7,
        sharedAccount: true,
      });
    }
    if (/^\/api\/client\/session\/[^/]+\/cpa\/oauth$/.test(url.pathname)) {
      const input = await body(request);
      operations.push({ type: "oauth-open-remote", input });
      return json(response, { ok: true });
    }
    if (url.pathname.endsWith("/theme")) return json(response, { theme: "auto", applied: true });
    if (url.pathname.endsWith("/downloads")) return json(response, []);
    if (url.pathname === "/api/proxies")
      return json(response, {
        proxies: proxies.filter((item) => item.visibility === "shared" || manage(item)),
      });
    if (url.pathname === "/api/proxy-sources") {
      if (request.method === "GET")
        return json(response, {
          sources: sources
            .filter((item) => item.visibility === "shared" || manage(item))
            .map((item) => ({ ...item, canManage: manage(item) })),
        });
      const input = await body(request);
      operations.push({ type: "source-create", input });
      const source = {
        id: `source-${++serial}`,
        name: input.name,
        visibility: input.visibility,
        ownerId: user.id,
        nodeCount: 1,
        subscription: !!input.url,
        updatedAt: Date.now(),
      };
      sources.push(source);
      return json(response, { source: { ...source, canManage: true } });
    }
    if (url.pathname.startsWith("/api/proxy-sources/")) {
      const id = url.pathname.split("/")[3];
      const source = sources.find((item) => item.id === id);
      if (!manage(source)) return json(response, { error: "没有管理来源的权限" }, 403);
      operations.push({
        type:
          request.method === "DELETE"
            ? "source-delete"
            : url.pathname.endsWith("/refresh")
              ? "source-refresh"
              : "source-update",
        id,
      });
      if (request.method === "DELETE") {
        sources.splice(sources.indexOf(source), 1);
        return response.writeHead(204).end();
      }
      if (request.method === "PATCH") Object.assign(source, await body(request));
      return json(response, { source: { ...source, canManage: true } });
    }
    if (url.pathname === "/api/cpa/instances") {
      if (request.method === "GET")
        return json(response, {
          instances: instances
            .filter((item) => item.scope === "shared" || manage(item))
            .map((item) => ({ ...item, canManage: manage(item) })),
        });
      const input = await body(request);
      const instance = {
        id: `cpa-${++serial}`,
        ownerId: user.id,
        scope: input.scope,
        desiredState: "stopped",
        status: "stopped",
        createdAt: Date.now(),
      };
      instances.push(instance);
      credentials.set(instance.id, [
        {
          name: "legacy-claude.json",
          provider: "claude",
          email: "legacy@example.com",
          disabled: false,
          unavailable: false,
          proxyId: null,
        },
      ]);
      keys.set(instance.id, []);
      return json(response, { instance: { ...instance, canManage: true } });
    }
    if (url.pathname.startsWith("/api/cpa/instances/")) {
      const [, , , , id, action, detail] = url.pathname.split("/");
      const instance = instances.find((item) => item.id === id);
      if (!manage(instance))
        return json(response, { error: "CPA_FORBIDDEN", message: "没有管理此实例的权限" }, 403);
      const input =
        request.method === "GET" || request.method === "DELETE" ? {} : await body(request);
      operations.push({ type: `cpa-${action}${detail ? "-" + detail : ""}`, id, input });
      if (action === "start" || action === "stop") {
        instance.status = action === "start" ? "running" : "stopped";
        instance.desiredState = instance.status;
        return json(response, { instance: { ...instance, canManage: true } });
      }
      if (action === "credentials") {
        const saved = credentials.get(id) ?? [];
        if (request.method === "GET") return json(response, { credentials: saved });
        if (request.method === "DELETE") {
          credentials.set(
            id,
            saved.filter((item) => item.name !== url.searchParams.get("name")),
          );
          return json(response, { ok: true });
        }
        if (detail === "proxy" && !visibleProxy(input.proxyId))
          return json(response, { error: "CPA_EXIT_REQUIRED", message: "请选择代理节点" }, 400);
        Object.assign(
          saved.find((item) => item.name === input.name),
          detail === "status" ? { disabled: input.disabled } : { proxyId: input.proxyId },
        );
        return json(response, { ok: true });
      }
      if (action === "oauth") {
        if (detail === "callback") {
          credentials.set(id, [
            {
              name: "fixture-claude.json",
              provider: "claude",
              email: "fixture@example.com",
              disabled: false,
              unavailable: false,
              proxyId: oauthProxies.get(id),
            },
          ]);
          return json(response, { ok: true });
        }
        if (detail === "status") return json(response, { status: "ok" });
        if (!visibleProxy(input.proxyId))
          return json(response, { error: "CPA_EXIT_REQUIRED", message: "请选择代理节点" }, 400);
        oauthProxies.set(id, input.proxyId);
        return json(response, {
          url: "https://example.com/fixture-oauth",
          state: "fixture-state",
          status: "ok",
        });
      }
      if (action === "keys") {
        const saved = keys.get(id) ?? [];
        if (request.method === "GET") return json(response, { keys: saved });
        if (request.method === "DELETE") {
          keys.set(
            id,
            saved.filter((item) => item.id !== detail),
          );
          return json(response, { ok: true });
        }
        const key = {
          id: `key-${++serial}`,
          instanceId: id,
          name: input.name,
          prefix: "rcpa_fixture",
          createdAt: Date.now(),
        };
        saved.push(key);
        keys.set(id, saved);
        return json(response, { key: { ...key, token: "rcpa_fixture-once-only-token" } });
      }
    }
    if (url.pathname.startsWith("/api/")) return json(response, {}, 404);
    const file = resolve(root, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
    if (!file.startsWith(root + "/")) return response.writeHead(403).end();
    const bytes = await readFile(file);
    response
      .writeHead(200, {
        "content-type":
          { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(file)] ??
          "application/octet-stream",
      })
      .end(bytes);
  } catch (error) {
    if (error.code === "ENOENT") response.writeHead(404).end();
    else {
      errors.push(String(error));
      json(response, { error: "Fixture failure" }, 500);
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
  const checks = [];
  for (const mobile of [false, true]) {
    profileProxyId = null;
    const context = await browser.newContext(
      mobile
        ? { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true }
        : { viewport: { width: 1280, height: 900 } },
    );
    if (mobile) await context.addCookies([{ name: "fixture-role", value: "user", url: origin }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const dialogs = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    const click = (locator) => (mobile ? locator.tap() : locator.click());
    await page.goto(origin);
    const sessionsBeforeExit = sessions.length;
    const profileCard = page.getByRole("button", { name: /默认配置.*未登录/ });
    await profileCard.waitFor();
    assert.equal(await profileCard.isDisabled(), true);
    const unboundText = await profileCard.locator(".profile-exit").evaluateAll((lines) =>
      lines.map((line) => ({
        scrollWidth: line.scrollWidth,
        clientWidth: line.clientWidth,
        scrollHeight: line.scrollHeight,
        clientHeight: line.clientHeight,
      })),
    );
    assert.ok(
      unboundText.every(
        (line) =>
          line.scrollWidth <= line.clientWidth + 1 && line.scrollHeight <= line.clientHeight + 1,
      ),
      JSON.stringify(unboundText),
    );
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({
      path: `artifacts/exit-required-picker-${engine}-${mobile ? "phone" : "desktop"}.png`,
    });
    for (const proxyId of ["proxy-shared", "proxy-private", ""]) {
      await click(page.getByRole("button", { name: "管理「默认配置」", exact: true }));
      await click(page.getByRole("button", { name: "设置出口", exact: true }));
      const editor = page.locator(".profile-proxy-editor");
      const select = editor.getByLabel("「默认配置」的网络出口", { exact: true });
      await select.waitFor();
      if (proxyId === "proxy-shared") assert.equal(await select.inputValue(), "");
      assert.equal(
        await select.locator('option[value=""]').textContent(),
        "未选择出口（禁止打开）",
      );
      if (proxyId === "proxy-shared")
        await page.screenshot({
          path: `artifacts/exit-required-editor-${engine}-${mobile ? "phone" : "desktop"}.png`,
        });
      const choices = await select
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value));
      assert.ok(
        choices.includes("") &&
          choices.includes("proxy-shared") &&
          choices.includes("proxy-private"),
        JSON.stringify({ mobile, proxyId, choices }),
      );
      if (mobile) assert.ok(!choices.includes("proxy-admin"));
      await select.selectOption(proxyId);
      const previousProxy = profileProxyId;
      const dialogsBeforeSave = dialogs.length;
      await click(editor.getByRole("button", { name: "保存出口", exact: true }));
      await editor.waitFor({ state: "hidden" });
      assert.equal(dialogs.length - dialogsBeforeSave, previousProxy ? 1 : 0);
      if (previousProxy) assert.match(dialogs.at(-1), /IP.*风控/);
      assert.deepEqual(operations.at(-1), {
        type: "profile-proxy",
        input: { proxyId: proxyId || null },
      });
      await page
        .getByText(
          `出口：${proxyId === "proxy-shared" ? "共享出口" : proxyId === "proxy-private" ? "私有出口" : "未选择（禁止打开）"}`,
          { exact: true },
        )
        .waitFor();
      assert.equal(await profileCard.isDisabled(), proxyId === "");
    }
    assert.equal(sessions.length, sessionsBeforeExit);
    // A configured default profile is not a current browser session.
    profileProxyId = "proxy-shared";
    await page.reload();
    await page.getByText("出口：共享出口", { exact: true }).waitFor();
    await click(page.getByRole("button", { name: "代理与 API", exact: true }));
    const panel = page.getByRole("dialog", { name: "代理与 API", exact: true });
    assert.equal(await page.locator('#shell[data-picking="true"]').count(), 1);
    assert.equal(await page.locator(".network-panel-backdrop").isVisible(), true);
    await panel.getByLabel("来源名称", { exact: true }).fill(mobile ? "手机来源" : "桌面来源");
    await panel
      .getByLabel("节点内容", { exact: true })
      .fill("socks5://fixture-secret@proxy.example:1080");
    await click(panel.getByRole("button", { name: "导入来源", exact: true }));
    await panel.getByText("代理来源已导入。", { exact: true }).waitFor();
    assert.equal(operations.at(-1).input.visibility, "private");
    const sourceName = mobile ? "手机来源" : "桌面来源";
    await click(panel.getByRole("button", { name: `编辑来源「${sourceName}」`, exact: true }));
    await panel.getByLabel("来源名称", { exact: true }).fill(sourceName + "更新");
    await click(panel.getByRole("button", { name: "保存来源", exact: true }));
    await panel.getByText("来源已更新。", { exact: true }).waitFor();
    await panel.getByLabel("来源名称", { exact: true }).fill(sourceName + "订阅");
    await panel.getByLabel("导入方式").selectOption("url");
    await panel
      .getByLabel("订阅 URL", { exact: true })
      .fill("https://example.com/fixture-subscription");
    await click(panel.getByRole("button", { name: "导入来源", exact: true }));
    await panel.getByText("代理来源已导入。", { exact: true }).waitFor();
    await click(panel.getByRole("button", { name: `刷新订阅「${sourceName}订阅」`, exact: true }));
    await panel.getByText("订阅已刷新。", { exact: true }).waitFor();
    await click(panel.getByRole("button", { name: `删除来源「${sourceName}订阅」`, exact: true }));
    await panel.getByText("来源已删除。", { exact: true }).waitFor();
    await click(panel.getByRole("tab", { name: "CPA 授权与 Key", exact: true }));
    if (mobile) {
      await panel.getByText("此实例由管理员管理。", { exact: true }).waitFor();
      assert.equal(
        await panel.getByRole("button", { name: "生成 API Key", exact: true }).count(),
        0,
      );
    }
    await page.route("**/api/cpa/instances", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "CPA_OPERATION", message: "实例暂不可用" }),
          })
        : route.continue(),
    );
    await click(panel.getByRole("button", { name: "创建我的 CPA 实例", exact: true }));
    await panel.getByRole("alert").filter({ hasText: "实例暂不可用" }).waitFor();
    await page.unroute("**/api/cpa/instances");
    await click(panel.getByRole("button", { name: "创建我的 CPA 实例", exact: true }));
    await panel.getByRole("button", { name: "启动实例", exact: true }).waitFor();
    await click(panel.getByRole("button", { name: "启动实例", exact: true }));
    await panel.getByRole("button", { name: "停止实例", exact: true }).waitFor();
    const ownInstance = instances.find(
      (item) => item.scope === "user" && item.ownerId === (mobile ? "reader" : "admin"),
    );
    const oauthProxy = panel.getByLabel("授权使用的代理");
    const generateOAuth = panel.getByRole("button", { name: "生成 Claude 授权链接", exact: true });
    await oauthProxy.waitFor();
    await oauthProxy.locator('option[value="proxy-shared"]').waitFor({ state: "attached" });
    assert.equal(
      await oauthProxy.inputValue(),
      "",
      "the picker has no current browser exit to inherit",
    );
    assert.equal(
      await oauthProxy.locator('option[value=""]').evaluate((option) => option.disabled),
      true,
    );
    assert.equal(await generateOAuth.isDisabled(), true);
    const legacyProxy = panel.getByLabel("凭据「legacy-claude.json」的代理");
    await legacyProxy.waitFor();
    assert.equal(await legacyProxy.inputValue(), "");
    assert.equal(
      await legacyProxy.locator('option[value=""]').evaluate((option) => option.disabled),
      true,
    );
    assert.equal(
      await legacyProxy.locator('option[value=""]').textContent(),
      "未绑定节点（沿用当前出口）",
    );
    const proxyUpdates = operations.filter((item) => item.type === "cpa-credentials-proxy").length;
    await click(panel.getByRole("button", { name: "刷新实例", exact: true }));
    await legacyProxy.waitFor();
    assert.equal(credentials.get(ownInstance.id)[0].proxyId, null);
    assert.equal(
      operations.filter((item) => item.type === "cpa-credentials-proxy").length,
      proxyUpdates,
    );
    const missingOAuth = await page.request.post(
      origin + `/api/cpa/instances/${ownInstance.id}/oauth`,
      {
        data: { provider: "claude" },
      },
    );
    assert.equal(
      missingOAuth.status(),
      400,
      "the fixture must reject a missing authorization node",
    );
    const defaultCredential = await page.request.patch(
      origin + `/api/cpa/instances/${ownInstance.id}/credentials/proxy`,
      { data: { name: "legacy-claude.json", proxyId: null } },
    );
    assert.equal(
      defaultCredential.status(),
      400,
      "the fixture must reject a default credential exit",
    );
    assert.equal(credentials.get(ownInstance.id)[0].proxyId, null);
    await oauthProxy.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `artifacts/cpa-explicit-proxy-${engine}-${mobile ? "phone" : "desktop"}.png`,
    });
    await legacyProxy.selectOption("proxy-shared");
    await panel.getByText("凭据代理已更新。", { exact: true }).waitFor();
    await click(panel.getByRole("button", { name: "删除凭据", exact: true }));
    await panel.getByText("legacy@example.com", { exact: true }).waitFor({ state: "hidden" });
    await oauthProxy.selectOption("proxy-private");
    await click(panel.getByRole("button", { name: "生成 Claude 授权链接", exact: true }));
    await panel.getByRole("button", { name: "在远程浏览器中打开授权页", exact: true }).waitFor();
    assert.deepEqual(operations.at(-1), {
      type: "cpa-oauth",
      id: ownInstance.id,
      input: { provider: "claude", proxyId: "proxy-private" },
    });
    await panel
      .getByLabel("授权回调 URL 或授权码", { exact: true })
      .fill("http://localhost:54545/callback?code=fixture&state=fixture-state");
    await click(panel.getByRole("button", { name: "提交授权回调", exact: true }));
    await panel.getByText("回调已提交，可检查授权状态。", { exact: true }).waitFor();
    await click(panel.getByRole("button", { name: "检查授权状态", exact: true }));
    await panel.getByText("Claude 授权已完成。", { exact: true }).waitFor();
    assert.equal(
      await panel.getByLabel("凭据「fixture-claude.json」的代理").inputValue(),
      "proxy-private",
    );
    await panel.getByLabel("凭据「fixture-claude.json」的代理").selectOption("proxy-shared");
    await panel.getByText("凭据代理已更新。", { exact: true }).waitFor();
    await click(panel.getByRole("button", { name: "停用凭据", exact: true }));
    await panel.getByRole("button", { name: "启用凭据", exact: true }).waitFor();
    await panel.getByLabel("新 Key 名称", { exact: true }).fill("测试客户端");
    await click(panel.getByRole("button", { name: "生成 API Key", exact: true }));
    await panel.getByLabel("新 API Key（仅此一次）", { exact: true }).waitFor();
    assert.equal(
      await panel.getByLabel("新 API Key（仅此一次）", { exact: true }).inputValue(),
      "rcpa_fixture-once-only-token",
    );
    assert.equal(
      await panel.getByLabel("API Base URL", { exact: true }).inputValue(),
      origin + "/v1",
    );
    await click(panel.getByRole("button", { name: "已保存，隐藏", exact: true }));
    await click(panel.getByRole("button", { name: "撤销 API Key「测试客户端」", exact: true }));
    await panel
      .getByRole("button", { name: "撤销 API Key「测试客户端」", exact: true })
      .waitFor({ state: "hidden" });
    await click(panel.getByRole("button", { name: "删除凭据", exact: true }));
    await panel.getByText("fixture@example.com", { exact: true }).waitFor({ state: "hidden" });
    await click(panel.getByRole("button", { name: "停止实例", exact: true }));
    await panel.getByRole("button", { name: "启动实例", exact: true }).waitFor();
    const layout = await panel.evaluate((node) => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      viewport: innerWidth,
      width: node.clientWidth,
      scroll: node.scrollWidth,
      inputs: [...node.querySelectorAll("input,textarea,select")].map((input) =>
        parseFloat(getComputedStyle(input).fontSize),
      ),
      buttons: [...node.querySelectorAll("button")]
        .filter((button) => button.getClientRects().length)
        .map((button) => button.getBoundingClientRect().height),
    }));
    assert.ok(
      layout.left >= 0 && layout.right <= layout.viewport + 1 && layout.scroll <= layout.width + 1,
    );
    assert.ok(layout.buttons.every((height) => height >= 44));
    if (mobile) assert.ok(layout.inputs.every((size) => size >= 16));
    const storage = await page.evaluate(() =>
      JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]),
    );
    assert.ok(
      !storage.includes("fixture-secret") && !storage.includes("rcpa_fixture-once-only-token"),
    );
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({
      path: `artifacts/network-panel-${engine}-${mobile ? "phone" : "desktop"}.png`,
    });
    await click(panel.getByRole("button", { name: "关闭代理与 API 管理", exact: true }));
    await panel.waitFor({ state: "hidden" });
    await click(page.getByRole("button", { name: "管理「默认配置」", exact: true }));
    await click(page.getByRole("button", { name: "设置出口", exact: true }));
    const openExit = page.getByLabel("「默认配置」的网络出口", { exact: true });
    assert.equal(await openExit.inputValue(), "proxy-shared");
    await openExit.selectOption("proxy-private");
    const dialogsBeforeOpenExit = dialogs.length;
    await click(page.getByRole("button", { name: "保存出口", exact: true }));
    await page.getByText("出口：私有出口", { exact: true }).waitFor();
    assert.equal(dialogs.length, dialogsBeforeOpenExit + 1);
    assert.match(dialogs.at(-1), /IP.*风控/);
    assert.equal(sessions.length, sessionsBeforeExit);
    await click(page.getByRole("button", { name: /默认配置.*未登录/ }));
    await page.waitForURL((url) => url.searchParams.has("sid"));
    await click(page.getByRole("button", { name: /^更多/ }));
    await click(page.getByRole("button", { name: "选择浏览器配置…", exact: true }));
    await page.getByRole("button", { name: "返回会话", exact: true }).waitFor();
    const toolbarLayout = await page.locator(".profile-topbar").evaluate((node) => ({
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
      viewport: innerWidth,
      width: node.clientWidth,
      scroll: node.scrollWidth,
    }));
    assert.ok(
      toolbarLayout.left >= 0 &&
        toolbarLayout.right <= toolbarLayout.viewport + 1 &&
        toolbarLayout.scroll <= toolbarLayout.width + 1,
    );
    await click(page.getByRole("button", { name: "代理与 API", exact: true }));
    await panel.waitFor();
    await click(panel.getByRole("tab", { name: "CPA 授权与 Key", exact: true }));
    const inheritedOAuthProxy = panel.getByLabel("授权使用的代理");
    await inheritedOAuthProxy.waitFor();
    await panel.getByText("默认使用当前浏览器配置的出口，可单独更改。", { exact: true }).waitFor();
    assert.equal(
      await inheritedOAuthProxy.inputValue(),
      "proxy-private",
      "authorization must inherit the current profile exit rather than the first visible node",
    );
    assert.equal(
      await inheritedOAuthProxy.locator("option:not([disabled])").first().getAttribute("value"),
      "proxy-shared",
    );
    await click(panel.getByRole("button", { name: "启动实例", exact: true }));
    await panel.getByRole("button", { name: "停止实例", exact: true }).waitFor();
    await inheritedOAuthProxy.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `artifacts/cpa-inherited-proxy-${engine}-${mobile ? "phone" : "desktop"}.png`,
    });
    await inheritedOAuthProxy.selectOption("proxy-shared");
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/cpa/instances" &&
        response.request().method() === "GET",
    );
    await click(panel.getByRole("button", { name: "刷新实例", exact: true }));
    await refreshed;
    assert.equal(
      await inheritedOAuthProxy.inputValue(),
      "proxy-shared",
      "a rerender must preserve the manual override",
    );
    await click(panel.getByRole("button", { name: "生成 Claude 授权链接", exact: true }));
    await panel.getByRole("button", { name: "在远程浏览器中打开授权页", exact: true }).waitFor();
    assert.deepEqual(operations.filter((item) => item.type === "cpa-oauth").at(-1).input, {
      provider: "claude",
      proxyId: "proxy-shared",
    });
    const remoteOpen = panel.getByRole("button", { name: "在远程浏览器中打开授权页", exact: true });
    assert.equal(await remoteOpen.isDisabled(), true, "different browser exit must block opening");
    await inheritedOAuthProxy.selectOption("proxy-private");
    await remoteOpen.waitFor({ state: "hidden" });
    await click(panel.getByRole("button", { name: "生成 Claude 授权链接", exact: true }));
    await remoteOpen.waitFor();
    assert.equal(await remoteOpen.isDisabled(), false);
    const popupEvents = [];
    page.on("popup", (popup) => popupEvents.push(popup));
    await click(remoteOpen);
    await panel.waitFor({ state: "hidden" });
    assert.equal(operations.at(-1).type, "oauth-open-remote");
    assert.equal(popupEvents.length, 0, "OAuth must not open a local external browser tab");
    assert.equal(
      await page.getByRole("button", { name: "返回会话", exact: true }).count(),
      0,
      "remote OAuth must dismiss the profile picker",
    );
    await click(page.getByRole("button", { name: /^更多/ }));
    await click(page.getByRole("button", { name: "代理与 API", exact: true }));
    await remoteOpen.waitFor();
    await panel.getByLabel("授权回调 URL 或授权码").waitFor();
    await click(panel.getByRole("button", { name: "关闭代理与 API 管理", exact: true }));
    checks.push({
      mobile,
      privateImportEditSubscriptionRefreshDelete: true,
      ownInstanceLifecycle: true,
      oauthCallback: true,
      oauthInheritsCurrentBrowserExit: true,
      oauthManualOverridePreserved: true,
      noCurrentBrowserRequiresExplicitNode: true,
      legacyCredentialUnchangedUntilExplicitSelection: true,
      noDeploymentDefaultOption: true,
      credentialProxyStatusDelete: true,
      keyOnceAndRevoke: true,
      sharedAdminOnly: true,
      profileSharedPrivateAndUnassignedExit: true,
      unboundProfilesBlocked: true,
      noAutomaticFirstExit: true,
      proxySaveWithoutSessionAllocation: true,
      networkPanelVisibleOverPicker: true,
      pickerToolbarWithBackAndNetwork: toolbarLayout,
      layout,
    });
    await context.close();
  }
  // A delayed response for the private instance must never populate the shared instance.
  {
    const own = instances.find((item) => item.ownerId === "admin" && item.scope === "user");
    own.status = "running";
    instances.find((item) => item.scope === "shared").status = "running";
    credentials.set(own.id, [
      {
        name: "same.json",
        email: "private-race@example.test",
        provider: "claude",
        proxyId: "proxy-admin",
      },
    ]);
    credentials.set("cpa-shared", [
      {
        name: "same.json",
        email: "shared-race@example.test",
        provider: "claude",
        proxyId: "proxy-shared",
      },
    ]);
    const context = await browser.newContext();
    const page = await context.newPage();
    let release, seen;
    const held = new Promise((resolve) => (release = resolve));
    const requested = new Promise((resolve) => (seen = resolve));
    await page.route(`**/api/cpa/instances/${own.id}/credentials`, async (route) => {
      seen();
      await held;
      await route.continue();
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "代理与 API", exact: true }).click();
    await page.getByRole("tab", { name: "CPA 授权与 Key", exact: true }).click();
    await requested;
    await page.getByRole("button", { name: /共享实例/ }).click();
    await page.getByText("shared-race@example.test", { exact: true }).waitFor();
    const returned = page.waitForResponse((response) =>
      response.url().endsWith(`/api/cpa/instances/${own.id}/credentials`),
    );
    release();
    await returned;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(await page.getByText("private-race@example.test", { exact: true }).count(), 0);
    assert.equal(
      await page.getByText("shared-race@example.test", { exact: true }).isVisible(),
      true,
    );
    checks.push({ lateInstanceResponseDiscarded: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `artifacts/network-ui-smoke-${engine}.json`,
    JSON.stringify({ engine, localFixtureOnly: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ engine, localFixtureOnly: true, checks }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  clearTimeout(watchdog);
}
