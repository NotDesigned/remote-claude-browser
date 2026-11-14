#!/bin/sh
# Runs a throwaway E2E copy of the server image, with the running server's egress and time zone, and
# checks what fingerprinting sites see in several fresh browser accounts. Never touches /data.
# Usage: scripts/fingerprint-check.sh [image] [accounts]
set -eu
image=${1:-remote-claude-browser-server:local}
accounts=${2:-3}
name=fingerprint-check
port=3910
dir=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

# The same egress as production, so the sites see the same address and time zone.
if docker inspect remote-claude-browser-server-1 >/dev/null 2>&1; then
  docker inspect remote-claude-browser-server-1 --format '{{range .Config.Env}}{{println .}}{{end}}' |
    grep -E '^(EGRESS_|MIRROR_TIMEZONE=)' >"$dir/env" || true
else
  : >"$dir/env"
fi
chmod 600 "$dir/env"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --init --env-file "$dir/env" \
  -e NODE_ENV=test -e MIRROR_E2E=1 -e MIRROR_CLIENTS=8 -e MIRROR_START_URL=about:blank \
  --cap-drop ALL --cap-add CHOWN --cap-add KILL --cap-add NET_ADMIN --cap-add SETGID \
  --cap-add SETUID --cap-add SYS_ADMIN --cap-add SYS_CHROOT \
  --device /dev/net/tun --security-opt no-new-privileges:true \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 --shm-size 1g \
  -p "127.0.0.1:$port:3010" "$image" >/dev/null
for _ in $(seq 1 60); do
  curl -sf -m 3 "http://127.0.0.1:$port/healthz" >/dev/null && break
  sleep 2
done
node "$(dirname "$0")/fingerprint-check.mjs" "http://127.0.0.1:$port" "$accounts"
