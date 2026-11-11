// Authenticated, read-only production telemetry and served-bundle verification.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readProbeCredentials } from "./probe-session.mjs";
if (process.env.CLAUDE_LIMITED_TASK !== "1") throw new Error("Use limited-run.sh");
const origin = process.env.MIRROR_ORIGIN ?? "http://127.0.0.1:3010";
const { username, password } = await readProbeCredentials();
const capacityText = process.env.MIRROR_EXPECT_SESSIONS ?? process.env.MIRROR_CLIENTS ?? "8";
assert.match(capacityText, /^[1-9]\d*$/, "expected capacity must be a positive safe integer");
const expectedCapacity = Number(capacityText);
assert.ok(Number.isSafeInteger(expectedCapacity));
const denied = await fetch(origin + "/api/status", {
  redirect: "manual",
  signal: AbortSignal.timeout(15000),
});
assert.ok([302, 401, 403].includes(denied.status), "telemetry requires authentication");
const auth = await fetch(origin + "/gate", {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", Origin: origin },
  body: new URLSearchParams({ username, password }),
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
  assert.equal(value.clientsMax, expectedCapacity);
  assert.equal(value.pixelsMax, null);
  assert.ok(Number.isSafeInteger(value.clientsOnline) && value.clientsOnline >= 0);
  assert.ok(
    Number.isSafeInteger(value.clientsAllocated) && value.clientsAllocated >= value.clientsOnline,
  );
  // A reduced admission limit preserves already allocated sessions until they are reclaimed.
  assert.ok(
    Number.isSafeInteger(value.pixelsActive) &&
      value.pixelsActive >= 0 &&
      value.pixelsActive <= value.clientsAllocated,
  );
  assert.ok(Number.isSafeInteger(value.cpuCount) && value.cpuCount > 0);
  assert.ok(value.memoryTotalBytes > 0);
  assert.ok(value.memoryUsedBytes > 0 && value.memoryUsedBytes <= value.memoryTotalBytes);
  assert.ok(Number.isFinite(value.browserMemoryBytes) && value.browserMemoryBytes >= 0);
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
assert.equal(servedHtml, expectedHtml, "served viewer index matches the checked build");
const bundleResponse = await get(entry);
assert.equal(bundleResponse.status, 200);
const servedBundle = Buffer.from(await bundleResponse.arrayBuffer());
const expectedBundle = await readFile("packages/viewer/dist" + entry);
assert.ok(
  servedBundle.equals(expectedBundle),
  "served viewer bundle matches the checked build exactly",
);
const health = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(15000) }).then(
  (response) => response.json(),
);
assert.equal(health.ok, true);
assert.equal(health.maxClients, expectedCapacity);
const result = {
  at: new Date().toISOString(),
  readOnly: true,
  allocatedNoWorkspaces: true,
  authenticationRequired: true,
  latestViewerEntry: entry,
  exactViewerBundle: true,
  expectedCapacity,
  samples,
  health,
};
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/status-production.json", JSON.stringify(result, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(result));
