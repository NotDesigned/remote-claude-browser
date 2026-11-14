/** One X server per account: clipboard selections and native windows must not cross profiles. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DisplayEnvironment {
  DISPLAY: string;
  XAUTHORITY: string;
}

export interface AccountDisplay {
  env: DisplayEnvironment;
  close(): Promise<void>;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function createAccountDisplay(): Promise<AccountDisplay> {
  const screen = process.env.XVFB_SCREEN ?? "12800x2880x24";
  if (!/^\d{3,5}x\d{3,5}x24$/.test(screen)) throw new Error("Invalid XVFB_SCREEN");
  const dir = await mkdtemp(join(tmpdir(), "mirror-account-display-"));
  const authority = join(dir, "authority");
  const cookie = randomBytes(16).toString("hex");
  const authorize = (display: string) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        "xauth",
        ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", cookie],
        { timeout: 4000 },
        (error) =>
          error ? reject(new Error("Could not create display authorization")) : resolve(),
      );
    });
  let child: ChildProcess | undefined;
  try {
    // The server loads the cookie bytes; the display-number field is for X clients. Bootstrap
    // its authorization first, then add the allocated number to the same client authority file.
    await authorize(":0");
    child = spawn(
      "Xvfb",
      [
        "-displayfd",
        "3",
        "-screen",
        "0",
        screen,
        "-br",
        "-extension",
        "GLX",
        "-nolisten",
        "tcp",
        "-noreset",
        "-auth",
        authority,
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    const owned = child;
    const display = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Account display startup timed out")), 4000);
      const done = (error?: Error, value?: string) => {
        clearTimeout(timer);
        owned.removeListener("error", failed);
        owned.removeListener("exit", exited);
        if (error) reject(error);
        else resolve(value!);
      };
      const failed = () => done(new Error("Could not start account display"));
      const exited = () => done(new Error("Account display exited before readiness"));
      owned.once("error", failed);
      owned.once("exit", exited);
      let value = "";
      (owned.stdio[3] as Readable).on("data", (chunk: Buffer) => {
        value += chunk.toString();
        if (/^\d+\n$/.test(value)) done(undefined, `:${Number(value.trim())}`);
        else if (value.length > 16) done(new Error("Invalid account display readiness"));
      });
    });
    // -displayfd acknowledges only our successfully started server, avoiding socket/number races.
    await authorize(display);
    const env = { DISPLAY: display, XAUTHORITY: authority };
    await new Promise<void>((resolve, reject) => {
      execFile("xdpyinfo", [], { timeout: 4000, env: { ...process.env, ...env } }, (error) =>
        error ? reject(new Error("Account display authorization failed")) : resolve(),
      );
    });
    let closing: Promise<void> | undefined;
    return {
      env,
      close: () =>
        (closing ??= (async () => {
          await terminate(owned);
          await rm(dir, { recursive: true, force: true });
        })()),
    };
  } catch (error) {
    if (child) await terminate(child);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
