/** Disposable acceptance: no production volumes, credentials or Internet route. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, chown, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const launcher = "/opt/remote-browser/browser-filesystem.sh";
const profile = "/data/profile/own";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function eventually(read, accept) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (accept(value)) return value;
    await delay(50);
  }
  throw new Error("Acceptance condition timed out");
}

function chromium(headful) {
  const child = spawn(
    launcher,
    [
      `/tmp/browser-root-${headful}`,
      profile,
      "/usr/bin/chromium",
      ...(headful ? [] : ["--headless=new"]),
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--enable-logging=stderr",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp/home",
        LANG: "C.UTF-8",
        TZ: "Asia/Tokyo",
        FONTCONFIG_FILE: "/etc/fonts/fonts.conf",
        ...(headful ? { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY } : {}),
      },
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    },
  );
  let pending = "",
    stderr = "",
    seq = 0;
  const calls = new Map();
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("error", () => {});
  child.stdio[4].on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\0")) !== -1) {
      const value = JSON.parse(pending.slice(0, index));
      pending = pending.slice(index + 1);
      const call = calls.get(value.id);
      if (!call) continue;
      calls.delete(value.id);
      clearTimeout(call.timer);
      value.error ? call.fail(new Error(value.error.message)) : call.done(value.result);
    }
  });
  child.once("exit", (code, signal) => {
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.fail(new Error(`Chromium exited (${code}, ${signal}) during ${call.method}: ${stderr}`));
    }
    calls.clear();
  });
  return {
    child,
    send(method, params = {}, sessionId) {
      return new Promise((done, fail) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          calls.delete(id);
          fail(new Error(`${method} timed out: ${stderr}`));
        }, 10000);
        calls.set(id, { done, fail, timer, method: `${method} ${params.url ?? ""}` });
        child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      });
    },
    async close() {
      const exited = new Promise((done) => child.once("exit", done));
      if (child.exitCode !== null || child.signalCode !== null) return;
      await this.send("Browser.close");
      await exited;
    },
    async kill() {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGKILL");
      await exited;
    },
  };
}

async function inside() {
  await mkdir(`${profile}/uploads`, { recursive: true });
  await mkdir(`${profile}/downloads`);
  await mkdir("/data/profile/other");
  await mkdir(`${profile}/zoom-extension`);
  await writeFile(
    `${profile}/zoom-extension/manifest.json`,
    JSON.stringify({
      manifest_version: 3,
      name: "Filesystem acceptance",
      version: "1",
      background: { service_worker: "worker.js" },
    }),
  );
  await writeFile(
    `${profile}/zoom-extension/worker.js`,
    "chrome.runtime.onInstalled.addListener(() => {});",
  );
  await writeFile("/data/profile/users.sqlite", "management-marker");
  await writeFile("/data/profile/other/private.txt", "other-profile-marker");
  await writeFile(`${profile}/uploads/input.txt`, "own-upload");
  await chmod("/data/profile", 0o700);
  await chmod("/data/profile/other", 0o700);
  await chmod("/data/profile/users.sqlite", 0o600);
  await exec("chown", ["-R", "10001:10001", "/data/profile"]);

  // A process inside the same outer boundary as Chrome cannot bypass it with raw filesystem IO.
  const boundaryProbe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    assert.deepEqual(fs.readdirSync('/data/profile'), ['own']);
    assert.equal(fs.readFileSync('${profile}/uploads/input.txt', 'utf8'), 'own-upload');
    assert.equal(fs.readFileSync('/etc/timezone', 'utf8').trim(), 'Asia/Tokyo');
    assert.equal(fs.readlinkSync('/etc/localtime'), '/usr/share/zoneinfo/Asia/Tokyo');
    assert.deepEqual(JSON.parse(fs.readFileSync('/etc/chromium/policies/managed/secure-dns.json', 'utf8')), {
      DnsOverHttpsMode: 'automatic',
      DnsOverHttpsTemplates: 'https://dns.example.test/dns-query',
    });
    assert.equal(JSON.parse(fs.readFileSync('/etc/chromium/policies/managed/remote-browser.json', 'utf8')).PasswordManagerEnabled, false);
    for (const path of ['/data/profile/users.sqlite', '/data/profile/other/private.txt', '/app/package.json', '/run/remote-browser', '/proc/1/root/data/profile/users.sqlite'])
      assert.equal(fs.existsSync(path), false, path);
    for (const pid of fs.readdirSync('/proc').filter(p => /^\\d+$/.test(p)))
      assert.equal(fs.existsSync('/proc/' + pid + '/root/data/profile/users.sqlite'), false);
    assert.throws(() => fs.writeFileSync('/usr/browser-mount-write-probe', 'bad'), /EROFS|EACCES/);
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0000000000000000/);
    fs.writeFileSync('${profile}/persistent-marker', 'retained');
  `;
  await exec(launcher, ["/tmp/probe-root", profile, "/usr/local/bin/node", "-e", boundaryProbe], {
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp/home",
      TZ: "Asia/Tokyo",
      MIRROR_BROWSER_DOH_TEMPLATE: "https://dns.example.test/dns-query",
    },
  });

  const authority = "/tmp/display/authority";
  await mkdir("/tmp/.X11-unix", { mode: 0o1777 });
  await chmod("/tmp/.X11-unix", 0o1777);
  await mkdir("/tmp/display", { mode: 0o700 });
  await exec("xauth", [
    "-f",
    authority,
    "add",
    ":0",
    "MIT-MAGIC-COOKIE-1",
    randomBytes(16).toString("hex"),
  ]);
  await chown("/tmp/display", 10001, 10001);
  await chown(authority, 10001, 10001);
  const display = spawn(
    "setpriv",
    [
      "--reuid=10001",
      "--regid=10001",
      "--clear-groups",
      "Xvfb",
      "-displayfd",
      "3",
      "-screen",
      "0",
      "1280x720x24",
      "-nolisten",
      "tcp",
      "-auth",
      authority,
    ],
    { stdio: ["ignore", "ignore", "inherit", "pipe"] },
  );
  process.env.DISPLAY = await new Promise((done, fail) => {
    display.once("error", fail);
    display.stdio[3].once("data", (chunk) => done(`:${chunk.toString().trim()}`));
  });
  process.env.XAUTHORITY = authority;
  await exec(launcher, [
    "/tmp/display-probe-root",
    profile,
    "/usr/local/bin/node",
    "-e",
    `require('node:assert/strict').deepEqual(require('node:fs').readdirSync('/tmp/.X11-unix'), ['X${process.env.DISPLAY.slice(1)}'])`,
  ]);

  const server = createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="result.txt"',
      });
      response.end("own-download");
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<title>filesystem acceptance</title><input type="file" id="upload">');
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [index, headful] of [false, true, true].entries()) {
      console.log(`Checking ${headful ? "headful" : "headless"} Chromium`);
      const browser = chromium(headful);
      try {
        assert.ok(
          (await browser.send("Extensions.loadUnpacked", { path: `${profile}/zoom-extension` })).id,
        );
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await browser.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const send = (method, params) => browser.send(method, params, sessionId);
        const evaluate = async (expression) =>
          (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
            .result.value;
        await send("Page.navigate", { url: origin });
        await eventually(
          () => evaluate("document.title"),
          (value) => value === "filesystem acceptance",
        );
        assert.equal(
          await evaluate(
            headful
              ? "localStorage.getItem('saved')"
              : "localStorage.setItem('saved','retained');'retained'",
          ),
          "retained",
        );
        if (index === 0) await delay(1500);
        assert.equal(
          await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"),
          "Asia/Tokyo",
        );
        const { root } = await send("DOM.getDocument");
        const { nodeId } = await send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: "#upload",
        });
        await send("DOM.setFileInputFiles", { nodeId, files: [`${profile}/uploads/input.txt`] });
        assert.equal(
          await evaluate("document.querySelector('#upload').files[0].text()"),
          "own-upload",
        );
        await browser.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: `${profile}/downloads`,
        });
        await send("Page.navigate", { url: `${origin}/download` });
        await eventually(
          async () => {
            try {
              return await readFile(`${profile}/downloads/result.txt`, "utf8");
            } catch {
              return null;
            }
          },
          (value) => value === "own-download",
        );
        const screenshot = await send("Page.captureScreenshot", { format: "png" });
        assert.ok(Buffer.from(screenshot.data, "base64").length > 500);
        // A renderer gets Chromium's second PID namespace and seccomp filter, beyond Docker's filter.
        const renderer = await eventually(async () => {
          for (const pid of (await readdir("/proc")).filter((pid) => /^\d+$/.test(pid))) {
            try {
              const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
              if (cmd.includes("--type=renderer") && !cmd.includes("--no-sandbox"))
                return await readFile(`/proc/${pid}/status`, "utf8");
            } catch {
              /* A short-lived renderer may exit during inspection. */
            }
          }
        }, Boolean);
        assert.ok(
          renderer
            .match(/^NSpid:\s+(.+)$/m)[1]
            .trim()
            .split(/\s+/).length >= 3,
        );
        assert.match(renderer, /^Seccomp:\s+2$/m);
        assert.ok(Number(renderer.match(/^Seccomp_filters:\s+(\d+)$/m)[1]) >= 2);
        for (const url of [
          "file:///data/profile/users.sqlite",
          `file://${profile}/persistent-marker`,
        ]) {
          const result = await send("Page.navigate", { url });
          assert.equal(result.errorText, "net::ERR_BLOCKED_BY_ADMINISTRATOR", url);
          assert.notEqual(result.isDownload, true);
          await delay(200);
        }
      } finally {
        if (index === 1) await browser.kill();
        else await browser.close();
      }
    }
    assert.equal(await readFile(`${profile}/persistent-marker`, "utf8"), "retained");
    console.log(
      JSON.stringify({
        filesystemBoundary: true,
        privateProc: true,
        privateDisplay: true,
        nativeUrlPolicy: true,
        chromiumSandbox: true,
        persistentProfile: true,
        upload: true,
        download: true,
        headfulScreenshot: true,
        crashRecovery: true,
        profileExtension: true,
      }),
    );
  } finally {
    display.kill();
    server.close();
  }
}

if (process.argv.includes("--inside")) {
  await inside();
} else {
  const image = process.env.SERVER_IMAGE ?? "remote-claude-browser-server:local";
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:mode=1777",
    "--tmpfs",
    "/data:mode=755",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
  ];
  for (const cap of [
    "SYS_ADMIN",
    "SYS_CHROOT",
    "SETUID",
    "SETGID",
    "CHOWN",
    "KILL",
    "DAC_READ_SEARCH",
  ])
    args.push("--cap-add", cap);
  args.push(
    "--mount",
    `type=bind,src=${resolve("deploy/browser-filesystem.sh")},dst=${launcher},readonly`,
    "--mount",
    `type=bind,src=${script},dst=/acceptance.mjs,readonly`,
    "--entrypoint",
    "node",
    image,
    "/acceptance.mjs",
    "--inside",
  );
  const child = spawn("docker", args, { stdio: "inherit" });
  process.exitCode = await new Promise((done) => child.once("exit", done));
}
