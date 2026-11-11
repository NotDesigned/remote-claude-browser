// Sets the container's timezone from TZ before Chrome starts. Nothing is looked up over the network:
// the operator names the zone, and an unset TZ means UTC.
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEZONE = "Etc/UTC";

/** Limit names to IANA identifiers before using them as paths or process environment values. */
export function validTimezone(value) {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)
  )
    return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The zone to use: the configured one, or UTC when none is set. A wrong name is an error. */
export function configuredTimezone(configured) {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (value === "") return DEFAULT_TIMEZONE;
  const timezone = validTimezone(value);
  if (!timezone) throw new Error("TZ must be a valid IANA timezone, such as Asia/Shanghai");
  return timezone;
}

/** The image points /etc/{localtime,timezone} here, so a read-only root can still follow the zone. */
export async function writeTimezoneState(timezone, directory, zoneinfo = "/usr/share/zoneinfo") {
  const checked = validTimezone(timezone);
  if (!checked) throw new Error("Invalid timezone state");
  const source = join(zoneinfo, checked);
  await access(source, constants.R_OK);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  // The browser starts with umask 0077, but system timezone files are public configuration.
  // Explicit modes also repair state written by an earlier container with owner-only access.
  await chmod(directory, 0o755);
  const suffix = `.${process.pid}-${randomUUID()}.next`;
  const localtime = join(directory, "localtime" + suffix);
  const name = join(directory, "name" + suffix);
  try {
    await copyFile(source, localtime, constants.COPYFILE_EXCL);
    await writeFile(name, checked + "\n", { mode: 0o644, flag: "wx" });
    await chmod(localtime, 0o644);
    await chmod(name, 0o644);
    await rename(localtime, join(directory, "localtime"));
    await rename(name, join(directory, "name"));
  } finally {
    await Promise.all([localtime, name].map((path) => unlink(path).catch(() => {})));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const timezone = configuredTimezone(process.env.MIRROR_TIMEZONE ?? process.env.TZ);
    await writeTimezoneState(timezone, "/data/timezone");
    console.error(`Browser timezone: ${timezone}`);
    console.log(timezone);
  } catch {
    console.error(
      "Could not set the browser timezone. TZ must be a valid IANA name; check /data permissions.",
    );
    process.exitCode = 1;
  }
}
