import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));

function adapt(file, environment = []) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "caddy",
        "--mount",
        `type=bind,src=${directory},dst=/examples,readonly`,
        ...environment.flatMap((value) => ["--env", value]),
        "caddy:2.10.2-alpine",
        "adapt",
        "--adapter",
        "caddyfile",
        "--config",
        `/examples/${file}`,
      ],
      { encoding: "utf8" },
    ),
  );
}

function proxies(config) {
  const result = [];
  function visit(node) {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      if (node.handler === "reverse_proxy") result.push(node);
      Object.values(node).forEach(visit);
    }
  }
  visit(config);
  return result;
}

test("same-host ingress forwards the entire site to the browser's loopback port", () => {
  const config = adapt("same-host.Caddyfile");
  const upstreams = proxies(config);
  assert.equal(upstreams.length, 1);
  assert.deepEqual(upstreams[0].upstreams, [{ dial: "127.0.0.1:3010" }]);
  assert.equal(upstreams[0].flush_interval, -1);
  assert.deepEqual(config.apps.http.servers.srv0.routes[0].match, [
    { host: ["browser.example.com"] },
  ]);
});

test("VPS ingress uses its operator-supplied upstream without changing core configuration", () => {
  const config = adapt("separate-vps.Caddyfile", [
    "PUBLIC_HOST=entry.example.com",
    "BROWSER_UPSTREAM=127.0.0.1:13010",
  ]);
  const upstreams = proxies(config);
  assert.equal(upstreams.length, 1);
  assert.deepEqual(upstreams[0].upstreams, [{ dial: "127.0.0.1:13010" }]);
  assert.equal(upstreams[0].flush_interval, -1);
  assert.deepEqual(config.apps.http.servers.srv0.routes[0].match, [
    { host: ["entry.example.com"] },
  ]);
});

test("an HTTPS origin retains upstream TLS verification", () => {
  const config = adapt("separate-vps.Caddyfile", [
    "PUBLIC_HOST=entry.example.com",
    "BROWSER_UPSTREAM=https://origin.example.com",
  ]);
  const [proxy] = proxies(config);
  assert.deepEqual(proxy.upstreams, [{ dial: "origin.example.com:443" }]);
  assert.equal(proxy.transport.protocol, "http");
  assert.deepEqual(proxy.transport.tls, {});
});
