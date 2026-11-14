import test from "node:test";
import assert from "node:assert/strict";
import { networkIdentity, validateBrowserOptions } from "./profile-broker.mjs";

test("profile addresses are stable, isolated /30 networks and safe kernel names", () => {
  const a = networkIdentity("browser-p-1234567890");
  assert.deepEqual(a, networkIdentity("browser-p-1234567890"));
  assert.notEqual(a.subnet, networkIdentity("browser-p-abcdef1234").subnet);
  assert.ok(a.hostIf.length < 16);
  assert.match(a.peerIp, /^10\.253\./);
  assert.throws(() => networkIdentity("../../other"));
});

test("broker permits profile environment only and keeps disk writes under its data volume", () => {
  assert.deepEqual(
    validateBrowserOptions({
      userDataDir: "/data/profile",
      args: ["--headless=new"],
      env: { DISPLAY: ":12" },
    }).env,
    { DISPLAY: ":12" },
  );
  assert.throws(() => validateBrowserOptions({ userDataDir: "/etc", args: [] }));
  assert.throws(() => validateBrowserOptions({ userDataDir: "/data/../etc", args: [] }));
  assert.throws(() =>
    validateBrowserOptions({
      userDataDir: "/data/p",
      args: [],
      env: { LD_PRELOAD: "/data/evil.so" },
    }),
  );
});
