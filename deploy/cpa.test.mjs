import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpaConfig, cpaEgressConfig, initializeCpa } from "./cpa-runtime.mjs";
import { prepareCpaEnv } from "../scripts/setup-cpa.mjs";

const env = {
  CPA_API_KEY: "api-fixture-".repeat(4),
  CPA_MANAGEMENT_KEY: "management-fixture-".repeat(4),
};

test("CPA requires separate strong management and inference keys", () => {
  assert.throws(() => cpaConfig({}), /CPA_API_KEY/);
  assert.throws(() => cpaConfig({ ...env, CPA_MANAGEMENT_KEY: env.CPA_API_KEY }), /different/);
  const config = cpaConfig(env);
  assert.deepEqual(config.access["api-keys"], [env.CPA_API_KEY]);
  assert.equal(config.management["secret-key"], env.CPA_MANAGEMENT_KEY);
  assert.equal(config.requests["proxy-url"], "socks5://cpa-egress:1080");
  assert.equal(config.oauth["auth-dir"], "/auth");
});

test("initialization retains panel edits and OAuth credentials, including across forced config reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpa-init-"));
  const dirs = {
    config: join(root, "config"),
    auth: join(root, "auth"),
    static: join(root, "static"),
  };
  const options = { uid: process.getuid(), gid: process.getgid() };
  try {
    assert.equal(await initializeCpa(dirs, env, options), true);
    const path = join(dirs.config, "config.yaml");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, "panel edit\n");
    await writeFile(join(dirs.auth, "fixture.json"), "fixture credential");
    assert.equal(await initializeCpa(dirs, env, options), false);
    assert.equal(await readFile(path, "utf8"), "panel edit\n");
    assert.equal(await initializeCpa(dirs, env, { ...options, force: true }), true);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).management["secret-key"],
      env.CPA_MANAGEMENT_KEY,
    );
    assert.equal(await readFile(join(dirs.auth, "fixture.json"), "utf8"), "fixture credential");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CPA egress exposes only TCP SOCKS and rejects private destinations without a direct fallback", () => {
  const config = cpaEgressConfig({
    EGRESS_PROXY: "socks5://192.0.2.1:1080",
    EGRESS_BLOCK: "203.0.113.20",
  });
  assert.deepEqual(
    config.inbounds.map((i) => i.protocol),
    ["socks"],
  );
  assert.equal(config.inbounds[0].settings.udp, false);
  assert.equal(
    config.routing.rules.some((r) => r.outboundTag === "blocked" && r.ip.includes("203.0.113.20")),
    true,
  );
  assert.equal(config.outbounds[0].tag, "proxy");
  assert.equal(
    config.routing.rules.some(
      (r) => r.inboundTag?.includes("cpa-socks") && r.outboundTag === "bootstrap",
    ),
    false,
  );
  assert.throws(
    () => cpaEgressConfig({ EGRESS_PROXY: '{"protocol":"freedom"}' }),
    /does not reach a proxy/,
  );
});

test("setup preserves browser settings and quoted VLESS secrets, and is idempotent", () => {
  const source =
    "EGRESS_PROXY='vless://fixture$literal@proxy.example:443'\nSERVER_MEMORY=8g\nMIRROR_CLIENTS=16\nPUBLIC_HOST=browser.example.com\nCOMPOSE_FILE=compose.yml:compose.proxy.yml:compose.https.yml\n";
  const first = prepareCpaEnv(source);
  assert.equal(first.origin, "https://browser.example.com");
  assert.ok(first.text.includes("EGRESS_PROXY='vless://fixture$literal@proxy.example:443'"));
  assert.ok(first.text.includes("SERVER_MEMORY=8g\nMIRROR_CLIENTS=16\n"));
  assert.ok(
    first.text.includes(
      "COMPOSE_FILE=compose.yml:compose.proxy.yml:compose.https.yml:compose.cpa.yml:compose.cpa.https.yml",
    ),
  );
  assert.equal(prepareCpaEnv(first.text).text, first.text);
  assert.throws(() => prepareCpaEnv("SERVER_MEMORY=8g\n"), /EGRESS_PROXY/);
});

test("setup supports a loopback-only deployment without adding a Caddy service", () => {
  const result = prepareCpaEnv("EGRESS_PROXY=socks5://proxy.example:1080\nCPA_PORT=18317\n");
  assert.equal(result.origin, "http://127.0.0.1:18317");
  assert.ok(result.text.includes("COMPOSE_FILE=compose.yml:compose.cpa.yml"));
  assert.ok(!result.text.includes("compose.cpa.https.yml"));
});
