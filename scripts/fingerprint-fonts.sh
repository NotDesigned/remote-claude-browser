#!/bin/sh
# Fonts for AliasMode's Windows and macOS personas (docs/deployment.md, AliasMode 内核).
# AliasMode shows each persona only its own platform's font families, and only those installed on
# the host; with none installed a Windows persona has almost no fonts, which no real machine has.
# The fonts go to FINGERPRINT_FONTS_DIR (default local/fingerprint-fonts), which
# compose.fingerprint.yml mounts read-only for the browsers only.
#
#   scripts/fingerprint-fonts.sh import windows|macos DIR   copy the font files found under DIR
#   scripts/fingerprint-fonts.sh check                      which listed families the server has
#
# The family lists in scripts/fingerprint-fonts/ are AliasMode's core lists (Windows 11, macOS).
set -eu
cd "$(dirname "$0")/.."
dest=${FINGERPRINT_FONTS_DIR:-./local/fingerprint-fonts}

case ${1:-} in
import)
  os=${2:-}
  src=${3:-}
  case $os in windows | macos) ;; *)
    echo "usage: $0 import windows|macos DIR" >&2
    exit 2
    ;;
  esac
  [ -d "$src" ] || { echo "no directory $src" >&2; exit 2; }
  mkdir -p "$dest/$os"
  # Files already there are kept (re-running adds only what is new).
  find "$src" -type f \( -iname '*.ttf' -o -iname '*.ttc' -o -iname '*.otf' \) -exec sh -c '
    for f; do [ -e "$0/${f##*/}" ] || cp "$f" "$0/"; done' "$dest/$os" {} +
  echo "$(find "$dest/$os" -type f | wc -l) font files in $dest/$os."
  echo "Restart the server (docker compose up -d --force-recreate server), then run: $0 check"
  ;;
check)
  # What the browsers see: the server container's font index of the mounted directory.
  families=$(docker compose exec -T server fc-list --format '%{file}\t%{family}\n' |
    grep '^/usr/local/share/fonts/fingerprint/' || true)
  status=0
  for os in windows macos; do
    list=scripts/fingerprint-fonts/$os.txt
    have=$(printf '%s\n' "$families" | grep "^/usr/local/share/fonts/fingerprint/$os/" |
      cut -f2 | tr ',' '\n' | sort -u)
    missing=$(while IFS= read -r family; do
      printf '%s\n' "$have" | grep -qxF "$family" || printf '%s\n' "$family"
    done < "$list")
    total=$(grep -c . "$list")
    lacking=$(printf '%s' "$missing" | grep -c . || true)
    echo "$os: $((total - lacking)) of $total families"
    if [ "$lacking" -gt 0 ]; then
      status=1
      printf '%s\n' "$missing" | paste -sd, - | sed 's/,/, /g; s/^/  missing: /'
    fi
  done
  exit $status
  ;;
*)
  echo "usage: $0 import windows|macos DIR | check" >&2
  exit 2
  ;;
esac
