#!/bin/bash
# The P1 gate of single-writer input (docs/records/2026-11-27-page-mode-p1-gate.md).
#
# Each cell is one run of the composer-input smoke's gate (COMPOSER_SMOKE_ONLY=gate) on one device
# over one emulated link: RTT 50/150/300 ms with 2 % and 5 % loss on a desktop, an iPhone and a
# Pixel, single-writer input on; then the baselines, single-writer input at 150 ms with no loss and
# the old input path at 150 ms with 2 % loss. GATE_PARALLEL cells run at once (3 unless set: more
# contend for the CPU and skew the frame timing G1 measures). Each cell writes its measurements
# and log to GATE_OUT (tmp/p1-gate unless set); p1-gate-report.mjs judges them at the end and
# fails when a criterion or a run failed. GATE_CELLS=regex runs only the cells whose name matches.
#
# Run it in the background (it takes a while) and read GATE_OUT/report.md, e.g.
#   CLAUDE_LIMITED_TASK=1 bash scripts/p1-gate.sh > tmp/p1-gate.log 2>&1 &
set -euo pipefail
cd "$(dirname "$0")/.."
out=${GATE_OUT:-tmp/p1-gate}
parallel=${GATE_PARALLEL:-3}
filter=${GATE_CELLS:-.}
mkdir -p "$out"
cells=()
for rtt in 50 150 300; do
  for loss in 0.02 0.05; do
    for device in desktop iphone pixel; do cells+=("proxy $rtt $loss $device"); done
  done
done
for device in desktop iphone pixel; do cells+=("proxy 150 0 $device" "legacy 150 0.02 $device"); done

run_cell() {
  local input rtt loss device name
  read -r input rtt loss device <<<"$1"
  name="$input-$rtt-$loss-$device"
  local started=$SECONDS
  set +e
  CLAUDE_LIMITED_TASK=1 SMOKE_INPUT="$input" SMOKE_DEVICE="$device" SMOKE_RTT_MS="$rtt" \
    SMOKE_LOSS_RATE="$loss" COMPOSER_SMOKE_ONLY=gate SMOKE_GATE_OUT="$GATE_OUT_DIR/$name.json" \
    timeout 240 npx tsx scripts/composer-input-smoke.mts >"$GATE_OUT_DIR/$name.log" 2>&1
  local status=$?
  set -e
  echo "$status" >"$GATE_OUT_DIR/$name.exit"
  echo "$name: exit $status after $((SECONDS - started)) s"
}
export -f run_cell
export GATE_OUT_DIR="$out"

selected=()
for cell in "${cells[@]}"; do
  name=$(echo "$cell" | tr ' ' '-')
  if [[ "$name" =~ $filter ]]; then
    rm -f "$out/$name.json" "$out/$name.exit" "$out/$name.log"
    selected+=("$cell")
  fi
done
echo "p1-gate: ${#selected[@]} cells, $parallel at a time, into $out"
printf '%s\n' "${selected[@]}" | xargs -P "$parallel" -I{} bash -c 'run_cell "$1"' _ {}
node scripts/p1-gate-report.mjs "$out"
