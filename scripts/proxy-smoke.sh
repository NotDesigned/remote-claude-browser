#!/usr/bin/env bash
# Exercise real Xray TUN routing, UDP, failure blocking and supervised restart without Internet.
set -euo pipefail
cd "$(dirname "$0")/.."
project="remote-browser-proxy-smoke-$$"
export EGRESS_PROXY=socks5://127.0.0.1:1080
export SERVER_SUBNET=${PROXY_SMOKE_SUBNET:-172.31.69.0/24}
export MIRROR_ACCESS_PASSWORD=proxy-smoke-password
export MIRROR_ACCESS_SECRET=proxy-smoke-access-secret
export MIRROR_AUTH_SECRET=proxy-smoke-auth-secret
export MIRROR_START_URL=about:blank
export TZ=Etc/UTC
export SERVER_PORT
SERVER_PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
export MIRROR_PUBLIC_ORIGIN="http://127.0.0.1:$SERVER_PORT"
compose=(docker compose -p "$project" -f compose.yml -f compose.proxy.yml)
if [[ ${PROXY_SMOKE_HOSTNET:-} == 1 ]]; then compose+=(-f compose.hostnet.yml); fi
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap '"${compose[@]}" logs --tail=60 >&2' ERR
"${compose[@]}" up -d --no-build --wait --wait-timeout 90
"${compose[@]}" exec -T server node -e 'require("node:fs").writeFileSync("/tmp/proxy-fixture.mjs",require("node:fs").readFileSync(0),{mode:0o644})' < scripts/proxy-fixture.mjs
"${compose[@]}" exec -d --user 10003:10003 server node /tmp/proxy-fixture.mjs
sleep 1
"${compose[@]}" exec -T --user 10001:10001 server node --input-type=module - <<'JS'
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
const r = await fetch("http://203.0.113.10:18080", { signal: AbortSignal.timeout(10000) });
assert.equal(await r.text(), "xray-tunnel-fixture");
// WebRTC binds UDP sockets to real interfaces: this must still go through Xray.
const address = Object.values(networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("198.18.")).address;
const s = createSocket("udp4");
try {
  await new Promise((resolve) => s.bind(0, address, resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Xray UDP timeout")), 10000);
    s.once("message", (message) => { clearTimeout(timer); try { assert.equal(message.toString(), "udp-through-xray"); resolve(); } catch(e) { reject(e); } });
    s.send(Buffer.from("udp-through-xray"), 18080, "203.0.113.10");
  });
} finally { s.close(); }
console.log("TCP and interface-bound UDP traverse Xray.");
JS
# Removing the interface route must hit the terminal unreachable route, never the host default.
"${compose[@]}" exec -T server ip -4 route del default dev egress0 metric 10 table 20231
"${compose[@]}" exec -T --user 10001:10001 server node --input-type=module - <<'JS'
import assert from "node:assert/strict";
await assert.rejects(() => fetch("http://203.0.113.10:18080", { signal: AbortSignal.timeout(3000) }));
console.log("Missing TUN route fails closed.");
JS
"${compose[@]}" exec -T server sh -c 'setpriv --reuid=10002 --regid=10002 --clear-groups pkill -KILL -u 10002 -x xray'
sleep 4
"${compose[@]}" exec -T --user 10001:10001 server node --input-type=module - <<'JS'
import assert from "node:assert/strict";
const r=await fetch("http://203.0.113.10:18080", { signal: AbortSignal.timeout(10000) });
assert.equal(await r.text(), "xray-tunnel-fixture");
console.log("Xray restarts and reinstalls the TUN route.");
JS
if [[ ${PROXY_SMOKE_HOSTNET:-} == 1 ]]; then
  # Docker Desktop's host namespace is its Linux VM, so probe from that same host namespace.
  docker run --rm --network host --read-only --user 10003:10003 --entrypoint node \
    "${SERVER_IMAGE:-remote-claude-browser-server:local}" -e \
    "fetch('http://127.0.0.1:$SERVER_PORT/healthz').then(r=>{if(!r.ok)throw Error(r.status);return r.text()}).then(console.log)"
else
  curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$SERVER_PORT/healthz"
fi
echo
"${compose[@]}" stop server
"${compose[@]}" logs server | grep -q 'Xray policy routing cleaned up.'
echo 'Graceful shutdown removes the policy routes.'
if [[ ${PROXY_SMOKE_HOSTNET:-} == 1 ]]; then
  docker run --rm --network host --read-only --entrypoint sh \
    "${SERVER_IMAGE:-remote-claude-browser-server:local}" -c \
    'test -z "$(ip -4 rule show priority 10012)"'
  echo 'No browser policy rule remains on the host.'
fi
