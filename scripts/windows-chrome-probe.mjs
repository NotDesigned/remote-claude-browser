// Run inside the dedicated Windows test VM: node scripts/windows-chrome-probe.mjs [chrome.exe]
// Only an owned temporary profile and a local data: fixture are used; no website accounts.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

assert.equal(process.platform, "win32", "Run this probe inside the Windows test VM");
const chrome =
  process.argv[2] ?? join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe");
const profile = await mkdtemp(join(tmpdir(), "remote-browser-windows-probe-"));
const controller = new AbortController();
const { signal } = controller;
const deadline = setTimeout(() => controller.abort(new Error("Probe exceeded 25 seconds")), 25_000);
// Reject HTTP(S) background traffic locally; this probe does not validate full egress isolation.
const proxy = createServer((connection) => connection.destroy());
const pending = new Map();
let child,
  socket,
  sequence = 0,
  report;
const fail = (error) => {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
};
signal.addEventListener("abort", () => fail(signal.reason), { once: true });
const call = (method, params = {}, sessionId) => {
  signal.throwIfAborted();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
};

try {
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  child = spawn(
    chrome,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  child.once("error", () => controller.abort(new Error("Chrome could not start")));
  child.once("exit", () => controller.abort(new Error("Chrome exited")));
  let endpoint;
  while (!endpoint) {
    signal.throwIfAborted();
    const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const [port, path] = text.trim().split(/\r?\n/);
    if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    else await delay(100, undefined, { signal });
  }
  socket = new WebSocket(endpoint);
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => fail(new Error("CDP disconnected")));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), {
      once: true,
    });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.ok(!response.exceptionDetails, "Local fixture evaluation failed");
    return response.result.value;
  };
  await send("Page.enable");
  const fixture =
    '<!doctype html><meta charset="utf-8"><title>Windows Chrome probe</title><input id="probe" autofocus><p id="echo"></p><script>probe.oninput=()=>echo.textContent=probe.value</script>';
  const loaded = new Promise((resolve, reject) => {
    const receive = ({ data }) => {
      const message = JSON.parse(data);
      if (message.sessionId !== sessionId || message.method !== "Page.loadEventFired") return;
      socket.removeEventListener("message", receive);
      resolve();
    };
    socket.addEventListener("message", receive);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await Promise.all([
    loaded,
    send("Page.navigate", { url: `data:text/html,${encodeURIComponent(fixture)}` }),
  ]);
  await evaluate('document.querySelector("input").focus()');
  await send("Input.insertText", { text: "Windows 123 Aa" });
  assert.equal(await evaluate('document.querySelector("input").value'), "Windows 123 Aa");
  assert.equal(await evaluate('document.querySelector("#echo").textContent'), "Windows 123 Aa");
  const snapshot = await send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
  assert.ok(
    snapshot.documents.length && snapshot.strings.includes("Windows 123 Aa"),
    "DOM snapshot failed",
  );
  const screenshot = await send("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(screenshot.data, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Pixel capture failed");
  const environment = await evaluate(`(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return { userAgent: navigator.userAgent, platform: navigator.platform,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: { width: screen.width, height: screen.height, devicePixelRatio },
      webglRenderer: gl ? gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null };
  })()`);
  assert.match(environment.userAgent, /Windows NT/);
  assert.match(environment.platform, /^Win/);
  report = {
    ok: true,
    scope: "local-windows-chrome-smoke",
    verified: ["native-windows", "cdp-input", "dom-snapshot", "pixel-capture"],
    notVerified: ["egress-isolation", "browser-worker", "full-application"],
    screenshotBytes: png.length,
    ...environment,
  };
} catch (error) {
  process.exitCode = 1;
  report = {
    ok: false,
    scope: "local-windows-chrome-smoke",
    error: String(error.code ?? error.message),
  };
} finally {
  clearTimeout(deadline);
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null)
      await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 3000,
      });
  } catch (error) {
    process.exitCode = 1;
    report = { ...report, ok: false, cleanupError: String(error.code ?? "PROCESS_CLEANUP_FAILED") };
  } finally {
    socket?.close();
    proxy.close();
  }
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    process.exitCode = 1;
    report = { ...report, ok: false, cleanupError: String(error.code ?? "PROFILE_CLEANUP_FAILED") };
  }
}
console.log(JSON.stringify(report, null, 2));
