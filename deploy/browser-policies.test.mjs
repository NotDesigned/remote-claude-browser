import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (name) => readFile(new URL(name, import.meta.url), "utf8");

test("the browser never offers to save a password or other details", async () => {
  const policies = JSON.parse(await read("./browser-policies.json"));
  // "Save password?" and its leak warning are Chromium's own windows, which the picture shows and
  // input cannot reach. Saved site logins are cookies, which these leave alone.
  assert.equal(policies.PasswordManagerEnabled, false);
  assert.equal(policies.PasswordLeakDetectionEnabled, false);
  assert.equal(policies.AutofillAddressEnabled, false);
  assert.equal(policies.AutofillCreditCardEnabled, false);
  assert.equal(policies.TranslateEnabled, false);
  assert.equal(policies.DefaultNotificationsSetting, 2);
  assert.equal(policies.DefaultBrowserSettingEnabled, false);
  assert.equal(policies.BrowserSignin, 0);
});

test("every browser gets the policies, isolated or not", async () => {
  const dockerfile = await read("./Dockerfile.server");
  assert.match(dockerfile, /deploy\/browser-policies\.json/);
  assert.match(dockerfile, /\/etc\/chromium\/policies\/managed\/remote-browser\.json/);
  const filesystem = await read("./browser-filesystem.sh");
  assert.match(
    filesystem,
    /cp "\$\(dirname "\$0"\)\/browser-policies\.json" "\$root\/etc\/chromium\/policies\/managed\/remote-browser\.json"/,
  );
});
