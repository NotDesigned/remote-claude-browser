#!/usr/bin/env bash
# First run of the server: writes .env with random secrets if there is none, then starts it.
set -euo pipefail

for tool in openssl curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s is required.\n' "$tool" >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required. See docs/deployment.md.\n' >&2
  exit 1
fi

created_env=0
if [[ ! -e .env ]]; then
  umask 077
  password=${MIRROR_ACCESS_PASSWORD:-$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n')}
  temp_env=".env.tmp.$$"
  trap 'rm -f "$temp_env"' EXIT
  {
    printf 'MIRROR_ACCESS_PASSWORD=%s\n' "$password"
    printf 'MIRROR_ACCESS_SECRET=%s\n' "${MIRROR_ACCESS_SECRET:-$(openssl rand -hex 32)}"
    printf 'MIRROR_AUTH_SECRET=%s\n' "${MIRROR_AUTH_SECRET:-$(openssl rand -hex 32)}"
    printf 'MIRROR_PUBLIC_ORIGIN=%s\n' "${MIRROR_PUBLIC_ORIGIN:-}"
    printf 'SERVER_BIND=%s\n' "${SERVER_BIND:-127.0.0.1}"
    printf 'SERVER_PORT=%s\n' "${SERVER_PORT:-3010}"
  } >"$temp_env"
  mv "$temp_env" .env
  trap - EXIT
  created_env=1
fi

docker compose up --detach

published=$(docker compose port server 3010 | tail -n 1)
local_origin="http://127.0.0.1:${published##*:}"
deadline=$((SECONDS + 300))
until health=$(curl --fail --silent "${local_origin}/healthz" 2>/dev/null) &&
  [[ $health == *'"ok":true'* && $health == *'"browser":true'* ]]; do
  if ((SECONDS >= deadline)); then
    printf 'The server did not become healthy in time.\n' >&2
    docker compose ps >&2
    exit 1
  fi
  sleep 2
done

printf '\nThe server is ready at %s\n' "$local_origin"
if [[ $created_env -eq 1 ]]; then
  printf 'Password: %s\n' "$password"
  printf 'Credentials were saved to .env with owner-only permissions.\n'
else
  printf 'Using the existing .env file (left unchanged).\n'
fi
