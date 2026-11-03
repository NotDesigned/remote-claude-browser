#!/bin/bash
# Every child shares a single cgroup budget and a single project maintenance lock.
set -euo pipefail
if [ "$#" -eq 0 ]; then echo 'usage: bash scripts/limited-run.sh command [args...]' >&2; exit 2; fi
if [ "${CLAUDE_LIMITED_TASK:-}" = 1 ]; then exec "$@"; fi
if ! systemctl is-system-running >/dev/null 2>&1 && ! systemctl is-system-running 2>/dev/null | grep -qx degraded; then
  echo 'A running systemd is required for resource-limited maintenance.' >&2
  exit 1
fi
if ! systemctl cat claude-maintenance.slice >/dev/null 2>&1; then
  echo 'Install deploy/remote/claude*.slice before starting maintenance.' >&2
  exit 1
fi
unit="claude-maintenance-$(date +%s)-$$"
exec systemd-run --quiet --wait --pipe --collect --service-type=exec \
  --unit="$unit" --slice=claude-maintenance.slice --working-directory="$PWD" \
  --property=CPUQuota=35% --property=CPUWeight=10 --property=Nice=15 \
  --property=MemoryHigh=800M --property=MemoryMax=960M --property=MemorySwapMax=128M \
  --property=IOWeight=10 --property=IOSchedulingClass=idle --property=TasksMax=256 \
  --property=KillMode=control-group --property=OOMPolicy=kill \
  --setenv=PATH="$PATH" --setenv=CLAUDE_LIMITED_TASK=1 \
  --setenv=NODE_OPTIONS=--max-old-space-size=512 --setenv=GOMAXPROCS=1 \
  --setenv=UV_THREADPOOL_SIZE=1 --setenv=npm_config_child_concurrency=1 \
  --setenv=npm_config_network_concurrency=2 \
  /usr/bin/flock --wait 300 /run/lock/claude-maintenance.lock "$@"
