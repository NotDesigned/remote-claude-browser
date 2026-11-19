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
  const errors = [];
  const submissions = [];
  const codes = [];
  let stage = "captcha";
  let allowSms = false;
  const image = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/me/mailboxes", (route) =>
    route.fulfill({ json: { enabled: false, addresses: [] } }),
  );
  await page.route(/\/onboarding\/apple(?:\/|\?)/, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/apple")) {
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
        stage = body.kind === "captcha" ? "email" : "complete";
        return route.fulfill({ json: { submitted: true } });
      }
      const kind = stage === "email" && allowSms ? "sms" : stage;
      return route.fulfill({
        json: { ready: kind === "sms", expired: false, challenge: { kind, image } },
      });
    }
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { filled: true, watching: true } });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/onboarding/`);
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
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("img", { name: "Apple 图形验证码" }).waitFor();
  await page.getByLabel("图形验证码", { exact: true }).fill("ABCD");
  await page.getByRole("button", { name: "验证", exact: true }).click();
  await page.getByRole("progressbar", { name: "邮箱验证进度" }).waitFor();
  allowSms = true;
  await page.getByLabel("短信验证码").fill("123456");
  await page.getByRole("button", { name: "验证", exact: true }).click();
  await page.getByRole("heading", { name: "Apple 账户已创建" }).waitFor();
  assert.deepEqual(codes, [
    { kind: "captcha", code: "ABCD" },
    { kind: "sms", code: "123456" },
  ]);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].lastName, generatedLastName);
  assert.equal(submissions[0].firstName, generatedFirstName);
  assert.equal(submissions[0].phoneCode, "CN");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
