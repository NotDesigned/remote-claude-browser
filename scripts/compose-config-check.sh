#!/usr/bin/env bash
# Runs `docker compose config` on every combination in docs/deployment.md's 「可用的 compose 组合」
# table, and on all the optional server files together, with placeholder values for what they require.
set -euo pipefail
cd "$(dirname "$0")/.."

export MIRROR_ACCESS_PASSWORD=placeholder-password MIRROR_AUTH_SECRET=placeholder-secret-0123456789
export PUBLIC_HOST=browser.example.com SERVER_SSH_HOST=example.com
export EGRESS_PROXY=socks5://127.0.0.1:1080
export FINGERPRINT_BROWSER_DIR=/opt/aliasmode

combinations=$(
  awk '/^## 可用的 compose 组合/ { table = 1; next } /^## / { table = 0 } table' docs/deployment.md |
    grep -oE '^\| `[^`]+`' | sed -E 's/^\| `([^`]+)`/\1/'
)
if [[ -z $combinations ]]; then
  echo "No combinations found in docs/deployment.md" >&2
  exit 1
fi
combinations+=$'\n'compose.yml:compose.runtime.yml:compose.https.yml:compose.fingerprint.yml:compose.proxy.yml

checked=0
while read -r combination; do
  [[ -n $combination ]] || continue
  files=()
  IFS=: read -ra list <<<"$combination"
  for file in "${list[@]}"; do files+=(--file "$file"); done
  if ! docker compose --env-file /dev/null "${files[@]}" config --quiet; then
    echo "docker compose config failed for $combination" >&2
    exit 1
  fi
  echo "ok   $combination"
  checked=$((checked + 1))
done <<<"$combinations"
echo "$checked Compose combinations pass docker compose config."
