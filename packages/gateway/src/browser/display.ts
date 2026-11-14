/** One X server per account: clipboard selections and native windows must not cross profiles. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STARTUP_TIMEOUT_MS = 4000;

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
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  await exited;
  clearTimeout(timer);
}

export async function createAccountDisplay(): Promise<AccountDisplay> {
  const dir = await mkdtemp(join(tmpdir(), "mirror-account-display-"));
  const authority = join(dir, "authority");
  const cookie = randomBytes(16).toString("hex");
  const authorize = (display: string) =>
    new Promise<void>((resolve, reject) =>
      execFile(
        "xauth",
        ["-f", authority, "add", display, "MIT-MAGIC-COOKIE-1", cookie],
        { timeout: STARTUP_TIMEOUT_MS },
        (error) =>
          error ? reject(new Error("Could not create display authorization")) : resolve(),
      ),
    );
  let child: ChildProcess | undefined;
  try {
    // Xvfb reads only the cookie from -auth; the display number is added once it is known.
    await authorize(":0");
    const xvfb = spawn(
      "Xvfb",
      [
        ...["-displayfd", "3", "-screen", "0", process.env.XVFB_SCREEN ?? "12800x2880x24"],
        ...["-br", "-extension", "GLX", "-nolisten", "tcp", "-noreset", "-auth", authority],
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe"] },
    );
    child = xvfb;
    // -displayfd reports the number Xvfb actually bound, so there is no race over free displays.
    const display = await new Promise<string>((resolve, reject) => {
      setTimeout(
        () => reject(new Error("Account display startup timed out")),
        STARTUP_TIMEOUT_MS,
      ).unref();
      xvfb.once("error", () => reject(new Error("Could not start account display")));
      xvfb.once("exit", () => reject(new Error("Account display exited before readiness")));
      let output = "";
      (xvfb.stdio[3] as Readable).on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const number = /^(\d+)\n/.exec(output)?.[1];
        if (number !== undefined) resolve(`:${number}`);
      });
    });
    await authorize(display);
    return {
      env: { DISPLAY: display, XAUTHORITY: authority },
      async close() {
        await terminate(xvfb);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child) await terminate(child);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
