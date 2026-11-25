#!/usr/bin/env bash
# Read-only checks of what the server needs from the Docker host. See docs/deployment.md.
set -euo pipefail

failures=0

ok() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'fail %s\n' "$1"
  failures=$((failures + 1))
}
check() {
  local label=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else fail "$label"; fi
}

check "Docker CLI" docker --version
check "Docker daemon" docker info

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose plugin"
elif docker-compose version >/dev/null 2>&1; then
  fail "only legacy docker-compose found; Compose v2 is required"
else
  fail "Docker Compose v2"
fi

# cpa-broker speaks Docker API 1.47, which Docker Engine 27.3 introduced.
api=$(docker version --format '{{.Server.APIVersion}}' 2>/dev/null || true)
if [[ -z $api ]]; then
  fail "Docker Engine version (no answer from the daemon)"
elif [[ $(printf '%s\n%s\n' 1.47 "$api" | sort -V | head -n 1) == 1.47 ]]; then
  ok "Docker Engine API $api (1.47 or newer)"
else
  fail "Docker Engine API $api is older than 1.47; Docker Engine 27.3 or newer is required"
fi

# Chromium's sandbox needs user namespaces.
if [[ -r /proc/sys/user/max_user_namespaces && $(cat /proc/sys/user/max_user_namespaces) == 0 ]]; then
  fail "user namespaces are disabled (user.max_user_namespaces=0)"
fi
if [[ -r /proc/sys/kernel/unprivileged_userns_clone && $(cat /proc/sys/kernel/unprivileged_userns_clone) == 0 ]]; then
  fail "unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)"
fi

# On AppArmor hosts the server runs under its own profile, which must be loaded first.
if [[ $(docker info --format '{{json .SecurityOptions}}' 2>/dev/null) == *name=apparmor* ]]; then
  profiles=/sys/kernel/security/apparmor/profiles
  if [[ ! -r $profiles ]]; then
    printf 'warn cannot read %s; run as root to check the remote-claude-browser AppArmor profile\n' "$profiles"
  elif grep -q '^remote-claude-browser (enforce)$' "$profiles"; then
    ok "AppArmor profile remote-claude-browser is loaded"
  else
    fail "AppArmor profile remote-claude-browser is not loaded; run: sudo scripts/install-apparmor.sh"
  fi
else
  ok "Docker does not use AppArmor here; no profile needed"
fi

if [[ $failures -ne 0 ]]; then
  printf '\nHost check failed. See docs/deployment.md for supported prerequisites.\n' >&2
  exit 1
fi
