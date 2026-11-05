// Authenticated, read-only production telemetry and served-bundle verification.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const origin = "https://claude.example.com";
const password = (await readFile("/etc/claude-browser/agent.env", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("MIRROR_ACCESS_PASSWORD="))
  .slice("MIRROR_ACCESS_PASSWORD=".length);
const denied = await fetch(origin + "/api/status", { redirect: "manual" });
assert.ok([302, 401, 403].includes(denied.status), "telemetry requires authentication");
const auth = await fetch(origin + "/gate", {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(auth.status, 303);
const cookie = auth.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
const get = (path) =>
  fetch(origin + path, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) });
const samples = [];
for (let index = 0; index < 2; index++) {
  if (index) await new Promise((resolve) => setTimeout(resolve, 3500));
  const response = await get("/api/status");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const value = await response.json();
  assert.equal(value.t, "server-status");
  assert.equal(value.clientsMax, 16);
  assert.equal(value.pixelsMax, null);
  assert.ok(
    value.clientsOnline >= 0 &&
      value.clientsOnline <= value.clientsAllocated &&
      value.clientsAllocated <= 16,
  );
  assert.ok(value.pixelsActive >= 0 && value.pixelsActive <= 16);
  assert.equal(value.cpuCount, 4);
  assert.ok(value.memoryTotalBytes > 3 * 1024 ** 3 && value.memoryTotalBytes < 5 * 1024 ** 3);
  assert.ok(value.memoryUsedBytes > 0 && value.memoryUsedBytes <= value.memoryTotalBytes);
  assert.ok(value.browserMemoryBytes > 0);
  if (index) {
    assert.ok(value.cpuPercent !== null && value.cpuPercent >= 0 && value.cpuPercent <= 100);
    assert.ok(value.sampledAt > samples[0].sampledAt);
  }
  samples.push(value);
}
const expectedHtml = await readFile("packages/viewer/dist/index.html", "utf8");
const entry = expectedHtml.match(/src="([^"]+\.js)"/)?.[1];
assert.ok(entry);
const servedHtml = await (await get("/")).text();
assert.ok(servedHtml.includes(entry), "latest viewer index");
const js = await (await get(entry)).text();
assert.ok(js.includes("server-status") && js.includes("会话占用"), "status UI bundle");
const health = await fetch(origin + "/healthz").then((response) => response.json());
assert.equal(health.ok, true);
assert.equal(health.maxClients, 16);
const result = {
  at: new Date().toISOString(),
  readOnly: true,
  allocatedNoWorkspaces: true,
  authenticationRequired: true,
  latestViewerEntry: entry,
  samples,
  health,
};
await writeFile("artifacts/status-production.json", JSON.stringify(result, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(result));
