// No real accounts: real CPA + Caddy + Xray, fake Anthropic upstream, disposable volumes/networks.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

const exec = promisify(execFile);
const root = process.cwd();
await mkdir(".cache", { recursive: true });
const temp = await mkdtemp(resolve(".cache/cpa-smoke-"));
const name = `cpa-smoke-${process.pid}`;
const freePort = async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
};
const [port, callbackPort, webPort] = await Promise.all([freePort(), freePort(), freePort()]);
const env = {
  ...process.env,
  CPA_API_KEY: "fixture-client-key-".repeat(3),
  CPA_MANAGEMENT_KEY: "fixture-management-key-".repeat(3),
  CPA_PORT: String(port),
  CPA_CALLBACK_PORT: String(callbackPort),
  EGRESS_PROXY: "socks5://172.31.84.254:1080",
  EGRESS_BLOCK: "",
};
const overlay = {
  services: {
    "cpa-egress": { networks: { cpa: {}, "cpa-exit": {} } },
    fixture: {
      image: env.CPA_EGRESS_IMAGE || "remote-claude-browser-cpa-egress:local",
      command: ["node", "/fixture.mjs"],
      volumes: [`${root}/scripts/cpa-fixture.mjs:/fixture.mjs:ro`],
      tmpfs: ["/tmp:rw,nosuid,nodev,size=32m,mode=1777"],
      networks: { "cpa-exit": { ipv4_address: "172.31.84.254" } },
    },
    caddy: {
      image: "caddy:2.10.2-alpine",
      environment: { PUBLIC_HOST: ":8080", UPSTREAM: "fixture:18080" },
      volumes: [`${root}/deploy/Caddyfile.cpa:/etc/caddy/Caddyfile:ro`],
      ports: [`127.0.0.1:${webPort}:8080`],
      networks: ["cpa", "cpa-exit"],
    },
  },
  networks: { "cpa-exit": { ipam: { config: [{ subnet: "172.31.84.0/24" }] } } },
};
const path = resolve(temp, "compose.json");
await writeFile(path, JSON.stringify(overlay), { mode: 0o600 });
const compose = ["compose", "-p", name, "-f", resolve("compose.cpa.yml"), "-f", path];
const docker = async (...args) =>
  (await exec("docker", [...compose, ...args], { env, maxBuffer: 2 ** 20 })).stdout;
const origin = `http://127.0.0.1:${webPort}`;
const headers = {
  authorization: `Bearer ${env.CPA_API_KEY}`,
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
};
async function waitHttp(url, opts = {}) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (r?.ok) return r;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`HTTP readiness timed out: ${url}`);
}
try {
  await docker("up", "-d", "--no-build", "fixture");
  await docker("run", "--rm", "--no-deps", "cpa-init");
  const prepare = `const fs=require('node:fs');const p='/config/config.yaml';const c=JSON.parse(fs.readFileSync(p));c['api-keys']={claude:[{name:'fixture', 'base-url':'http://203.0.113.20:18080',models:[{name:'claude-fixture',alias:'fixture-claude'}],keys:[{'api-key':'fixture-upstream-key'}]}]};fs.writeFileSync(p,JSON.stringify(c));fs.writeFileSync('/static/management.html','<!doctype html><title>CPA fixture panel</title>');`;
  await docker(
    "run",
    "--rm",
    "--no-deps",
    "--user",
    "10003:10003",
    "--entrypoint",
    "node",
    "cpa-init",
    "-e",
    prepare,
  );
  await docker("up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "cpa");
  await docker("up", "-d", "--no-build", "caddy");
  assert.equal(await (await waitHttp(origin + "/gate")).text(), "browser-fixture");
  assert.match(await (await waitHttp(origin + "/management.html")).text(), /CPA fixture panel/);
  assert.equal((await fetch(origin + "/cpa", { redirect: "manual" })).status, 302);
  assert.equal((await fetch(origin + "/v1/models")).status, 401);
  assert.equal((await fetch(origin + "/v8/management/config")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/v8/management/config", {
        headers: { authorization: `Bearer ${env.CPA_API_KEY}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(origin + "/v1/models", {
        headers: { authorization: `Bearer ${env.CPA_MANAGEMENT_KEY}` },
      })
    ).status,
    401,
  );
  const management = await fetch(origin + "/v8/management/config", {
    headers: { authorization: `Bearer ${env.CPA_MANAGEMENT_KEY}` },
  });
  assert.equal(management.status, 200);
  await waitHttp(`http://127.0.0.1:${port}/v1/models`, { headers });
  let models;
  for (let attempt = 0; attempt < 20; attempt++) {
    models = await (await waitHttp(origin + "/v1/models", { headers })).json();
    if (models.data.length === 1) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(models.data.length, 1, JSON.stringify(models));
  const payload = {
    model: models.data[0].id,
    max_tokens: 32,
    messages: [{ role: "user", content: "fixture" }],
  };
  let response = await fetch(origin + "/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  assert.equal((await response.json()).content[0].text, "fixture-ok");
  const started = Date.now();
  response = await fetch(origin + "/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, stream: true }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(!first.includes("message_stop"), "SSE was buffered until completion");
  assert.ok(Date.now() - started < 1200, "SSE first chunk was delayed");
  let stream = first;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stream += new TextDecoder().decode(value);
  }
  assert.match(stream, /fixture-ok/);
  assert.match(stream, /message_stop/);
  response = await fetch(origin + "/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
  assert.equal((await response.json()).choices[0].message.content, "fixture-ok");
  // The internal network must prevent a credential from overriding proxy-url to go direct.
  await docker(
    "exec",
    "-T",
    "cpa",
    "node",
    "-e",
    "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(1)).catch(()=>process.exit(0))",
  );
  await docker("stop", "cpa-egress");
  response = await fetch(origin + "/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.status >= 400, "Proxy outage must not produce a direct upstream request");
  await docker("start", "cpa-egress");
  await docker("restart", "cpa");
  await waitHttp(origin + "/v1/models", { headers });
  console.log(
    "CPA smoke passed: Caddy routes, independent auth, Messages + Chat, SSE, blocked direct egress, outage and persistent configuration.",
  );
} catch (error) {
  console.error(error);
  console.error(
    await docker("logs", "--no-color", "--tail", "25", "cpa", "cpa-egress").catch(() => ""),
  );
  process.exitCode = 1;
} finally {
  await docker("down", "--volumes", "--remove-orphans").catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
