import test from "node:test";
import assert from "node:assert/strict";
import { networkIdentity, validateBrowserOptions, validTimeZone } from "./profile-broker.mjs";

test("profile addresses are stable, isolated /30 networks and safe kernel names", () => {
  const a = networkIdentity("browser-p-1234567890");
  assert.deepEqual(a, networkIdentity("browser-p-1234567890"));
  assert.notEqual(a.subnet, networkIdentity("browser-p-abcdef1234").subnet);
  assert.ok(a.hostIf.length < 16);
  assert.match(a.peerIp, /^10\.253\./);
  assert.match(a.peerIp6, /^fd4d:6972:726f:[a-f0-9]+::2$/);
  assert.notEqual(a.subnet6, networkIdentity("browser-p-abcdef1234").subnet6);
  assert.notEqual(a.subnet6, networkIdentity("browser-p-1234567890", 1).subnet6);
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
  assert.throws(() =>
    validateBrowserOptions({
      userDataDir: "/data/p",
      args: [],
      env: { TZ: "Etc/UTC" },
    }),
  );
});

test("broker accepts only its two installed engines, never a caller's executable path", () => {
  const options = { userDataDir: "/data/p", args: [] };
  assert.equal(validateBrowserOptions(options).engine, "chromium");
  assert.equal(validateBrowserOptions({ ...options, engine: "aliasmode" }).engine, "aliasmode");
  assert.throws(() => validateBrowserOptions({ ...options, engine: "/data/program" }));
  assert.equal(
    validateBrowserOptions({ ...options, executablePath: "/data/program" }).executablePath,
    undefined,
  );
});

test("a remembered zone starts the browser early only when it is a plain IANA name", () => {
  for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "Etc/GMT+5", "UTC"])
    assert.equal(validTimeZone(zone), zone);
  // It becomes TZ, a Chromium argument and a zoneinfo link in the browser's root.
  for (const zone of [
    "../../data/profile",
    "Asia/../../data",
    "/data/profile",
    "Asia/Tokyo --no-sandbox",
    "Not/AZone",
    "asia/tokyo",
    "",
    42,
    undefined,
  ])
    assert.equal(validTimeZone(zone), undefined, String(zone));
});
