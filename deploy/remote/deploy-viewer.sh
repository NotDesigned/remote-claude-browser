#!/bin/bash
# Publish checked static assets while leaving B's running browser and gateway untouched.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${CLAUDE_LIMITED_TASK:-}" != 1 ]; then
  exec bash scripts/limited-run.sh bash deploy/remote/deploy-viewer.sh "$@"
fi
test -s packages/viewer/dist/index.html
if [ -f deploy/remote/local.env ]; then . deploy/remote/local.env; fi
remote_host=${REMOTE_HOST:?Set REMOTE_HOST to the server\'s SSH host, here or in deploy/remote/local.env}
archive=$(mktemp /tmp/claude-viewer.XXXXXX.tar.gz)
trap 'rm -f "$archive"' EXIT
tar -C packages/viewer/dist -czf "$archive" .
remote_stage=$(ssh "$remote_host" 'mktemp -d /tmp/claude-viewer-publish.XXXXXX')
scp "$archive" "$remote_host:$remote_stage/viewer.tar.gz"
ssh "$remote_host" bash -s -- "$remote_stage" <<'REMOTE'
set -euo pipefail
stage=$1
viewer=$(readlink -f /opt/claude-browser/current/viewer)
test -s "$viewer/index.html"
mkdir "$stage/content"
tar -xzf "$stage/viewer.tar.gz" -C "$stage/content"
test -s "$stage/content/index.html"
cp -a "$viewer/index.html" "$viewer/index.html.previous"
# Preserve old hashed assets for clients already open; publish the new entry point last.
cp -an "$stage/content/assets/." "$viewer/assets/"
for file in "$stage/content/"*; do
  [ -f "$file" ] || continue
  [ "$(basename "$file")" != index.html ] || continue
  install -m 644 "$file" "$viewer/$(basename "$file").next"
  mv -Tf "$viewer/$(basename "$file").next" "$viewer/$(basename "$file")"
done
install -m 644 "$stage/content/index.html" "$viewer/index.html.next"
mv -Tf "$viewer/index.html.next" "$viewer/index.html"
rm -rf "$stage"
echo 'Viewer updated; browser and gateway were not restarted.'
REMOTE
