import assert from "node:assert/strict";
import test from "node:test";
import { mergeCpaMigrationConfig } from "./cpa-migration.mjs";

test("migration keeps legacy business settings and the target's runtime identity and exit", () => {
  const legacy = {
    "config-version": 8,
    server: { host: "legacy", port: 1234 },
    management: { "secret-key": "legacy-management", "allow-remote": false },
    access: { "api-keys": ["legacy-caller"] },
    oauth: { "auth-dir": "/old-auth" },
    routing: { strategy: "round-robin", "session-affinity": true },
    upstream: { claude: { "header-defaults": { timezone: "Asia/Tokyo" } } },
    observability: { logs: { "request-log": true } },
    "api-keys": { claude: [{ name: "model-alias", "base-url": "https://api.example" }] },
    "oauth-model-alias": { claude: [{ name: "old-model", alias: "client-model" }] },
    requests: {
      "proxy-url": "socks5://legacy-egress:1080",
      "passthrough-headers": false,
      streaming: { "keepalive-seconds": 25 },
    },
  };
  const target = {
    "config-version": 8,
    server: { host: "0.0.0.0", port: 8317 },
    management: { "secret-key": "new-management", "allow-remote": true },
    access: { "api-keys": ["new-internal-key"] },
    oauth: { "auth-dir": "/auth" },
    routing: { strategy: "fill-first" },
    requests: {
      "proxy-url": "http://new-private-egress:8781",
      "tls-handshake-timeout-seconds": 15,
      "passthrough-headers": true,
    },
  };
  const beforeLegacy = structuredClone(legacy);
  const beforeTarget = structuredClone(target);
  const result = mergeCpaMigrationConfig(legacy, target);

  for (const section of ["server", "management", "access", "oauth"])
    assert.deepEqual(result[section], target[section]);
  for (const section of ["routing", "upstream", "observability", "api-keys", "oauth-model-alias"])
    assert.deepEqual(result[section], legacy[section]);
  assert.deepEqual(result.requests, {
    "proxy-url": "http://new-private-egress:8781",
    "tls-handshake-timeout-seconds": 15,
    "passthrough-headers": false,
    streaming: { "keepalive-seconds": 25 },
  });
  assert.equal(JSON.stringify(result).includes("legacy-caller"), false);
  assert.equal(JSON.stringify(result).includes("legacy-management"), false);

  result.access["api-keys"].push("another-internal-key");
  result.routing.strategy = "modified";
  result.requests.streaming["keepalive-seconds"] = 5;
  assert.deepEqual(legacy, beforeLegacy);
  assert.deepEqual(target, beforeTarget);
});

test("missing legacy request overrides retain the target request defaults", () => {
  const target = {
    server: {},
    management: {},
    access: {},
    oauth: {},
    requests: { "proxy-url": "http://private-exit:8781", "passthrough-headers": true },
  };
  assert.deepEqual(mergeCpaMigrationConfig({ routing: { strategy: "fill-first" } }, target), {
    ...target,
    routing: { strategy: "fill-first" },
  });
});
