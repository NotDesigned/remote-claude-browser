// Local fixture only: exercises the workspace registration form with mocked responses.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use scripts/limited-run.sh");

const server = await createServer({
  root: "packages/viewer",
  server: { port: 0, host: "127.0.0.1" },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage();
  const autoAgree = process.env.APPLE_SMOKE_AUTO_AGREE === "1";
  const errors = [];
  const submissions = [];
  const codes = [];
  const archiveId = "saved-example";
  const relayRequests = [];
  let relayEmail;
  let googleRequests = 0;
  let googleStage = "sms";
  let stage = "captcha";
  let allowSms = false;
  let allowTerms = false;
  const image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/me/mailboxes", (route) =>
    route.fulfill({ json: { enabled: false, addresses: [] } }),
  );
  await page.route(/\/onboarding\/google(?:$|\?|\/)/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/google/google-tab"))
      return route.fulfill({ json: { filled: true, stage: googleStage } });
    if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
    googleRequests++;
    return route.fulfill({
      json: { attempt: "google-attempt", tab: "google-tab", url: "https://mail.google.com/" },
    });
  });
  await page.route(/\/onboarding\/google\/google-tab\/verification/, (route) => {
    if (route.request().method() === "POST") {
      googleStage = "complete";
      return route.fulfill({ json: { challenge: { kind: "complete" } } });
    }
    return route.fulfill({
      json: { ready: false, expired: false, challenge: { kind: googleStage } },
    });
  });
  await page.route(/\/onboarding\/apple(?:\/|\?)/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/accounts/" + archiveId + "/claude")) {
      const payload = route.request().postDataJSON();
      relayRequests.push(payload);
      relayEmail = payload.relayEmail ?? relayEmail;
      return route.fulfill({
        json: {
          email: relayEmail,
          tab: "relay-tab",
          filled: true,
          watching: true,
          requested: true,
        },
      });
    }
    if (url.pathname.endsWith("/accounts"))
      return route.fulfill({
        json: {
          accounts: [
            {
              id: archiveId,
              firstName: "Preview",
              lastName: "User",
              email: "preview@example.com",
              state: "declined",
            },
          ],
        },
      });
    if (url.pathname.endsWith("/accounts/" + archiveId))
      return route.fulfill({
        json: {
          birthday: "2000-01-02",
          country: "USA",
          phoneCode: "CN",
          phone: "2025550100",
          password: "ExamplePass123!",
          relayEmail,
        },
      });
    if (url.pathname.endsWith("/apple")) {
      if (route.request().method() === "DELETE") return route.fulfill({ status: 204 });
      assert.equal(url.searchParams.get("guided"), "true");
      return route.fulfill({
        json: {
          tab: "form",
          options: { countries: [["USA", "美国"]], phoneCodes: [["CN", "+86 China Mainland"]] },
        },
      });
    }
    if (url.pathname.endsWith("/verification")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        codes.push(body);
        if (body.kind === "terms") {
          stage = body.choice === "agree" ? "complete" : "declined";
          return route.fulfill({ json: { challenge: { kind: stage } } });
        }
        stage = body.kind === "captcha" ? "email" : "terms";
        return route.fulfill({ json: { submitted: true } });
      }
      const kind =
        stage === "email" && allowSms ? "sms" : stage === "terms" && !allowTerms ? "sms" : stage;
      return route.fulfill({
        json: { ready: kind === "sms", expired: false, challenge: { kind, image } },
      });
    }
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { filled: true, watching: true } });
  });
  await page.route(/\/onboarding\/claude\/relay-tab\/verification/, (route) =>
    route.fulfill({ json: { ready: false, expired: false } }),
  );
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/onboarding/`);
  await page.getByRole("button", { name: "注册 Google 账户" }).click();
  await page.getByRole("heading", { name: "填写 Google 注册资料" }).waitFor();
  assert.equal(googleRequests, 1);
  await page.getByRole("button", { name: "生成示例", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill("ExamplePass123!");
  await page.getByLabel("确认密码", { exact: true }).fill("ExamplePass123!");
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("heading", { name: "验证 Google 账户" }).waitFor();
  await page.getByLabel("短信验证码", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "验证", exact: true }).click();
  await page.getByRole("heading", { name: "Google 账户已创建" }).waitFor();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "注册 Apple 账户" }).click();
  await page.getByRole("button", { name: "生成示例" }).click();
  const generatedLastName = await page.getByLabel("姓氏").inputValue();
  const generatedFirstName = await page.getByLabel("名字").inputValue();
  assert.ok(generatedLastName);
  assert.ok(generatedFirstName);
  assert.ok(await page.getByLabel("出生日期").inputValue());
  await page.getByLabel("电话号码").fill("2025550100");
  await page.getByLabel("密码", { exact: true }).fill("ExamplePass123!");
  await page.getByLabel("邮箱").fill("preview@example.com");
  if (autoAgree) await page.getByRole("checkbox", { name: "自动同意 iCloud 条款" }).check();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("img", { name: "Apple 图形验证码" }).waitFor();
  await page.getByLabel("图形验证码", { exact: true }).fill("ABCD");
  await page.getByRole("button", { name: "验证", exact: true }).click();
  await page.getByRole("progressbar", { name: "邮箱验证进度" }).waitFor();
  allowSms = true;
  await page.getByLabel("短信验证码").fill("123456");
  await page.getByRole("button", { name: "验证", exact: true }).click();
  await page.getByText("短信验证码已提交，正在等待 Apple 确认。").waitFor();
  allowTerms = true;
  if (!autoAgree) {
    await page.getByRole("heading", { name: "iCloud 条款与条件" }).waitFor();
    assert.equal(codes.length, 2);
    await page.getByRole("button", { name: "不同意", exact: true }).click();
  }
  await page
    .getByRole("heading", { name: autoAgree ? "Apple 账户已创建" : "未接受 iCloud 条款" })
    .waitFor();
  assert.deepEqual(codes, [
    { kind: "captcha", code: "ABCD" },
    { kind: "sms", code: "123456" },
    { kind: "terms", choice: autoAgree ? "agree" : "disagree" },
  ]);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "已保存的 Apple 账户" }).click();
  await page.getByRole("button", { name: /preview@example.com/ }).click();
  await page.getByText("出生日期 2000-01-02 · 地区 USA").waitFor();
  await page.getByRole("button", { name: "复制密码", exact: true }).waitFor();
  await page.getByRole("button", { name: "设置 Claude 转发邮箱", exact: true }).click();
  await page.getByLabel("转发邮箱").fill("demo@privaterelay.appleid.com");
  await page.getByRole("button", { name: "保存并登录 Claude", exact: true }).click();
  await page.getByText("正在等待 Apple 转发 Claude 登录邮件。").waitFor();
  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await page.getByRole("button", { name: "已保存的 Apple 账户" }).click();
  await page.getByRole("button", { name: /preview@example.com/ }).click();
  await page.getByRole("button", { name: "登录 Claude", exact: true }).click();
  await page.getByText("正在等待 Apple 转发 Claude 登录邮件。").waitFor();
  assert.deepEqual(relayRequests, [{ relayEmail: "demo@privaterelay.appleid.com" }, {}]);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].lastName, generatedLastName);
  assert.equal(submissions[0].firstName, generatedFirstName);
  assert.equal(submissions[0].phoneCode, "CN");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
