// Temporary, owned production workspaces only. No typing, chat submission, or user-page navigation.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Pixel frames arrive as binary WebSocket frames (see encodePxBinary); keep only their metadata.
const pixelMessage = (raw) => {
  const b = new Uint8Array(raw);
  const n = (b[2] << 8) | b[3];
  return {
    t: "px",
    tab: new TextDecoder().decode(b.subarray(4, 4 + n)),
    w: (b[4 + n] << 8) | b[5 + n],
    h: (b[6 + n] << 8) | b[7 + n],
    data: "",
  };
};
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const WebSocket = require("ws");
const run = promisify(execFile);
const origin = "https://claude.example.com";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("MIRROR_ACCESS_PASSWORD="))
  .slice("MIRROR_ACCESS_PASSWORD=".length);
const owned = [];
const samples = [];
async function stats(phase) {
  const health = await fetch(origin + "/healthz").then((response) => response.json());
  const { stdout } = await run(
    "ssh",
    [
      "remote-server",
      "systemctl show claude-browser -p MainPID -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec -p TasksCurrent -p NRestarts; cat /proc/meminfo",
    ],
    { timeout: 15000 },
  );
  const values = {};
  for (const name of [
    "MainPID",
    "MemoryCurrent",
    "MemoryPeak",
    "CPUUsageNSec",
    "TasksCurrent",
    "NRestarts",
  ]) {
    values[name] = Number(stdout.match(new RegExp("^" + name + "=(\\d+)", "m"))?.[1]);
  }
  const availableMemoryBytes = Number(stdout.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
  const sample = {
    phase,
    at: new Date().toISOString(),
    activeClients: health.clients,
    ...values,
    availableMemoryBytes,
  };
  samples.push(sample);
  console.log(
    JSON.stringify({
      phase,
      memoryMiB: Math.round(values.MemoryCurrent / 1048576),
      availableMiB: Math.round(availableMemoryBytes / 1048576),
      tasks: values.TasksCurrent,
    }),
  );
  return sample;
}
async function login() {
  const response = await fetch(origin + "/gate", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 303, "access authentication");
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
async function api(cookie, path, method = "GET", body) {
  return fetch(origin + path, {
    method,
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25000),
  });
}
async function allocate() {
  const cookie = await login();
  const response = await api(cookie, "/api/client/session", "POST", { clientKey: randomUUID() });
  if (response.status === 503) {
    const result = await response.json();
    if (result.code === "CLIENT_CAPACITY") return undefined;
    throw new Error("Workspace unavailable");
  }
  assert.equal(response.status, 200);
  const lease = await response.json();
  assert.equal(lease.maxClients, 2);
  const client = {
    cookie,
    sid: lease.sid,
    tabs: new Set(),
    paths: new Set(),
    snapshots: 0,
    frames: 0,
    pongs: 0,
    socket: null,
  };
  owned.push(client);
  const socket = new WebSocket(origin.replace("https:", "wss:") + "/ws?sid=" + lease.sid, {
    headers: { Cookie: cookie, Origin: origin },
  });
  client.socket = socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned workspace did not connect")), 20000);
    socket.on("error", reject);
    socket.on("message", (raw, isBinary) => {
      const message = isBinary ? pixelMessage(raw) : JSON.parse(String(raw));
      if (message.t === "hello") {
        assert.equal(message.sessionId, client.sid);
        clearTimeout(timer);
        resolve();
      }
      if (message.t === "snapshot") client.snapshots++;
      if (message.t === "px") client.frames++;
      if (message.t === "pong") client.pongs++;
      if (message.t === "tabs")
        for (const tab of message.tabs) {
          client.tabs.add(tab.id);
          try {
            const url = new URL(tab.url);
            if (url.hostname === "claude.ai")
              client.paths.add(
                url.pathname === "/new"
                  ? "new"
                  : url.pathname.includes("login")
                    ? "login"
                    : "other-claude",
              );
          } catch {}
        }
    });
  });
  socket.send(JSON.stringify({ t: "ping", id: 1, sentTs: Date.now() }));
  return client;
}
let result;
try {
  const initial = await fetch(origin + "/healthz").then((response) => response.json());
  assert.equal(initial.maxClients, 2);
  await stats("before-probe");
  for (let index = 0; index < 2; index++) {
    const client = await allocate();
    if (!client) break;
    await delay(18000);
    await stats("owned-clients-" + owned.length);
  }
  if (owned.length === 2) {
    const thirdCookie = await login();
    const full = await api(thirdCookie, "/api/client/session", "POST", { clientKey: randomUUID() });
    assert.equal(full.status, 503);
    assert.equal((await full.json()).code, "CLIENT_CAPACITY");
    for (const client of owned)
      assert.equal(
        (
          await api(
            client.cookie,
            "/s/" + owned.find((other) => other !== client).sid + "/a/invalid",
          )
        ).status,
        403,
      );
    assert.ok(
      [...owned[0].tabs].every((tab) => !owned[1].tabs.has(tab)),
      "distinct target sets",
    );
  }
  for (const client of owned) {
    assert.ok(client.snapshots > 0, "owned DOM snapshot");
    assert.ok(client.pongs > 0, "transport pong");
  }
  if (owned.length === 2) {
    const tab = [...owned[0].tabs][0];
    owned[0].socket.send(JSON.stringify({ t: "mode", tab, mode: "px" }));
    await delay(10000);
    assert.ok(owned[0].frames > 0, "owned pixel frame");
    owned[1].socket.send(JSON.stringify({ t: "mode", tab: [...owned[1].tabs][0], mode: "px" }));
    await delay(1500);
    assert.equal(owned[1].frames, 0, "second pixel stream blocked");
    await stats("two-clients-one-pixel-stream");
    owned[0].socket.send(JSON.stringify({ t: "mode", tab, mode: "dom" }));
  }
  const health = await fetch(origin + "/healthz").then((response) => response.json());
  assert.equal(health.ok, true);
  result = {
    at: new Date().toISOString(),
    scope: "Temporary owned Claude windows, no typing/submission; memory is idle-page sample only",
    initialActiveClients: initial.clients,
    testedOwnClients: owned.length,
    maxClients: 2,
    maxPixelStreams: 1,
    workspaces: owned.map((client) => ({
      sid: client.sid,
      pages: client.tabs.size,
      observedClaudePaths: [...client.paths],
      receivedSnapshot: client.snapshots > 0,
      receivedPong: client.pongs > 0,
    })),
    samples,
  };
} finally {
  const cleanupErrors = [];
  for (const client of owned) {
    client.socket?.close();
    try {
      const response = await api(client.cookie, "/api/client/session/" + client.sid, "DELETE");
      assert.equal(response.status, 204, "release temporary workspace");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await delay(1000);
  await stats("probe-workspaces-released");
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Workspace cleanup failed");
}
await writeFile("artifacts/two-client-production.json", JSON.stringify(result, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    testedOwnClients: result.testedOwnClients,
    maxClients: result.maxClients,
    releasedTemporaryWorkspaces: true,
  }),
);
