// Temporary, owned production workspaces only. No typing, chat submission, or user-page navigation.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readProbeCredentials } from "./probe-session.mjs";
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
const origin = process.env.MIRROR_ORIGIN ?? "http://127.0.0.1:3010";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { username, password } = await readProbeCredentials();
const capacityText = process.env.MIRROR_EXPECT_SESSIONS ?? process.env.MIRROR_CLIENTS ?? "8";
assert.match(capacityText, /^[1-9]\d*$/);
const expectedCapacity = Number(capacityText);
assert.ok(Number.isSafeInteger(expectedCapacity) && expectedCapacity >= 2);
const owned = [];
const samples = [];
let telemetryCookie;
async function stats(phase) {
  telemetryCookie ??= await login();
  const response = await api(telemetryCookie, "/api/status");
  assert.equal(response.status, 200, "authenticated resource telemetry");
  const value = await response.json();
  assert.equal(value.clientsMax, expectedCapacity);
  assert.equal(value.pixelsMax, null, "pixel streams have no separate admission limit");
  const sample = {
    phase,
    at: new Date().toISOString(),
    ...value,
  };
  samples.push(sample);
  console.log(
    JSON.stringify({
      phase,
      browserMemoryMiB: Math.round(value.browserMemoryBytes / 1048576),
      availableMiB: Math.round((value.memoryTotalBytes - value.memoryUsedBytes) / 1048576),
      cpuPercent: value.cpuPercent,
    }),
  );
  return sample;
}
async function login() {
  const response = await fetch(origin + "/gate", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
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
    if (result.code === "CLIENT_CAPACITY") {
      await api(cookie, "/logout", "POST");
      return undefined;
    }
    throw new Error("Workspace unavailable");
  }
  assert.equal(response.status, 200);
  const lease = await response.json();
  assert.equal(lease.maxClients, expectedCapacity);
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
  const socket = new WebSocket(
    origin.replace(/^http/, "ws") +
      "/ws?" +
      new URLSearchParams({ sid: lease.sid, connectionKey: randomUUID() }),
    {
      headers: { Cookie: cookie, Origin: origin },
    },
  );
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
  const initial = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(15000) }).then(
    (response) => response.json(),
  );
  assert.equal(initial.maxClients, expectedCapacity);
  const before = await stats("before-probe");
  assert.ok(
    expectedCapacity - before.clientsAllocated >= 2,
    "two free session slots required; existing sessions are never released by the probe",
  );
  for (let index = 0; index < 2; index++) {
    const client = await allocate();
    assert.ok(client, "a temporary workspace slot must remain available");
    await delay(18000);
    await stats("owned-clients-" + owned.length);
  }
  if (owned.length === 2) {
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
    await delay(10000);
    assert.ok(owned[1].frames > 0, "second owned pixel stream is allowed");
    await stats("two-clients-two-pixel-streams");
    owned[0].socket.send(JSON.stringify({ t: "mode", tab, mode: "dom" }));
    owned[1].socket.send(JSON.stringify({ t: "mode", tab: [...owned[1].tabs][0], mode: "dom" }));
  }
  const health = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(15000) }).then(
    (response) => response.json(),
  );
  assert.equal(health.ok, true);
  result = {
    at: new Date().toISOString(),
    scope: "Temporary owned Claude windows, no typing/submission; memory is idle-page sample only",
    initialActiveClients: initial.clients,
    testedOwnClients: owned.length,
    maxClients: expectedCapacity,
    maxPixelStreams: null,
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
  for (const cookie of [...owned.map((client) => client.cookie), telemetryCookie].filter(Boolean))
    await api(cookie, "/logout", "POST");
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Workspace cleanup failed");
}
await mkdir("artifacts", { recursive: true });
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
