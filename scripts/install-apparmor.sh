#!/usr/bin/env bash
# Loads the server container's AppArmor profile (deploy/apparmor/remote-claude-browser) on this
# Docker host and installs it under /etc/apparmor.d so it is loaded again after a reboot.
# Run it as root on the host whose Docker daemon runs the server, and again after each upgrade.
set -euo pipefail

source=$(cd "$(dirname "$0")/.." && pwd)/deploy/apparmor/remote-claude-browser
target=/etc/apparmor.d/remote-claude-browser

# Without access to the daemon its security options are unknown, which is not "no AppArmor".
if ! options=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null); then
  if [[ $EUID -ne 0 ]]; then
    printf 'Cannot reach the Docker daemon as this user. Run this as root, for example: sudo %s\n' "$0" >&2
  else
    printf 'Cannot reach the Docker daemon. Start Docker and run this again.\n' >&2
  fi
  exit 1
fi
if [[ $options != *name=apparmor* ]]; then
  printf "This Docker daemon does not use AppArmor; the profile is not needed here.\n"
  exit 0
fi
if [[ $EUID -ne 0 ]]; then
  printf 'Run this as root, for example: sudo %s\n' "$0" >&2
  exit 1
fi
if ! command -v apparmor_parser >/dev/null 2>&1; then
  printf 'apparmor_parser is missing. Install the apparmor package and run this again.\n' >&2
  exit 1
fi

staged=$(mktemp)
trap 'rm -f "$staged"' EXIT
cp "$source" "$staged"
if ! apparmor_parser --skip-kernel-load --skip-cache -o /dev/null "$staged" >/dev/null 2>&1; then
  # AppArmor 3 does not know the userns rule. Kernels that old do not restrict user namespaces
  # through AppArmor either, so the profile works without it.
  sed -i '/^  userns,$/d' "$staged"
  apparmor_parser --skip-kernel-load --skip-cache -o /dev/null "$staged"
  printf 'This AppArmor version has no userns rule; loading the profile without it.\n'
fi
install -m 0644 "$staged" "$target"
apparmor_parser --replace --write-cache "$target"
printf 'Loaded the AppArmor profile remote-claude-browser from %s.\n' "$target"
