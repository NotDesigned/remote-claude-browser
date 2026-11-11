import assert from "node:assert/strict";
import { chmod, readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  configuredTimezone,
  DEFAULT_TIMEZONE,
  validTimezone,
  writeTimezoneState,
} from "./timezone.mjs";

test("the configured timezone is used as given, and an unset one means UTC", () => {
  assert.equal(configuredTimezone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(configuredTimezone(" Europe/Berlin "), "Europe/Berlin");
  assert.equal(configuredTimezone(undefined), DEFAULT_TIMEZONE);
  assert.equal(configuredTimezone(""), DEFAULT_TIMEZONE);
  assert.equal(DEFAULT_TIMEZONE, "Etc/UTC");
});

test("names without a region are valid IANA zones too", () => {
  for (const name of ["UTC", "CET", "EST5EDT", "Japan"]) assert.ok(validTimezone(name), name);
});

test("anything that is not a timezone name stops the start", () => {
  for (const bad of ["auto", "../../etc/passwd", "Asia/Shanghai\nUTC", "Not/AZone", "-UTC"])
    assert.throws(() => configuredTimezone(bad), /valid IANA timezone/, bad);
});

test("the timezone name and actual zoneinfo bytes survive container restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mirror-timezone-"));
  try {
    await writeTimezoneState("Europe/Berlin", directory);
    assert.equal(await readFile(join(directory, "name"), "utf8"), "Europe/Berlin\n");
    assert.deepEqual(
      await readFile(join(directory, "localtime")),
      await readFile("/usr/share/zoneinfo/Europe/Berlin"),
    );
    await writeTimezoneState("Asia/Tokyo", directory);
    assert.equal(await readFile(join(directory, "name"), "utf8"), "Asia/Tokyo\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timezone state stays publicly readable under the browser's restrictive umask", async () => {
  const root = await mkdtemp(join(tmpdir(), "mirror-timezone-permissions-"));
  const directory = join(root, "timezone");
  const previousUmask = process.umask(0o077);
  const assertPermissions = async () => {
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    for (const name of ["localtime", "name"])
      assert.equal((await stat(join(directory, name))).mode & 0o777, 0o644);
  };
  try {
    await writeTimezoneState("Europe/Berlin", directory);
    await assertPermissions();
    // A restart must fix an existing owner-only directory as well as brand-new state.
    await chmod(directory, 0o700);
    await chmod(join(directory, "localtime"), 0o600);
    await chmod(join(directory, "name"), 0o600);
    await writeTimezoneState("Asia/Tokyo", directory);
    await assertPermissions();
    assert.equal(await readFile(join(directory, "name"), "utf8"), "Asia/Tokyo\n");
  } finally {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  }
});
