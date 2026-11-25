#!/usr/bin/env bash
# Builds the server image, starts it, and checks what the deployment promises: the browser runs
# sandboxed as an unprivileged user, its firewall holds, and a page mirrors through a real login.
# Set CHROME_PATH to also run the login with a local browser.
set -euo pipefail

# The deployment's own files. The overlay below only adds what a test needs: diagnostics, a short
# idle grace, and the exit lookup pointed at the local fixture.
overlay=$(mktemp)
cat > "$overlay" <<'YAML'
services:
  server:
    environment:
      MIRROR_DIAGNOSTIC_STDERR: "1"
      # A hidden session's pages are released after a minute, not 15 (compose-e2e waits 80 s).
      MIRROR_IDLE_GRACE_MS: "60000"
      MIRROR_EXIT_LOOKUP_URL: ${SMOKE_FIXTURE_ORIGIN}/geo
YAML
compose=(docker compose --env-file /dev/null --file compose.yml --file compose.runtime.yml --file "$overlay")
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
# Names that are not project-scoped get the project's name, so the smoke can run beside a deployment.
export CPA_RUNTIME_NETWORK=$project-cpa-runtime
export CPA_INSTANCE_SUBNETS=${CPA_INSTANCE_SUBNETS:-10.239.0.0/16}
export SERVER_IMAGE=${SERVER_IMAGE:-remote-claude-browser-server:local}
export CPA_BROKER_IMAGE=${CPA_BROKER_IMAGE:-remote-claude-browser-cpa-broker:local}
export CPA_BROKER_ENGINE_IMAGE=${CPA_BROKER_ENGINE_IMAGE:-remote-claude-browser-cpa:local}
cpa_ids=()
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
  # The broker's instances are not part of the Compose project; remove exactly the ones made here.
  for id in "${cpa_ids[@]}"; do
    docker rm --force "remote-browser-$id" >/dev/null 2>&1 || true
  done
  "${compose[@]}" --project-name "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
  for id in "${cpa_ids[@]}"; do
    docker network rm "remote-browser-$id-net" >/dev/null 2>&1 || true
    docker volume rm "remote-browser-$id-config" "remote-browser-$id-auth" "remote-browser-$id-static" \
      >/dev/null 2>&1 || true
  done
  rm -- "$overlay"
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

# CPA instances from the real cpa-broker: each on its own internal network, out of Compose's view.
if [[ ${SMOKE_HOSTNET:-} != 1 ]]; then
  in_server node -e 'const fs = require("node:fs"); fs.writeFileSync("/tmp/compose-cpa-client.mjs", fs.readFileSync(0));' < scripts/compose-cpa-client.mjs
  as_cpa_client() {
    in_server setpriv --reuid=browser --regid=browser --clear-groups node /tmp/compose-cpa-client.mjs "$@"
  }
  for _ in 1 2; do
    cpa_ids+=("cpa-$(openssl rand -hex 10)")
  done
  for id in "${cpa_ids[@]}"; do
    as_cpa_client ensure "$id"
  done
  first=remote-browser-${cpa_ids[0]}
  second=remote-browser-${cpa_ids[1]}
  labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$first")
  [[ $labels == '|' ]] || { echo "The CPA instance carries Compose labels: $labels" >&2; false; }
  [[ $(docker inspect --format '{{.HostConfig.NetworkMode}}' "$first") == "$first-net" ]]
  [[ $(docker network inspect --format '{{.Internal}}' "$first-net") == true ]]
  members=$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$first-net")
  [[ $(wc -w <<<"$members") == 2 && $members == *"$first"* && $members == *cpa-broker* ]] || {
    echo "Unexpected members of $first-net: $members" >&2
    false
  }
  # The broker relays runtime-egress:8781 to the server's proxy, which asks for credentials.
  relay=$(docker exec "$first" node -e '
    const s = require("node:net").connect(8781, "runtime-egress", () =>
      s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
    s.setTimeout(5000, () => { console.log("timeout"); process.exit(); });
    s.once("data", (d) => { console.log(String(d).split("\r\n")[0]); process.exit(); });
    s.once("error", (e) => { console.log(e.code); process.exit(); });')
  [[ $relay == *' 407'* ]] || { echo "runtime-egress from a CPA instance gave: $relay" >&2; false; }
  # One instance cannot reach another.
  first_ip=$(docker inspect --format "{{(index .NetworkSettings.Networks \"$first-net\").IPAddress}}" "$first")
  reach=$(docker exec "$second" node -e '
    const s = require("node:net").connect(8317, process.argv[1], () => { console.log("open"); process.exit(); });
    s.setTimeout(3000, () => { console.log("timeout"); process.exit(); });
    s.once("error", (e) => { console.log(e.code); process.exit(); });' "$first_ip")
  [[ $reach != open ]] || { echo "One CPA instance reached another at $first_ip" >&2; false; }
  # Compose leaves them alone. A re-created broker joins their networks again and keeps
  # up-to-date instances as they are.
  before=$(docker inspect --format '{{.Id}}' "$first")
  "${compose[@]}" --project-name "$project" up --detach --remove-orphans --no-build
  "${compose[@]}" --project-name "$project" up --detach --no-build --no-deps --force-recreate cpa-broker
  deadline=$((SECONDS + 60))
  until [[ $(docker inspect --format '{{.State.Health.Status}}' "$project-cpa-broker-1") == healthy ]]; do
    ((SECONDS < deadline)) || { echo "cpa-broker did not become healthy again" >&2; false; }
    sleep 1
  done
  [[ $(docker inspect --format '{{.Id}}' "$first") == "$before" ]]
  as_cpa_client ensure "${cpa_ids[0]}"
  for id in "${cpa_ids[@]}"; do
    as_cpa_client delete "$id"
    if docker inspect "remote-browser-$id" >/dev/null 2>&1 ||
      docker network inspect "remote-browser-$id-net" >/dev/null 2>&1 ||
      docker volume inspect "remote-browser-$id-config" >/dev/null 2>&1; then
      echo "Removing $id left something behind" >&2
      false
    fi
  done
  echo "CPA instances are isolated, reach only the authenticated egress, and survive Compose."
fi

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
