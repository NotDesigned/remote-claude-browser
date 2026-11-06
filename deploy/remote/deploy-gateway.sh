#!/bin/bash
# Deploy checked bundles without restarting the display or replacing Profile.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${CLAUDE_LIMITED_TASK:-}" != 1 ]; then
  exec bash scripts/limited-run.sh bash deploy/remote/deploy-gateway.sh "$@"
fi
test -s packages/gateway/dist/main.mjs
case ${1:-} in ""|--with-viewer) ;; *) echo 'usage: deploy-gateway.sh [--with-viewer]' >&2; exit 2;; esac
if [ -f deploy/remote/local.env ]; then . deploy/remote/local.env; fi
remote_host=${REMOTE_HOST:?Set REMOTE_HOST to the server\'s SSH host, here or in deploy/remote/local.env}
release_id="$(date -u +%Y%m%dT%H%M%SZ)-gateway"
remote_bundle=$(ssh "$remote_host" 'mktemp /tmp/claude-gateway.XXXXXX')
scp packages/gateway/dist/main.mjs "$remote_host:$remote_bundle"
remote_viewer=""
if [ "${1:-}" = --with-viewer ]; then
  test -s packages/viewer/dist/index.html
  viewer_archive=$(mktemp /tmp/claude-viewer.XXXXXX.tar.gz)
  trap 'rm -f "$viewer_archive"' EXIT
  tar -C packages/viewer/dist -czf "$viewer_archive" .
  remote_viewer=$(ssh "$remote_host" 'mktemp /tmp/claude-viewer.XXXXXX')
  scp "$viewer_archive" "$remote_host:$remote_viewer"
fi
ssh "$remote_host" bash -s -- "$release_id" "$remote_bundle" "$remote_viewer" <<'REMOTE'
set -euo pipefail
previous=$(readlink -f /opt/claude-browser/current)
release="/opt/claude-browser/releases/$1"
test -f "$previous/dist/main.mjs"
cp -al "$previous" "$release"
# Unlink before writing so the previous release's hard-linked bundle stays intact.
rm "$release/dist/main.mjs"
install -m 644 "$2" "$release/dist/main.mjs"
rm "$2"
if [ -n "${3:-}" ]; then
  # Remove this release's links before extracting; never overwrite previous-release inodes.
  rm -rf "$release/viewer"
  mkdir "$release/viewer"
  tar -xzf "$3" -C "$release/viewer"
  rm "$3"
fi
ln -s "$release" /opt/claude-browser/current.next
mv -Tf /opt/claude-browser/current.next /opt/claude-browser/current
systemctl restart claude-browser
for attempt in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:3010/healthz >/dev/null; then
    echo "Gateway healthy: $release"
    # Same retention as deploy.sh. Later releases share files with this one by hard link.
    ls -1 /opt/claude-browser/releases | sort -r | tail -n +6 | while read -r old; do
      [ "/opt/claude-browser/releases/$old" = "$release" ] || rm -rf -- "/opt/claude-browser/releases/$old"
    done
    exit 0
  fi
  sleep 1
done
ln -s "$previous" /opt/claude-browser/current.next
mv -Tf /opt/claude-browser/current.next /opt/claude-browser/current
systemctl restart claude-browser
echo 'Gateway health check failed; restored previous release.' >&2
exit 1
REMOTE
