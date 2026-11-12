#!/bin/sh
# Root supervises shutdown and network cleanup. The gateway, display and Chromium
# run in a second invocation as the unprivileged browser user.
set -eu

if [ "$(id -u)" = 0 ]; then
  if [ -n "${EGRESS_PROXY:-}" ]; then
    if [ "${EGRESS_POLICY:-on}" != on ]; then
      echo "EGRESS_PROXY needs EGRESS_POLICY=on: its firewall keeps pages from going around the proxy." >&2
      exit 1
    fi
    export EGRESS_TUNNEL=egress0
  else
    /opt/remote-browser/egress-tunnel.sh "$(id -u browser)" cleanup
  fi
  case ${EGRESS_POLICY:-on} in
    on)
      if ! /opt/remote-browser/server-egress.sh "$(id -u browser)"; then
        echo "Could not set the outbound firewall, so the browser will not start." >&2
        echo "The container needs NET_ADMIN; EGRESS_POLICY=off runs without the firewall." >&2
        exit 1
      fi
      ;;
    off) echo "EGRESS_POLICY=off: pages can reach this host's private networks." >&2 ;;
    *)
      echo "EGRESS_POLICY must be on or off" >&2
      exit 1
      ;;
  esac
  if [ -n "${EGRESS_PROXY:-}" ]; then
    if ! /opt/remote-browser/egress-tunnel.sh "$(id -u browser)"; then
      echo "Could not start the tunnel to EGRESS_PROXY, so the browser will not start." >&2
      exit 1
    fi
  fi
  # The browser and the gateway have no use for the proxy's address or password.
  unset EGRESS_PROXY EGRESS_BOOTSTRAP_DNS EGRESS_TUNNEL
  chown browser:browser /data
  # Keep the supervisor alive until Chromium and the routing helper have shut down.
  # Otherwise PID 1 can exit and kill the helper before it cleans the host's policy rules.
  gateway_pid=
  terminate_gateway() {
    trap '' TERM INT
    if [ -n "$gateway_pid" ]; then kill -TERM "$gateway_pid" 2>/dev/null || true; fi
  }
  trap terminate_gateway TERM INT
  setpriv --reuid=browser --regid=browser --clear-groups --inh-caps=-all "$0" "$@" &
  gateway_pid=$!
  gateway_exit=0
  while :; do
    gateway_exit=0
    wait "$gateway_pid" || gateway_exit=$?
    if ! kill -0 "$gateway_pid" 2>/dev/null; then break; fi
  done
  pkill -TERM -u 10001 2>/dev/null || true
  tries=0
  while pgrep -u 10001 >/dev/null && [ "$tries" -lt 50 ]; do
    tries=$((tries + 1)); sleep 0.1
  done
  pkill -KILL -u 10001 2>/dev/null || true
  if [ -r /tmp/egress-supervisor.pid ]; then
    tunnel_supervisor=$(cat /tmp/egress-supervisor.pid)
    kill -TERM "$tunnel_supervisor" 2>/dev/null || true
    tries=0
    while kill -0 "$tunnel_supervisor" 2>/dev/null && [ "$tries" -lt 60 ]; do
      tries=$((tries + 1)); sleep 0.1
    done
    /opt/remote-browser/egress-tunnel.sh "$(id -u browser)" cleanup
    echo 'Xray policy routing cleaned up.' >&2
  fi
  exit "$gateway_exit"
fi

umask 0077
mkdir -p "$HOME" "$CHROME_USER_DATA_DIR"
# Geo-IP follows this container's public egress, not the device opening the viewer. The resolver
# writes /etc/localtime's writable target too, so other container processes use the same timezone.
TZ=$(node /opt/remote-browser/timezone.mjs)
export TZ
# Only this container uses the profile, so a lock in it was left by a previous run. Chromium would
# take one from a container with another hostname to mean the profile is in use elsewhere.
rm -f "$CHROME_USER_DATA_DIR/SingletonLock" \
  "$CHROME_USER_DATA_DIR/SingletonSocket" \
  "$CHROME_USER_DATA_DIR/SingletonCookie"

display_number=${DISPLAY#:}
# Abstract sockets belong to the network namespace, which compose.hostnet.yml shares with the host.
# Chromium draws with its own SwiftShader, so GLX would only load Mesa's LLVM (about 45 MB). A black
# root leaves the unused screen as zero pages, which compressed swap stores for almost nothing.
Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN:-12800x2880x24}" -br -extension GLX \
  -nolisten tcp -nolisten local -noreset &
tries=0
until [ -S "/tmp/.X11-unix/X$display_number" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "Xvfb did not start" >&2
    exit 1
  fi
  sleep 0.1
done

# The gateway keeps about 130 MB live, but V8 sizes its heap from the host's memory and lets garbage
# pile up to several times that before a full collection. This keeps the heap closer to what is used.
exec node --optimize-for-size dist/main.mjs
