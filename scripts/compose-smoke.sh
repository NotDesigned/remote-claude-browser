#!/usr/bin/env bash
# Builds the server image, starts it, and checks what the deployment promises: the browser runs
# sandboxed as an unprivileged user, its firewall holds, and a page mirrors through a real login.
# Set CHROME_PATH to also run the login with a local browser.
set -euo pipefail

runtime=$(mktemp)
export SMOKE_BROKER_BUNDLE=$(mktemp --suffix=.mjs)
cat > "$runtime" <<'YAML'
services:
  server:
    # Ubuntu's default AppArmor profile denies the mounts used by ip netns and Chromium's wrapper.
    security_opt:
      - apparmor=unconfined
    environment:
      MIRROR_PROFILE_EGRESS: "1"
      MIRROR_RUNTIME_SOCKET: /run/remote-browser/runtime.sock
      SMOKE_GEO_URL: ${SMOKE_FIXTURE_ORIGIN}/geo
    devices:
      - /dev/net/tun:/dev/net/tun
    volumes:
      - ${SMOKE_BROKER_BUNDLE}:/app/dist/profile-broker.mjs:ro
    tmpfs:
      - /run/netns:rw,nosuid,nodev,size=1m,mode=0755
      - /run/remote-browser:rw,nosuid,nodev,size=16m,mode=0755
    sysctls:
      net.ipv4.ip_forward: "1"
      net.ipv6.conf.all.forwarding: "1"
YAML
compose=(docker compose --env-file /dev/null --file compose.yml --file "$runtime")
# SMOKE_HOSTNET=1 tests compose.hostnet.yml.
if [[ ${SMOKE_HOSTNET:-} == 1 ]]; then
  compose+=(--file compose.hostnet.yml)
fi
project=${REMOTE_BROWSER_SMOKE_PROJECT:-remote-browser-smoke-$$}
smoke_port=${REMOTE_BROWSER_SMOKE_PORT:-}
if [[ -z $smoke_port ]]; then
  smoke_port=$(
    node -e "const n=require('node:net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})"
  )
fi

export SERVER_BIND=127.0.0.1
export SERVER_PORT=$smoke_port
export SERVER_SUBNET=${SERVER_SUBNET:-172.31.67.0/24}
export MIRROR_ACCESS_PASSWORD=compose-smoke-password
export MIRROR_ADMIN_USERNAME=${MIRROR_ADMIN_USERNAME:-compose-admin}
export MIRROR_AUTH_SECRET=compose-smoke-auth-key
export MIRROR_PUBLIC_ORIGIN=http://127.0.0.1:$smoke_port
export MIRROR_START_URL=about:blank
export SMOKE_PROXY_IP=203.0.113.21
export SMOKE_PROXY_PORT=$smoke_port
export SMOKE_FIXTURE_ORIGIN=http://$SMOKE_PROXY_IP:18080
proxy_started=false

in_server() {
  "${compose[@]}" --project-name "$project" exec -T server "$@"
}

cleanup() {
  if [[ ${SMOKE_HOSTNET:-} == 1 && $proxy_started == true ]]; then
    in_server ip addr del "$SMOKE_PROXY_IP/32" dev lo >/dev/null 2>&1 || true
  fi
  "${compose[@]}" --project-name "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -- "$runtime" "$SMOKE_BROKER_BUNDLE"
}

diagnose() {
  local status=$?
  set +e
  "${compose[@]}" --project-name "$project" ps >&2
  "${compose[@]}" --project-name "$project" logs --no-color --tail=100 >&2
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap diagnose ERR

node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
const { build } = createRequire(new URL('./packages/gateway/package.json', import.meta.url))('esbuild');
await build({
  entryPoints: ['scripts/compose-broker.mts'], outfile: process.env.SMOKE_BROKER_BUNDLE,
  bundle: true, platform: 'node', format: 'esm', external: ['undici'],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  define: { 'import.meta.url': '"file:///compose-broker-fixture.mjs"' },
});
NODE
chmod 644 "$SMOKE_BROKER_BUNDLE"

"${compose[@]}" --project-name "$project" up --detach --build

deadline=$((SECONDS + 180))
health=
until HEALTH_JSON=$health node -e "
  const value = JSON.parse(process.env.HEALTH_JSON || '{}');
  process.exit(value.ok === true && value.browser === true ? 0 : 1);
"; do
  if ((SECONDS >= deadline)); then
    echo "The server did not become healthy in time. Last answer: $health" >&2
    false
  fi
  sleep 2
  health=$(curl --fail --silent "http://127.0.0.1:${smoke_port}/healthz" 2>/dev/null || true)
done
echo "Healthy: $health"

gate=$(curl --fail --silent "http://127.0.0.1:${smoke_port}/gate")
[[ $gate == *'<form method="post" action="/gate">'* ]]
[[ $gate == *'name="username"'* ]]
in_server test -s /app/viewer/index.html

in_server ip addr add "$SMOKE_PROXY_IP/32" dev lo
proxy_started=true
in_server node -e 'const fs = require("node:fs"); fs.writeFileSync("/tmp/compose-fixture.mjs", fs.readFileSync(0));' < scripts/compose-fixture.mjs
"${compose[@]}" --project-name "$project" exec -d server node /tmp/compose-fixture.mjs "$SMOKE_PROXY_IP" "$SMOKE_PROXY_PORT" 18080

# Bind the fixture's proxy before opening a real authenticated browser workspace.
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createProbeSession } from './scripts/probe-session.mjs';
const probe = await createProbeSession(process.env.MIRROR_PUBLIC_ORIGIN, {
  async prepare(api) {
    const imported = await api('/api/proxy-sources', 'POST', {
      name: 'Compose smoke exit', visibility: 'private',
      content: `socks5://${process.env.SMOKE_PROXY_IP}:${process.env.SMOKE_PROXY_PORT}#Smoke`,
    });
    assert.equal(imported.status, 200, await imported.text());
    const { proxies: [proxy] } = await (await api('/api/proxies')).json();
    const bound = await api('/api/accounts/default/proxy', 'PATCH', { proxyId: proxy.id });
    assert.equal(bound.status, 200, await bound.text());
  },
});
try {
  if (!probe.sid) throw new Error('The authenticated smoke workspace was not allocated');
} finally {
  await probe.close();
}
NODE

