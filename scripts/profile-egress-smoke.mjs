/** Disposable integration acceptance. Never uses production profiles, accounts or proxy secrets. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, hostname } from "node:os";
import { mkdtemp, writeFile, rm, readFile, stat, chmod, mkdir, chown } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const fixtureBody = (exit) => `${exit}|0123456789abcdefghijklmnopqrstuvwxyz`;
const exitTimeZones = {
  "exit-A": { timeZone: "Asia/Tokyo", winterOffset: -540, summerOffset: -540 },
  "exit-B": { timeZone: "America/Los_Angeles", winterOffset: 480, summerOffset: 420 },
};
const command = async (program, args) =>
  (await exec(program, args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const readInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function dnsQuery() {
  const name = Buffer.concat(
    "smoke.egress.test"
      .split(".")
      .map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
  );
  return Buffer.concat([
    Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    name,
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
}
function dnsAnswer(query, address = [203, 0, 113, 10]) {
  let end = 12;
  while (query[end] !== 0) end += query[end] + 1;
  end += 5;
  const answer = query.readUInt16BE(end - 4) === 1;
  const head = Buffer.from(query.subarray(0, 12));
  head.writeUInt16BE(0x8180, 2);
  head.writeUInt16BE(answer ? 1 : 0, 6);
  head.writeUInt16BE(0, 8);
  head.writeUInt16BE(0, 10);
  return Buffer.concat([
    head,
    query.subarray(12, end),
    answer ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, ...address]) : Buffer.alloc(0),
  ]);
}
async function udpRequest(payload, host, port, bindAddress) {
  const socket = createSocket("udp4");
  try {
    await new Promise((done, fail) => {
      socket.once("error", fail);
      socket.bind(0, bindAddress, done);
    });
    return await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("UDP probe timed out")), 3500);
      socket.once("message", (message) => {
        clearTimeout(timer);
        done(message);
      });
      socket.send(payload, port, host, (error) => {
        if (error) {
          clearTimeout(timer);
          fail(error);
        }
      });
    });
  } finally {
    socket.close();
  }
}
async function cdpProbe(input) {
  const socket = connect(input.socketPath);
  await new Promise((done, fail) => {
    socket.once("connect", done);
    socket.once("error", fail);
  });
  let seq = 0,
    pending = "";
  const calls = new Map();
  const rejectCalls = (error) => {
    for (const call of calls.values()) call.fail(error);
    calls.clear();
  };
  socket.on("error", rejectCalls);
  socket.on("close", () => rejectCalls(new Error("CDP socket closed before the response")));
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\0")) !== -1) {
      const value = JSON.parse(pending.slice(0, index));
      pending = pending.slice(index + 1);
      const call = calls.get(value.id);
      if (call) {
        calls.delete(value.id);
        value.error ? call.fail(new Error(value.error.message)) : call.done(value.result);
      }
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((done, fail) => {
      const id = ++seq;
      calls.set(id, { done, fail });
      socket.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
    });
  const timeout = setTimeout(() => socket.destroy(new Error("CDP probe timed out")), 15000);
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Page.navigate", { url: "http://203.0.113.10/page" }, sessionId);
    let title;
    for (let n = 0; n < 40; n++) {
      title = (
        await send(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          sessionId,
        )
      ).result.value;
      if (title === input.exit) break;
      await delay(100);
    }
    assert.equal(title, input.exit);
    const value = (
      await send(
        "Runtime.evaluate",
        {
          expression: input.persist
            ? "localStorage.setItem('profile-egress','retained');'stored'"
            : "localStorage.getItem('profile-egress')",
          returnByValue: true,
        },
        sessionId,
      )
    ).result.value;
    assert.equal(value, input.persist ? "stored" : "retained");
    const clockProbe = await send(
      "Runtime.evaluate",
      {
        expression: `(async () => {
        const read = () => ({
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          winterOffset: new Date("2026-01-15T12:00:00.000Z").getTimezoneOffset(),
          summerOffset: new Date("2026-07-15T12:00:00.000Z").getTimezoneOffset()
        });
        const url = URL.createObjectURL(new Blob(["onmessage = () => postMessage((" + read.toString() + ")())"], {type: "text/javascript"}));
        const worker = new Worker(url);
        try {
          const result = await new Promise((resolve, reject) => {
            worker.onmessage = event => resolve(event.data);
            worker.onerror = event => reject(new Error(event.message));
            worker.postMessage("read-clock");
          });
          return { main: read(), worker: result };
        } finally { worker.terminate(); URL.revokeObjectURL(url); }
      })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    assert.equal(clockProbe.exceptionDetails, undefined, "clock probe should run in a real Worker");
    const clocks = clockProbe.result.value;
    assert.deepEqual(clocks.main, exitTimeZones[input.exit]);
    assert.deepEqual(clocks.worker, exitTimeZones[input.exit]);
    const image = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    assert.ok(Buffer.from(image.data, "base64").length > 500);
    await send("Page.navigate", { url: "chrome://sandbox" }, sessionId);
    let sandbox;
    for (let n = 0; n < 40; n++) {
      sandbox = (
        await send(
          "Runtime.evaluate",
          { expression: "document.body.innerText", returnByValue: true },
          sessionId,
        )
      ).result.value;
      if (sandbox?.includes("Seccomp-BPF sandbox")) break;
      await delay(50);
    }
    assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/);
    assert.match(sandbox, /PID namespaces\s+Yes/);
    await send("Browser.close");
    return {
      cdpUnixBridge: true,
      navigation: true,
      screenshot: true,
      persistentProfile: !input.persist,
      namespaceSandbox: true,
      seccompSandbox: true,
      timeZone: clocks.main.timeZone,
      workerTimeZone: clocks.worker.timeZone,
      winterOffset: clocks.main.winterOffset,
      summerOffset: clocks.main.summerOffset,
    };
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
async function probe(mode, input) {
  if (mode === "api") return rawApi(input.path, input.method, input.body, input.expectedStatus);
  if (mode === "cdp") return cdpProbe(input);
  if (mode === "range") {
    const require = createRequire("/app/package.json");
    const { ProxyAgent, request } = require("undici");
    const agent = new ProxyAgent(input.proxyUrl);
    try {
      const result = await request("http://203.0.113.10/range", {
        dispatcher: agent,
        headers: { range: "bytes=5-11" },
        headersTimeout: 3500,
        bodyTimeout: 3500,
      });
      assert.equal(result.statusCode, 206);
      assert.equal(result.headers["content-range"], `bytes 5-11/${fixtureBody(input.exit).length}`);
      assert.equal(await result.body.text(), fixtureBody(input.exit).slice(5, 12));
      return { range: true, exit: input.exit };
    } finally {
      await agent.close();
    }
  }
  if (mode === "blocked") {
    await assert.rejects(() =>
      fetch(input.url ?? "http://203.0.113.10/", { signal: AbortSignal.timeout(2500) }),
    );
    return { blocked: true };
  }
  const address = Object.values(networkInterfaces())
    .flat()
    .find(
      (entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("198.18."),
    )?.address;
  assert.ok(address, "namespace eth0 address missing");
  const response = await fetch("http://203.0.113.10/", { signal: AbortSignal.timeout(5000) });
  assert.equal(await response.text(), fixtureBody(input.exit));
  const udp = await udpRequest(Buffer.from("interface-bound"), "203.0.113.10", 12345, address);
  assert.equal(udp.toString(), `${input.exit}:interface-bound`);
  const dns = await udpRequest(dnsQuery(), "203.0.113.53", 53, address);
  assert.equal(dns.readUInt16BE(0), 0x1234);
  assert.deepEqual([...dns.subarray(-4)], [203, 0, 113, 10]);
  return { exit: input.exit, http: true, interfaceBoundUdp: true, dns: true };
}
async function childProbe(mode, input, namespace) {
  const args = [...(namespace ? ["netns", "exec", namespace, "setpriv"] : [])];
  const program = namespace ? "ip" : "setpriv";
  args.push(
    "--reuid=10001",
    "--regid=10001",
    "--clear-groups",
    "--inh-caps=-all",
    "node",
    script,
    "--probe",
    mode,
  );
  return new Promise((done, fail) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code !== 0) return fail(new Error(`Probe ${mode} failed: ${stderr.slice(-1500)}`));
      try {
        done(JSON.parse(stdout));
      } catch (error) {
        fail(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
const api = (path, method, body, expectedStatus = 200) =>
  childProbe("api", { path, method, body, expectedStatus });
async function rawApi(path, method, body, expectedStatus = 200) {
  const response = await new Promise((done, fail) => {
    const req = httpRequest(
      {
        socketPath: "/run/remote-browser/runtime.sock",
        path,
        method,
        headers: { "content-type": "application/json" },
      },
      done,
    );
    req.once("error", fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.equal(response.statusCode, expectedStatus, `Runtime ${path} failed`);
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function startExitFixture(exit, socksPort, targetPort, counters) {
  const server = createServer((req, res) => {
    counters.http++;
    if (req.url === "/geo") {
      counters.geo++;
      res.setHeader("content-type", "application/json");
      if (counters.failGeo) {
        res.writeHead(429);
        res.end(JSON.stringify({ success: false }));
        return;
      }
      res.end(JSON.stringify({ success: true, timezone: { id: exitTimeZones[exit].timeZone } }));
      return;
    }
    if (req.url.endsWith("/chat/completions")) {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: `fixture-${exit}`,
          object: "chat.completion",
          created: 1,
          model: "fixture-model",
          choices: [
            { index: 0, message: { role: "assistant", content: exit }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    if (req.url === "/page") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<!doctype html><title>${exit}</title><body style="font:40px sans-serif;background:#eef">${exit}</body>`,
      );
      return;
    }
    const content = fixtureBody(exit);
    if (req.headers.range) {
      res.writeHead(206, {
        "content-range": `bytes 5-11/${content.length}`,
        "accept-ranges": "bytes",
      });
      res.end(content.slice(5, 12));
    } else res.end(content);
  });
  await new Promise((done) => server.listen(targetPort, "127.0.0.1", done));
  const udp = createSocket("udp4");
  udp.on("message", (message, remote) => {
    const dns = message.length > 16 && message.readUInt16BE(4) === 1 && (message[2] & 0x80) === 0;
    if (dns) counters.dns++;
    else counters.udp++;
    udp.send(
      dns ? dnsAnswer(message) : Buffer.from(`${exit}:${message}`),
      remote.port,
      remote.address,
    );
  });
  await new Promise((done) => udp.bind(targetPort, "127.0.0.1", done));
  const config = {
    log: { loglevel: "warning", access: "none" },
    inbounds: [{ listen: "0.0.0.0", port: socksPort, protocol: "socks", settings: { udp: true } }],
    outbounds: [{ protocol: "freedom", settings: { redirect: `127.0.0.1:${targetPort}` } }],
  };
  const configPath = `/tmp/fixture-${exit}.json`;
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn("/usr/local/bin/xray", ["run", "-config", configPath], { stdio: "ignore" });
  for (let n = 0; n < 60; n++) {
    const ready = await new Promise((done) => {
      const socket = connect(socksPort, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => done(false));
    });
    if (ready) break;
    if (child.exitCode !== null) throw new Error("Fixture Xray failed");
    await delay(50);
  }
  return async () => {
    child.kill();
    server.close();
    udp.close();
  };
}

async function stockCpaProbe(proxyUrl) {
  const { instanceConfig } = await import("/acceptance/cpa-broker.mjs");
  const apiKey = randomBytes(32).toString("base64url");
  const config = instanceConfig({
    apiKey,
    managementKey: randomBytes(32).toString("base64url"),
    proxyUrl,
  });
  config.oauth["auth-dir"] = "/tmp/stock-cpa/auth";
  config["api-keys"] = {
    "openai-compatibility": [
      {
        name: "fixture",
        "base-url": "http://203.0.113.10/v1",
        "request-retry": 0,
        keys: [{ "api-key": "fake-upstream-key" }],
        models: [{ name: "fixture-model", alias: "fixture-model" }],
      },
    ],
  };
  for (const dir of ["/tmp/stock-cpa", "/tmp/stock-cpa/auth", "/tmp/stock-cpa/static"]) {
    await mkdir(dir, { mode: 0o700 });
  }
  const path = "/tmp/stock-cpa/config.json";
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await chown(path, 10003, 10003);
  for (const dir of ["/tmp/stock-cpa/auth", "/tmp/stock-cpa/static", "/tmp/stock-cpa"])
    await chown(dir, 10003, 10003);
  const child = spawn(
    "setpriv",
    [
      "--reuid=10003",
      "--regid=10003",
      "--clear-groups",
      "--inh-caps=-all",
      "/acceptance/CLIProxyAPI",
      "--config",
      path,
      "--local-model",
    ],
    {
      cwd: "/tmp",
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: "/tmp/stock-cpa/auth",
        MANAGEMENT_STATIC_PATH: "/tmp/stock-cpa/static",
      },
    },
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`Stock CPA exited ${child.exitCode}`);
      ready = await fetch("http://127.0.0.1:8317/", { signal: AbortSignal.timeout(200) }).then(
        (r) => r.ok,
        () => false,
      );
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, "Stock CPA startup timed out");
    const result = await fetch("http://127.0.0.1:8317/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ role: "user", content: "local integration probe" }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 200, "Stock CPA inference failed");
    assert.equal((await result.json()).choices[0].message.content, "exit-A");
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      process.kill(-child.pid, "SIGTERM");
      await exited;
    }
  }
}

async function startPrivateDisplay() {
  const authority = "/tmp/profile-egress-xauthority";
  const field = (bytes) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  await writeFile(
    authority,
    Buffer.concat([
      Buffer.from([1, 0]),
      field(Buffer.from(hostname())),
      field(Buffer.from("99")),
      field(Buffer.from("MIT-MAGIC-COOKIE-1")),
      field(randomBytes(16)),
    ]),
    { mode: 0o600 },
  );
  await chown(authority, 10001, 10001);
  const child = spawn(
    "setpriv",
    [
      "--reuid=10001",
      "--regid=10001",
      "--clear-groups",
      "--inh-caps=-all",
      "Xvfb",
      ":99",
      "-screen",
      "0",
      "1360x900x24",
      "-nolisten",
      "tcp",
      "-auth",
      authority,
    ],
    { detached: true, stdio: "ignore" },
  );
  const close = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      process.kill(-child.pid, "SIGTERM");
      await exited;
    }
    await rm(authority, { force: true });
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`Private Xvfb exited ${child.exitCode}`);
      ready = await exec(
        "setpriv",
        ["--reuid=10001", "--regid=10001", "--clear-groups", "xdpyinfo", "-display", ":99"],
        { env: { ...process.env, XAUTHORITY: authority } },
      ).then(
        () => true,
        () => false,
      );
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, "Private Xvfb did not accept its authority file");
    return { env: { DISPLAY: ":99", XAUTHORITY: authority }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function inside() {
  const { startProfileBroker, networkIdentity } = await import("/app/profile-egress-broker.mjs");
  const { createMihomoConfig } = await import("/acceptance/config.mjs");
  const counts = { A: { http: 0, udp: 0, dns: 0, geo: 0 }, B: { http: 0, udp: 0, dns: 0, geo: 0 } };
  const cleanups = [];
  const raceNetwork = networkIdentity("node-fixture-race");
  let broker;
  let stage = "setup";
  await command("ip", ["addr", "add", "203.0.113.10/32", "dev", "lo"]);
  await command("setpriv", [
    "--reuid=10001",
    "--regid=10001",
    "--clear-groups",
    "node",
    "-e",
    "for(const name of ['browser-a','browser-b'])require('fs').mkdirSync('/data/'+name,{recursive:true})",
  ]);
  const direct = createServer((_req, res) => res.end("DIRECT-LEAK"));
  await new Promise((done) => direct.listen(80, "0.0.0.0", done));
  cleanups.push(() => direct.close());
  try {
    cleanups.push(await startExitFixture("exit-A", 11080, 18080, counts.A));
    cleanups.push(await startExitFixture("exit-B", 11081, 18081, counts.B));
    const nodes = {
      A: {
        name: "A",
        type: "socks5",
        server: networkIdentity("node-fixture-a").hostIp,
        port: 11080,
        udp: true,
      },
      B: {
        name: "B",
        type: "socks5",
        server: networkIdentity("node-fixture-b").hostIp,
        port: 11081,
        udp: true,
      },
    };
    const diagnosticNetwork = networkIdentity("diagnostic");
    const diagnosticArgs = [
      diagnosticNetwork.name,
      diagnosticNetwork.hostIf,
      diagnosticNetwork.hostIp,
      diagnosticNetwork.peerIp,
      diagnosticNetwork.subnet,
    ];
    await command("sh", ["/acceptance/profile-network.sh", "start", ...diagnosticArgs]);
    await command("sh", ["/acceptance/profile-network.sh", "stop", ...diagnosticArgs]);
    // Hold one real namespace at its last startup step, before the broker publishes its token.
    await writeFile(
      "/tmp/profile-network-smoke.sh",
      `#!/bin/sh
if [ "$1" = route ] && [ "$2" = ${raceNetwork.name} ]; then
  touch /tmp/profile-egress-race-ready
  while [ ! -e /tmp/profile-egress-race-release ]; do sleep 0.05; done
fi
exec sh /acceptance/profile-network.sh "$@"
`,
      { mode: 0o644 },
    );
    broker = await startProfileBroker({
      secret: "disposable-smoke-secret-not-production",
      networkScript: "/tmp/profile-network-smoke.sh",
      geoUrl: "http://203.0.113.10/geo",
      defaultNode: {
        name: "Default exit fixture",
        type: "socks5",
        server: "127.0.0.1",
        port: 11080,
        udp: true,
      },
      createConfig(node, options) {
        const config = createMihomoConfig(node, options);
        config.dns.nameserver = [
          `udp://203.0.113.53:53#${node.type === "direct" ? "DIRECT" : "EXIT"}`,
        ];
        if (process.env.PROFILE_EGRESS_DEBUG === "1") config["log-level"] = "debug";
        return config;
      },
    });
    stage = "pending-egress-revocation";
    const startingRace = api("/egress/fixture-race/start", "POST", {
      node: { ...nodes.A, server: raceNetwork.hostIp },
    });
    void startingRace.catch(() => {});
    for (let attempt = 0; ; attempt++) {
      if (
        await stat("/tmp/profile-egress-race-ready").then(
          () => true,
          () => false,
        )
      )
        break;
      assert.ok(attempt < 200, "pending startup did not reach the route gate");
      await delay(50);
    }
    const deletingRace = api("/egress/fixture-race", "DELETE");
    await delay(500);
    await writeFile("/tmp/profile-egress-race-release", "release");
    const revokedRace = await startingRace;
    await deletingRace;
    assert.ok(!(await command("ip", ["netns", "list"])).includes(raceNetwork.name));
    await assert.rejects(stat(`/run/remote-browser/${raceNetwork.name}`), { code: "ENOENT" });
    const revokedUrl = new URL(revokedRace.externalProxyUrl);
    const revokedStatus = await new Promise((done, fail) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: 8781,
          path: "http://203.0.113.10/",
          headers: {
            "proxy-authorization": `Basic ${Buffer.from(`${revokedUrl.username}:x`).toString("base64")}`,
          },
        },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      req.once("error", fail);
      req.end();
    });
    assert.equal(revokedStatus, 407);
    stage = "default-egress-lifecycle";
    await api("/egress/deployment-default/start", "POST", {});
    const initialDefaultGeo = counts.A.geo;
    const defaultZones = await Promise.all([
      api("/egress/deployment-default/timezone", "POST"),
      api("/egress/deployment-default/timezone", "POST"),
    ]);
    assert.ok(defaultZones.every((result) => result.timeZone === exitTimeZones["exit-A"].timeZone));
    assert.equal(
      counts.A.geo,
      initialDefaultGeo + 1,
      "the live default namespace shares one Geo request",
    );
    await api("/egress/deployment-default", "DELETE");
    await assert.rejects(
      stat(`/run/remote-browser/${networkIdentity("node-deployment-default").name}`),
      { code: "ENOENT" },
    );
    assert.equal(
      (await api("/egress/deployment-default/timezone", "POST")).timeZone,
      exitTimeZones["exit-A"].timeZone,
    );
    assert.equal(
      counts.A.geo,
      initialDefaultGeo + 2,
      "recreated default namespace probes its exit again",
    );
    await api("/egress/deployment-default", "DELETE");
    stage = "independent-exits";
    const startedA = await api("/egress/fixture-a/start", "POST", { node: nodes.A });
    const startedB = await api("/egress/fixture-b/start", "POST", { node: nodes.B });
    const nsA = networkIdentity("node-fixture-a"),
      nsB = networkIdentity("node-fixture-b");
    assert.notEqual(nsA.name, nsB.name);
    assert.notEqual(startedA.proxyUrl, startedB.proxyUrl);
    const directResult = await command("ip", [
      "netns",
      "exec",
      nsA.name,
      "node",
      "-e",
      "fetch('http://203.0.113.10').then(r=>r.text()).then(console.log)",
    ]);
    assert.equal(directResult, "DIRECT-LEAK");
    const results = [];
    results.push(await childProbe("range", { exit: "exit-A", proxyUrl: startedA.proxyUrl }));
    results.push(await childProbe("network", { exit: "exit-A" }, nsA.name));
    results.push(await childProbe("network", { exit: "exit-B" }, nsB.name));
    results.push(await childProbe("range", { exit: "exit-A", proxyUrl: startedA.proxyUrl }));
    results.push(
      await childProbe("range", { exit: "exit-B", proxyUrl: startedB.externalProxyUrl }),
    );
    const denied = await new Promise((done, fail) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: 8781,
          path: "http://203.0.113.10/",
          headers: { "proxy-authorization": `Basic ${Buffer.from("wrong:x").toString("base64")}` },
        },
        (r) => {
          r.resume();
          done(r.statusCode);
        },
      );
      req.once("error", fail);
      req.end();
    });
    assert.equal(denied, 407);
    await command("ip", [
      "-n",
      nsA.name,
      "route",
      "del",
      "table",
      "201",
      "default",
      "dev",
      "profile0",
    ]);
    await childProbe("blocked", {}, nsA.name);
    await command("ip", [
      "-n",
      nsA.name,
      "route",
      "add",
      "table",
      "201",
      "default",
      "dev",
      "profile0",
    ]);
    const pids = (await command("ip", ["netns", "pids", nsB.name])).split(/\s+/).filter(Boolean);
    let killed = false;
    for (const pid of pids) {
      if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() === "mihomo") {
        process.kill(Number(pid), "SIGKILL");
        killed = true;
      }
    }
    assert.ok(killed);
    await delay(100);
    await childProbe("blocked", {}, nsB.name);
    await childProbe("range", { exit: "exit-A", proxyUrl: startedA.proxyUrl });
    const restarted = await api("/egress/fixture-b/start", "POST", { node: nodes.B });
    assert.equal(restarted.externalProxyUrl, startedB.externalProxyUrl);
    await childProbe("network", { exit: "exit-B" }, nsB.name);
    if (process.env.PROFILE_EGRESS_STOCK_CPA === "1") {
      stage = "stock-cpa-authenticated-proxy";
      await stockCpaProbe(startedA.externalProxyUrl);
    }
    const browserArgs = [
      "--no-first-run",
      "--password-store=basic",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
    ];
    const browserProfiles = {
      A: { id: "smoke-browser", exit: "exit-A", directory: "/data/browser-a", node: nodes.A },
      B: { id: "smoke-browser-b", exit: "exit-B", directory: "/data/browser-b", node: nodes.B },
    };
    const startBrowser = async (profile, env = {}, headful = false) => {
      const value = await api(`/browsers/${profile.id}/start`, "POST", {
        node: { ...profile.node, server: networkIdentity(`browser-${profile.id}`).hostIp },
        options: {
          userDataDir: profile.directory,
          args: [...(headful ? [] : ["--headless=new"]), ...browserArgs],
          env,
        },
      });
      assert.equal(value.timeZone, exitTimeZones[profile.exit].timeZone);
      return value;
    };
    stage = "failed-geo-cleanup";
    const failedNetwork = networkIdentity("browser-smoke-geo-failure");
    const beforeFailure = { A: counts.A.geo, B: counts.B.geo };
    counts.B.failGeo = true;
    try {
      const failed = await api(
        "/browsers/smoke-geo-failure/start",
        "POST",
        {
          node: { ...nodes.B, server: failedNetwork.hostIp },
          options: {
            userDataDir: "/data/browser-b",
            args: ["--headless=new", ...browserArgs],
            env: {},
          },
        },
        503,
      );
      assert.equal(failed.code, "EXIT_TIMEZONE");
      assert.ok(!(await command("ip", ["netns", "list"])).includes(failedNetwork.name));
      await assert.rejects(stat(`/run/remote-browser/${failedNetwork.name}`), { code: "ENOENT" });
      assert.equal(
        counts.A.geo,
        beforeFailure.A,
        "failed B lookup must not fall back to A or deployment default",
      );
      assert.equal(
        counts.B.geo,
        beforeFailure.B + 1,
        "the failed provider is queried once without retry",
      );
    } finally {
      delete counts.B.failGeo;
    }
    stage = "simultaneous-browser-timezones";
    const beforeConcurrent = { A: counts.A.geo, B: counts.B.geo };
    const initialBrowsers = await Promise.all(
      Object.values(browserProfiles).map((profile) => startBrowser(profile)),
    );
    assert.equal(counts.A.geo, beforeConcurrent.A + 1);
    assert.equal(counts.B.geo, beforeConcurrent.B + 1);
    const initialClocks = await Promise.all(
      Object.values(browserProfiles).map((profile, index) =>
        childProbe("cdp", {
          socketPath: initialBrowsers[index].socketPath,
          exit: profile.exit,
          persist: true,
        }),
      ),
    );
    results.push(...initialClocks);
    await Promise.all(
      Object.values(browserProfiles).map((profile) => api(`/browsers/${profile.id}`, "DELETE")),
    );
    for (const [iteration, key] of ["A", "B", "A", "A"].entries()) {
      stage = `browser-${key}-reopen-${iteration}`;
      const profile = browserProfiles[key],
        before = counts[key].geo;
      const browser = await startBrowser(profile);
      assert.equal(
        counts[key].geo,
        before + 1,
        "reopening a browser must probe its selected exit again",
      );
      results.push(
        await childProbe("cdp", {
          socketPath: browser.socketPath,
          exit: profile.exit,
          persist: false,
        }),
      );
      await api(`/browsers/${profile.id}`, "DELETE");
    }
    stage = "headful-private-x11";
    const display = await startPrivateDisplay();
    cleanups.push(display.close);
    const headful = await startBrowser(
      { ...browserProfiles.B, id: "smoke-headful" },
      display.env,
      true,
    );
    results.push({
      ...(await childProbe("cdp", {
        socketPath: headful.socketPath,
        exit: "exit-B",
        persist: false,
      })),
      headful: true,
      privateXauthority: true,
    });
    await api("/browsers/smoke-headful", "DELETE");
    assert.ok(counts.A.dns > 0 && counts.B.dns > 0);
    assert.ok(counts.A.udp > 0 && counts.B.udp > 0);
    assert.ok(counts.A.geo > 0 && counts.B.geo > 0);
    console.log(
      JSON.stringify({
        passed: true,
        independentExits: true,
        authenticatedProxy407: true,
        missingTunRouteBlocked: true,
        mihomoDeathBlocked: true,
        otherExitSurvives: true,
        stableTokenAfterRestart: true,
        pendingEgressRevoked: true,
        defaultEgressLifecycle: true,
        headfulPrivateX11: true,
        selectedExitTimeZones: true,
        workerLocalTime: true,
        seasonalOffsets: true,
        defaultTimeZoneCached: true,
        failedGeoCleaned: true,
        ...(process.env.PROFILE_EGRESS_STOCK_CPA === "1" ? { stockCpaProxy: true } : {}),
        counts,
        results,
      }),
    );
  } catch (error) {
    console.error("Isolated smoke stage", stage, "fixture counters", JSON.stringify(counts));
    for (const id of ["node-fixture-a", "node-fixture-b"]) {
      const info = networkIdentity(id);
      for (const args of [
        ["-n", info.name, "rule", "show"],
        ["-n", info.name, "route", "get", "203.0.113.10", "uid", "10001"],
        ["-n", info.name, "route", "show", "table", "all"],
        ["-n", info.name, "-s", "link", "show", "profile0"],
        ["netns", "exec", info.name, "iptables", "-nvL", "INPUT"],
        [
          "netns",
          "exec",
          info.name,
          "sysctl",
          "net.ipv4.conf.all.rp_filter",
          "net.ipv4.conf.profile0.rp_filter",
        ],
      ])
        console.error(await command("ip", args).catch(() => "namespace unavailable"));
    }
    if (process.env.PROFILE_EGRESS_SMOKE_KEEP === "1") {
      console.error("Keeping isolated runtime alive for diagnostics for 45 seconds");
      await delay(45_000);
    }
    throw error;
  } finally {
    await broker?.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
}
async function host() {
  if (process.env.PROFILE_EGRESS_SMOKE !== "1")
    throw new Error("Set PROFILE_EGRESS_SMOKE=1 to create a disposable runtime test container");
  const binary = resolve(process.env.PROFILE_EGRESS_MIHOMO ?? "/tmp/codex-mihomo-check/mihomo");
  assert.ok(
    (await stat(binary)).size > 50_000_000,
    "Pass a complete pinned Mihomo binary in PROFILE_EGRESS_MIHOMO",
  );
  const image =
    process.env.PROFILE_EGRESS_SMOKE_IMAGE ??
    (await command("docker", [
      "inspect",
      "remote-claude-browser-server-1",
      "--format",
      "{{.Image}}",
    ]));
  const work = await mkdtemp(join(tmpdir(), "profile-egress-smoke-"));
  const id = `profile-egress-smoke-${process.pid}-${Date.now()}`;
  let created = false;
  let cpaSourceCreated = false;
  try {
    await chmod(work, 0o755);
    for (const [source, name] of [
      [script, "profile-egress-smoke.mjs"],
      [
        fileURLToPath(new URL("../deploy/profile-network.sh", import.meta.url)),
        "profile-network.sh",
      ],
    ])
      await writeFile(join(work, name), await readFile(source), { mode: 0o644 });
    const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
    await require("esbuild").build({
      entryPoints: [
        fileURLToPath(new URL("../packages/gateway/src/egress/mihomo.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: join(work, "config.mjs"),
      logLevel: "warning",
    });
    await require("esbuild").build({
      entryPoints: [fileURLToPath(new URL("../deploy/profile-broker.mjs", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["undici"],
      banner: {
        js: 'import { createRequire as __smokeRequire } from "node:module"; const require = __smokeRequire(import.meta.url);',
      },
      outfile: join(work, "profile-broker.mjs"),
      logLevel: "warning",
    });
    if (process.env.PROFILE_EGRESS_DEBUG === "1")
      await writeFile(
        join(work, "profile-broker.mjs"),
        (await readFile(join(work, "profile-broker.mjs"), "utf8"))
          .replaceAll('stdio: "ignore"', 'stdio: "inherit"')
          .replaceAll("error.code ?? error.name", "error.stderr ?? error.message"),
      );
    if (process.env.PROFILE_EGRESS_STOCK_CPA === "1") {
      await writeFile(
        join(work, "cpa-broker.mjs"),
        await readFile(new URL("../deploy/cpa-broker.mjs", import.meta.url)),
        { mode: 0o644 },
      );
      await chmod(join(work, "cpa-broker.mjs"), 0o644);
      await command("docker", [
        "create",
        "--name",
        `${id}-cpa-source`,
        "--entrypoint=/bin/true",
        process.env.CPA_BROKER_ENGINE_IMAGE ?? "remote-claude-browser-cpa:local",
      ]);
      cpaSourceCreated = true;
      await command("docker", [
        "cp",
        `${id}-cpa-source:/app/CLIProxyAPI`,
        join(work, "CLIProxyAPI"),
      ]);
      await chmod(join(work, "CLIProxyAPI"), 0o755);
      await command("docker", ["rm", `${id}-cpa-source`]);
      cpaSourceCreated = false;
    }
    for (const name of [
      "profile-egress-smoke.mjs",
      "profile-broker.mjs",
      "profile-network.sh",
      "config.mjs",
    ])
      await chmod(join(work, name), 0o644);
    await command("docker", ["network", "create", "--internal", id]);
    created = true;
    const args = [
      "run",
      "--name",
      id,
      "--rm",
      "--network",
      id,
      "--network-alias",
      "runtime-egress",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--sysctl=net.ipv4.ip_forward=1",
      "--device=/dev/net/tun",
      "--memory=1g",
      "--cpus=1.5",
      "--pids-limit=512",
      "--env=EGRESS_TEST_PRIVATE_PROXY=1",
      "--env=TZ=Etc/UTC",
      `--env=PROFILE_EGRESS_STOCK_CPA=${process.env.PROFILE_EGRESS_STOCK_CPA ?? "0"}`,
      `--env=PROFILE_EGRESS_DEBUG=${process.env.PROFILE_EGRESS_DEBUG ?? "0"}`,
      `--env=PROFILE_EGRESS_SMOKE_KEEP=${process.env.PROFILE_EGRESS_SMOKE_KEEP ?? "0"}`,
      ...["CHOWN", "KILL", "NET_ADMIN", "SETGID", "SETUID", "SYS_ADMIN", "SYS_CHROOT"].map(
        (cap) => `--cap-add=${cap}`,
      ),
      "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777",
      "--tmpfs=/data:rw,size=256m,uid=10001,gid=10001,mode=0700",
      "--tmpfs=/run/netns:rw,size=16m",
      "--tmpfs=/run/remote-browser:rw,size=32m",
      "--mount",
      `type=bind,src=${work},dst=/acceptance,readonly`,
      "--mount",
      `type=bind,src=${join(work, "profile-broker.mjs")},dst=/app/profile-egress-broker.mjs,readonly`,
      "--mount",
      `type=bind,src=${binary},dst=/usr/local/bin/mihomo,readonly`,
      "--entrypoint=node",
      image,
      "/acceptance/profile-egress-smoke.mjs",
      "--inside",
    ];
    await new Promise((done, fail) => {
      const child = spawn("docker", args, { stdio: "inherit" });
      child.once("error", fail);
      child.once("exit", (code) =>
        code === 0 ? done() : fail(new Error(`Runtime smoke container exited ${code}`)),
      );
    });
  } finally {
    if (cpaSourceCreated) await command("docker", ["rm", "--force", `${id}-cpa-source`]);
    await command("docker", ["rm", "--force", id]).catch(() => {});
    if (created) await command("docker", ["network", "rm", id]);
    await rm(work, { recursive: true, force: true });
  }
}
if (process.argv[2] === "--probe")
  console.log(JSON.stringify(await probe(process.argv[3], await readInput())));
else if (process.argv[2] === "--inside") await inside();
else await host();
