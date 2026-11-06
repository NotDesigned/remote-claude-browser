#!/bin/sh
# Runs twice: as root to set the firewall and hand over the data directory, then as the browser user.
set -eu

if [ "$(id -u)" = 0 ]; then
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
  chown browser:browser /data
  exec setpriv --reuid=browser --regid=browser --clear-groups --inh-caps=-all "$0" "$@"
fi

umask 0077
mkdir -p "$HOME" "$CHROME_USER_DATA_DIR"
# Only this container uses the profile, so a lock in it was left by a previous run. Chromium would
# take one from a container with another hostname to mean the profile is in use elsewhere.
rm -f "$CHROME_USER_DATA_DIR/SingletonLock" \
  "$CHROME_USER_DATA_DIR/SingletonSocket" \
  "$CHROME_USER_DATA_DIR/SingletonCookie"

display_number=${DISPLAY#:}
# Abstract sockets belong to the network namespace, which compose.hostnet.yml shares with the host.
Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN:-12800x2880x24}" -nolisten tcp -nolisten local -noreset &
tries=0
until [ -S "/tmp/.X11-unix/X$display_number" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "Xvfb did not start" >&2
    exit 1
  fi
  sleep 0.1
done

exec node dist/main.mjs
