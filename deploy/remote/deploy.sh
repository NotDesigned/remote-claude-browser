#!/bin/bash
# Builds on A, installs a versioned runtime on B; never touches the persistent Profile.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${CLAUDE_LIMITED_TASK:-}" != 1 ]; then
  exec bash scripts/limited-run.sh bash deploy/remote/deploy.sh "$@"
fi
remote_host=${REMOTE_HOST:-remote-server}
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
scp "$stage_dir/release.tar.gz" "$remote_host:/tmp/claude-release.tar.gz"
ssh "$remote_host" "install -d /opt/claude-browser/releases/$release_id; tar -xzf /tmp/claude-release.tar.gz -C /opt/claude-browser/releases/$release_id; ln -sfn /opt/claude-browser/releases/$release_id /opt/claude-browser/current"
scp deploy/remote/claude-browser.service deploy/remote/claude-display.service deploy/remote/claude-egress.service deploy/remote/claude-browser.slice "$remote_host:/etc/systemd/system/"
ssh "$remote_host" 'systemctl daemon-reload && systemctl enable claude-display claude-egress claude-browser && systemctl restart claude-egress claude-display claude-browser'
install -m 644 deploy/remote/claude-tunnel.service /etc/systemd/system/claude-tunnel.service
systemctl daemon-reload
systemctl enable --now claude-tunnel
echo 'Runtime deployed. Check systemctl status claude-tunnel and B: claude-browser.'
