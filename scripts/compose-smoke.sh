#!/usr/bin/env bash
# Builds the server image, starts it, and checks what the deployment promises: the browser runs
# sandboxed as an unprivileged user, its firewall holds, and a page mirrors through a real login.
# Set CHROME_PATH to also run the login with a local browser.
set -euo pipefail

compose=(docker compose --file compose.yml)
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
export MIRROR_ACCESS_SECRET=compose-smoke-access-key
export MIRROR_AUTH_SECRET=compose-smoke-auth-key
export MIRROR_PUBLIC_ORIGIN=http://127.0.0.1:$smoke_port
export MIRROR_START_URL=about:blank

in_server() {
  "${compose[@]}" --project-name "$project" exec -T server "$@"
}

cleanup() {
  "${compose[@]}" --project-name "$project" down --volumes --remove-orphans >/dev/null 2>&1 || true
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
in_server test -s /app/viewer/index.html

# The browser and its sandbox.
browser_processes=$(in_server pgrep -a -x chromium || true)
[[ -n $browser_processes ]]
if grep --quiet -- '--no-sandbox' <<<"$browser_processes"; then
  echo "Chromium is running without its sandbox" >&2
  false
fi
if in_server sh -c "ps -eo uid=,args= | grep '[c]hromium' | grep -v '^ *10001 '"; then
  echo "Chromium is running as a privileged user" >&2
  false
fi
echo "Chromium runs as the browser user with its sandbox on."

# Picture mode needs both of these.
in_server pgrep -x Xvfb >/dev/null
[[ $(in_server ffmpeg -hide_banner -devices 2>/dev/null) == *x11grab* ]]
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
for blocked in http://169.254.169.254/ http://10.0.0.1/ "http://${SERVER_SUBNET%0/*}1/" http://127.0.0.1:3010/healthz; do
  if fetch_from_browser "$blocked"; then
    echo "The browser user reached $blocked" >&2
    false
  fi
done
fetch_from_browser https://example.com/
echo "The firewall blocks private addresses, and names still resolve for public ones."

# A login and a mirrored page, from a browser outside the container.
if [[ -n ${CHROME_PATH:-} ]]; then
  SMOKE_ORIGIN=$MIRROR_PUBLIC_ORIGIN SMOKE_PASSWORD=$MIRROR_ACCESS_PASSWORD \
    node scripts/compose-e2e.mjs
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