# The browser and its sandbox.
browser_processes=$(in_server pgrep -a -x chromium || true)
[[ -n $browser_processes ]]
if grep --quiet -- '--no-sandbox' <<<"$browser_processes"; then
  echo "Chromium is running without its sandbox" >&2
  false
fi
if in_server sh -c "ps -C chromium -o uid= | grep -v '^ *10001 *$'"; then
  echo "Chromium is running as a privileged user" >&2
  false
fi
echo "Chromium runs as the browser user with its sandbox on."

# Picture mode needs both of these.
in_server pgrep -x Xvfb >/dev/null
[[ $(in_server ffmpeg -hide_banner -devices 2>/dev/null) == *x11grab* ]]
# Capture while Chromium runs, with what the gateway passes. ffmpeg can log a failed grab and still
# exit 0, so this counts the bytes and treats anything it logs as a failure.
capture=$(in_server sh -c 'setpriv --reuid=browser --regid=browser --clear-groups \
  ffmpeg -hide_banner -loglevel error -f x11grab -draw_mouse 0 -framerate 5 -video_size 320x200 -i :99 \
  -frames:v 5 -f rawvideo -pix_fmt gray - 2>/tmp/capture.log | wc -c; cat /tmp/capture.log; rm -f /tmp/capture.log')
if [[ $capture != 320000 ]]; then
  echo "Capturing the display gave: $capture" >&2
  false
fi
echo "The display and its capture are in place."

# The firewall, from the browser user: blocked where it matters, and the internet still open.
as_browser() {
  in_server setpriv --reuid=browser --regid=browser --clear-groups "$@"
}
fetch_from_browser() {
  as_browser node -e "
    fetch(process.argv[1], { signal: AbortSignal.timeout(8000) }).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  " "$1"
}
for blocked in http://169.254.169.254/ http://10.0.0.1/ "http://${SERVER_SUBNET%0/*}1/" http://127.0.0.1:3010/healthz "http://127.0.0.1:$smoke_port/healthz"; do
  if fetch_from_browser "$blocked"; then
    echo "The browser user reached $blocked" >&2
    false
  fi
done
fetch_from_browser https://example.com/
echo "The firewall blocks private addresses, and names still resolve for public ones."

# A login and a mirrored page, from a browser outside the container.
if [[ -n ${CHROME_PATH:-} ]]; then
  SMOKE_ORIGIN=$MIRROR_PUBLIC_ORIGIN SMOKE_USERNAME=$MIRROR_ADMIN_USERNAME SMOKE_PASSWORD=$MIRROR_ACCESS_PASSWORD \
    node scripts/compose-e2e.mjs
  # A missing program or a failed capture only shows in the gateway's log.
  problems=$("${compose[@]}" --project-name "$project" logs --no-color server 2>&1 |
    grep -E 'ENOENT|client picture failed' || true)
  if [[ -n $problems ]]; then
    echo "The gateway reported problems:" >&2
    echo "$problems" >&2
    false
  fi
fi

# The profile outlives the container, which also checks that its lock does not stop a new one.
in_server sh -c 'test -d /data/profile'
"${compose[@]}" --project-name "$project" up --detach --force-recreate
deadline=$((SECONDS + 120))
until [[ $(curl --fail --silent "http://127.0.0.1:${smoke_port}/healthz" || true) == *'"browser":true'* ]]; do
  if ((SECONDS >= deadline)); then
    echo "The server did not come back after being re-created" >&2
    false
  fi
  sleep 2
done

printf 'Compose smoke passed on loopback port %s (project %s).\n' "$smoke_port" "$project"
