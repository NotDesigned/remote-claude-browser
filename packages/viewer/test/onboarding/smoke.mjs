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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/me/mailboxes", (route) =>
    route.fulfill({ json: { enabled: false, addresses: [] } }),
  );
  await page.route("**/onboarding/apple**", (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/apple"))
      return route.fulfill({
        json: {
          tab: "form",
          options: { countries: [["USA", "美国"]], phoneCodes: [["CN", "+86 China Mainland"]] },
        },
      });
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ json: { filled: false, watching: false } });
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
  await page.getByRole("button", { name: "填写并前往 Apple" }).click();
  await page.getByRole("heading", { name: "请在 Apple 页面补全资料" }).waitFor();
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].lastName, generatedLastName);
  assert.equal(submissions[0].firstName, generatedFirstName);
  assert.equal(submissions[0].phoneCode, "CN");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
