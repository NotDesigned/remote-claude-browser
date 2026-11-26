#!/usr/bin/env bash
# Starts or stops a Compose stack for scripts/perf-interaction.mjs: the deployment's files, a
# loopback port, and the local exit fixture of compose-smoke.sh bound to the default profile.
# Every name is project-scoped; nothing of another deployment on the host is touched.
#
#   PERF_PROJECT=pu-perf SERVER_IMAGE=pu-server:perf bash scripts/perf-stack.sh up
#   PERF_PROJECT=pu-perf SERVER_IMAGE=pu-server:perf bash scripts/perf-stack.sh fixture  # after a restart
#   PERF_PROJECT=pu-perf SERVER_IMAGE=pu-server:perf bash scripts/perf-stack.sh down
#
# `up` and `fixture` print the variables perf-interaction.mjs reads. `down` removes the project's
# containers, networks and volumes; images named after the project are removed too.
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:?up, fixture or down}
project=${PERF_PROJECT:?Set PERF_PROJECT to a project name of its own}
overlay=$(mktemp)
trap 'rm -f -- "$overlay"' EXIT
cat >"$overlay" <<'YAML'
services:
  server:
    environment:
      MIRROR_DIAGNOSTIC_STDERR: "1"
      MIRROR_EXIT_LOOKUP_URL: ${SMOKE_FIXTURE_ORIGIN}/geo
YAML
compose=(docker compose --env-file /dev/null --file compose.yml --file compose.runtime.yml --file "$overlay")
export SERVER_BIND=127.0.0.1
export SERVER_PORT=${PERF_PORT:-3092}
# perf-interaction.mjs reaches the gateway through its own proxy on this port, which shapes the network.
public_port=${PERF_PUBLIC_PORT:-3091}
export SERVER_SUBNET=${SERVER_SUBNET:-172.31.108.0/24}
export CPA_RUNTIME_NETWORK=$project-cpa-runtime
export CPA_INSTANCE_SUBNETS=${CPA_INSTANCE_SUBNETS:-10.226.0.0/16}
export SERVER_IMAGE=${SERVER_IMAGE:-$project-server:local}
export CPA_BROKER_IMAGE=${CPA_BROKER_IMAGE:-$project-cpa-broker:local}
export CPA_BROKER_ENGINE_IMAGE=${CPA_BROKER_ENGINE_IMAGE:-$project-cpa:local}
export MIRROR_ACCESS_PASSWORD=perf-interaction-password
export MIRROR_ADMIN_USERNAME=perf-admin
export MIRROR_AUTH_SECRET=perf-interaction-auth-key
export MIRROR_PUBLIC_ORIGIN=http://127.0.0.1:$public_port
direct=http://127.0.0.1:$SERVER_PORT
export MIRROR_START_URL=about:blank
export SMOKE_PROXY_IP=203.0.113.21
export SMOKE_PROXY_PORT=$SERVER_PORT
export SMOKE_FIXTURE_ORIGIN=http://$SMOKE_PROXY_IP:18080
in_server() { "${compose[@]}" --project-name "$project" exec -T server "$@"; }

case $action in
down)
  "${compose[@]}" --project-name "$project" down --volumes --remove-orphans
  for image in "$SERVER_IMAGE" "$CPA_BROKER_IMAGE" "$CPA_BROKER_ENGINE_IMAGE"; do
    if [[ $image == "$project"-* || $image == pu-* ]]; then docker image rm "$image" >/dev/null 2>&1 || true; fi
  done
  exit 0
  ;;
up) "${compose[@]}" --project-name "$project" up --detach --build ;;
fixture) ;;
*)
  echo "Unknown action $action" >&2
  exit 2
  ;;
esac

deadline=$((SECONDS + 180))
until [[ $(curl --fail --silent "$direct/healthz" 2>/dev/null || true) == *'"browser":true'* ]]; do
  ((SECONDS < deadline)) || {
    echo "The server did not become healthy" >&2
    exit 1
  }
  sleep 2
done
in_server ip addr add "$SMOKE_PROXY_IP/32" dev lo 2>/dev/null || true
in_server node -e 'const fs = require("node:fs"); fs.writeFileSync("/tmp/compose-fixture.mjs", fs.readFileSync(0));' <scripts/compose-fixture.mjs
if [[ -n ${PERF_PM_BUNDLE:-} ]]; then
  # A ProseMirror bundle (window.PMComposer.mount) that the `pmreal` chat page loads.
  in_server mkdir -p /tmp/fixture-assets
  in_server sh -c 'cat >/tmp/fixture-assets/pm.js' <"$PERF_PM_BUNDLE"
fi
in_server pkill -f compose-fixture.mjs 2>/dev/null || true
"${compose[@]}" --project-name "$project" exec -d server node /tmp/compose-fixture.mjs "$SMOKE_PROXY_IP" "$SMOKE_PROXY_PORT" 18080
sleep 1
DIRECT_ORIGIN=$direct node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { createProbeSession } from "./scripts/probe-session.mjs";
const probe = await createProbeSession(process.env.DIRECT_ORIGIN, {
  credentials: {
    username: process.env.MIRROR_ADMIN_USERNAME,
    password: process.env.MIRROR_ACCESS_PASSWORD,
  },
  async prepare(api) {
    let { proxies } = await (await api("/api/proxies")).json();
    if (proxies.length === 0) {
      const imported = await api("/api/proxy-sources", "POST", {
        name: "Perf exit",
        visibility: "private",
        content: `socks5://${process.env.SMOKE_PROXY_IP}:${process.env.SMOKE_PROXY_PORT}#Perf`,
      });
      assert.equal(imported.status, 200, await imported.text());
      ({ proxies } = await (await api("/api/proxies")).json());
    }
    const bound = await api("/api/accounts/default/proxy", "PATCH", { proxyId: proxies[0].id });
    assert.equal(bound.status, 200, await bound.text());
  },
});
await probe.close();
NODE
echo "PERF_GATEWAY=$direct SMOKE_ORIGIN=$MIRROR_PUBLIC_ORIGIN SMOKE_USERNAME=$MIRROR_ADMIN_USERNAME SMOKE_PASSWORD=$MIRROR_ACCESS_PASSWORD SMOKE_FIXTURE_ORIGIN=$SMOKE_FIXTURE_ORIGIN"
