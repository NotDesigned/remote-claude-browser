#!/bin/sh
# Xray owns the TUN as UID 10002. Linux policy routing selects only browser-originated
# connections; replies to viewers keep their incoming path, including on host networking.
set -eu
browser_uid=${1:?usage: egress-tunnel.sh <browser uid>}
case $browser_uid in ''|*[!0-9]*|0) echo 'A non-root browser uid is required.' >&2; exit 1 ;; esac
tunnel_uid=10002
interface=egress0
dir=/tmp/egress
table=20231
gateway_port=${GATEWAY_PORT:-3010}
case $gateway_port in ''|*[!0-9]*) echo 'Invalid gateway port.' >&2; exit 1 ;; esac
if [ "$gateway_port" -lt 1 ] || [ "$gateway_port" -gt 65535 ]; then exit 1; fi

cleanup_routes() {
  # Only remove this deployment's reserved rules; never delete a foreign rule by priority alone.
  if ip -4 rule show priority 10012 | grep -Fq "uidrange $browser_uid-$browser_uid lookup 20231"; then
    ip -4 rule del priority 10012 uidrange "$browser_uid-$browser_uid" table "$table"
    if ip -4 rule show priority 10010 | grep -Fq "uidrange $browser_uid-$browser_uid ipproto tcp sport "; then
      ip -4 rule del priority 10010
    fi
    if ip -4 rule show priority 10011 | grep -Fq 'to 198.18.0.2 lookup 20231'; then
      ip -4 rule del priority 10011 to 198.18.0.2/32 table "$table"
    fi
    ip -4 route flush table "$table"
  fi
}
# Re-entering without a proxy also clears rules left by an unclean host-network shutdown.
if [ "${2:-}" = cleanup ]; then cleanup_routes; exit 0; fi

install -d -m 0700 "$dir"
umask 077
proxy=$(node /opt/remote-browser/egress-proxy.mjs "$dir/config.json")
unset EGRESS_PROXY EGRESS_BOOTSTRAP_DNS
chown -R "$tunnel_uid:$tunnel_uid" "$dir"
as_tunnel() {
  setpriv --reuid="$tunnel_uid" --regid="$tunnel_uid" --clear-groups \
    --inh-caps=-all,+net_admin --ambient-caps=-all,+net_admin "$@"
}
# Xray can repeat invalid credentials in a config error. Keep diagnostics in the private directory.
if ! as_tunnel sh -c 'xray run -test -config "$1/config.json" >"$1/check.log" 2>&1' sh "$dir"; then
  echo 'Invalid Xray configuration; private diagnostics: /tmp/egress/check.log' >&2
  exit 1
fi

# Replies from the HTTP listener keep the main route; all other browser sockets,
# including UDP sockets bound to an interface by WebRTC, enter the TUN. The firewall
# still rejects NEW direct connections even if a process binds the listener's port.
# These checks avoid replacing another application's rules on a host-network deployment.
for priority in 10010 10011 10012; do
  existing=$(ip -4 rule show priority "$priority")
  case $priority in
    10010) expected="uidrange $browser_uid-$browser_uid ipproto tcp sport $gateway_port lookup main" ;;
    10011) expected='from all to 198.18.0.2 lookup 20231' ;;
    10012) expected="from all uidrange $browser_uid-$browser_uid lookup 20231" ;;
  esac
  if [ -n "$existing" ] && ! printf '%s\n' "$existing" | grep -Fq "$expected"; then
    echo "Policy routing priority $priority is already in use." >&2
    exit 1
  fi
done
# This terminal route survives the interface disappearing: Linux must not fall back to main.
ip -4 route replace unreachable default metric 32767 table "$table"
if [ -z "$(ip -4 rule show priority 10010)" ]; then
  ip -4 rule add priority 10010 ipproto tcp sport "$gateway_port" uidrange "$browser_uid-$browser_uid" lookup main
fi
# Docker's embedded resolver forwards upstream queries as root, so its tunnel DNS needs a rule too.
if [ -z "$(ip -4 rule show priority 10011)" ]; then
  ip -4 rule add priority 10011 to 198.18.0.2/32 table "$table"
fi
if [ -z "$(ip -4 rule show priority 10012)" ]; then
  ip -4 rule add priority 10012 uidrange "$browser_uid-$browser_uid" table "$table"
fi

start_tunnel() {
  setpriv --reuid="$tunnel_uid" --regid="$tunnel_uid" --clear-groups \
    --inh-caps=-all,+net_admin --ambient-caps=-all,+net_admin \
    xray run -config "$dir/config.json" &
  child=$!
  tries=0
  until ip -o link show dev "$interface" up 2>/dev/null | grep -q .; do
    tries=$((tries + 1))
    if ! kill -0 "$child" 2>/dev/null || [ "$tries" -gt 100 ]; then
      kill "$child" 2>/dev/null || true
      wait "$child" 2>/dev/null || true
      return 1
    fi
    sleep 0.1
  done
  ip -4 route replace default dev "$interface" metric 10 table "$table"
}
# First startup must complete before the gateway can start; restarts reinstall the interface route.
if ! start_tunnel; then
  echo 'Xray TUN did not start. Check /dev/net/tun and compose.proxy.yml.' >&2
  exit 1
fi
(
  shutdown() {
    trap '' TERM INT
    as_tunnel kill -TERM "$child" 2>/dev/null || true
    # Keep fail-closed routing until all browser processes have stopped.
    tries=0
    while pgrep -u "$browser_uid" >/dev/null; do
      tries=$((tries + 1))
      if [ "$tries" -ge 50 ]; then exit 0; fi
      sleep 0.1
    done
    cleanup_routes
    echo 'Xray policy routing cleaned up.' >&2
    exit 0
  }
  trap shutdown TERM INT
  while :; do
    # This subshell cannot wait on the parent's child, so follow its process lifetime instead.
    while kill -0 "$child" 2>/dev/null; do sleep 1; done
    echo 'Xray stopped; restarting in two seconds. Browser traffic stays blocked.' >&2
    sleep 2
    until start_tunnel; do sleep 2; done
    wait "$child" || true
  done
) &
printf '%s\n' "$!" >/tmp/egress-supervisor.pid
echo "Browser traffic leaves through Xray: $proxy"
