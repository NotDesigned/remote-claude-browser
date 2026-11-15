#!/usr/bin/env bash
# Download an unmodified, pinned browser directly from its publisher. No system installation.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'usage: setup-fingerprint.sh <new directory> [cached archive]' >&2
  exit 2
fi
[[ $(uname -m) == x86_64 ]] || { echo 'This release supports Linux x64 only.' >&2; exit 1; }
destination=$(realpath -m "$1")
[[ ! -e $destination ]] || { echo 'Choose a new directory; existing installations are kept.' >&2; exit 1; }
release=v155.0.8059.85-aliasmode.5
archive_name=aliasmode-chromium-155.0.8059.85-linux-x64.tar.zst
digest=86e6c4304161ece6628ceb79eb6c9e5f57a148f5bec211753b8b4399319220d0
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
archive=${2:-$stage/$archive_name}
if [[ $# == 1 ]]; then
  curl --fail --location --connect-timeout 20 --max-time 600 \
    "https://github.com/aliasmode/aliasmode-chromium/releases/download/$release/$archive_name" \
    --output "$archive"
fi
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status
mkdir "$stage/browser"
tar --zstd --extract --file "$archive" --directory "$stage/browser" --strip-components=1 --no-same-owner
test -x "$stage/browser/chrome"
test -s "$stage/browser/LICENSE"
cat > "$stage/browser/SOURCE.txt" <<'SOURCE'
AliasMode Chromium 155.0.8059.85, build 5 (GPL-3.0).
Unmodified Linux x64 release, SHA256:
86e6c4304161ece6628ceb79eb6c9e5f57a148f5bec211753b8b4399319220d0
Publisher: https://github.com/aliasmode/aliasmode-chromium
Release: https://github.com/aliasmode/aliasmode-chromium/releases/tag/v155.0.8059.85-aliasmode.5
Corresponding patches and build instructions: https://github.com/aliasmode/aliasmode-chromium/tree/9f66792
SOURCE
chmod -R a+rX "$stage/browser"
mkdir -p "$(dirname "$destination")"
mv "$stage/browser" "$destination"
printf 'FINGERPRINT_BROWSER_DIR=%s\n' "$destination"
