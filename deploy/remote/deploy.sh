#!/bin/bash
# Builds on A, installs a versioned runtime on B; never touches the persistent Profile.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${CLAUDE_LIMITED_TASK:-}" != 1 ]; then
  exec bash scripts/limited-run.sh bash deploy/remote/deploy.sh "$@"
fi
if [ -f deploy/remote/local.env ]; then . deploy/remote/local.env; fi
remote_host=${REMOTE_HOST:?Set REMOTE_HOST to the server\'s SSH host, here or in deploy/remote/local.env}
release_id=$(date -u +%Y%m%dT%H%M%SZ)
stage_dir=$(mktemp -d /tmp/claude-release.XXXXXX)
trap 'rm -rf "$stage_dir"' EXIT
pnpm run build
pnpm --filter @mirror/gateway deploy --prod "$stage_dir/runtime"
cp -a packages/viewer/dist "$stage_dir/runtime/viewer"
mkdir -p "$stage_dir/runtime/deploy"
cp deploy/remote/egress.sh "$stage_dir/runtime/deploy/"
chmod +x "$stage_dir/runtime/deploy/egress.sh"
cp LICENSE NOTICE THIRD_PARTY_NOTICES.md UPSTREAM_COMMIT "$stage_dir/runtime/"
tar -C "$stage_dir/runtime" -czf "$stage_dir/release.tar.gz" .
remote_tarball="/tmp/claude-release-$release_id.tar.gz"
releases=/opt/claude-browser/releases
scp "$stage_dir/release.tar.gz" "$remote_host:$remote_tarball"
previous=$(ssh "$remote_host" "readlink -f /opt/claude-browser/current 2>/dev/null || true")
ssh "$remote_host" "set -e; install -d $releases/$release_id; tar -xzf $remote_tarball -C $releases/$release_id; rm -f $remote_tarball; ln -sfn $releases/$release_id /opt/claude-browser/current"
scp deploy/remote/claude-browser.service deploy/remote/claude-display.service deploy/remote/claude-egress.service deploy/remote/claude-browser.slice "$remote_host:/etc/systemd/system/"
echo 'Restarting claude-browser on B: every open remote page and unsent draft will be interrupted.'
ssh "$remote_host" 'systemctl daemon-reload && systemctl enable claude-display claude-egress claude-browser && systemctl restart claude-egress claude-display claude-browser'

# The gateway refuses unsafe production config (see production-guard.ts), so a failed health
# check also catches a missing secret or a stray MIRROR_E2E. Roll back instead of leaving B down.
healthy() {
  ssh "$remote_host" 'for _ in $(seq 1 30); do
    systemctl is-active --quiet claude-browser &&
      /usr/local/bin/node -e "fetch(\"http://127.0.0.1:3010/healthz\").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" &&
      exit 0
    sleep 2
  done
  exit 1'
}
if ! healthy; then
  echo "Release $release_id failed its health check." >&2
  ssh "$remote_host" 'journalctl -u claude-browser -n 20 --no-pager' >&2 || true
  if [ -n "$previous" ] && [ "$previous" != "$releases/$release_id" ]; then
    echo "Rolling back to $previous" >&2
    ssh "$remote_host" "ln -sfn $previous /opt/claude-browser/current && systemctl restart claude-browser"
  fi
  exit 1
fi

# Keep the five newest releases (always including the active one) so B's disk does not fill up.
ssh "$remote_host" "cd $releases && ls -1 | sort -r | tail -n +6 | while read -r old; do
  [ \"$releases/\$old\" = \"\$(readlink -f /opt/claude-browser/current)\" ] || rm -rf -- \"\$old\"
done"
install -d -m 755 /etc/claude-browser
printf 'REMOTE_HOST=%s\n' "$remote_host" >/etc/claude-browser/tunnel.env
install -m 644 deploy/remote/claude-tunnel.service /etc/systemd/system/claude-tunnel.service
systemctl daemon-reload
systemctl enable --now claude-tunnel
echo 'Runtime deployed. Check systemctl status claude-tunnel and B: claude-browser.'
