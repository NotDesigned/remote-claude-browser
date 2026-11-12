#!/bin/sh
# Starts sing-box, which carries the browser user's traffic to EGRESS_PROXY over the egress0 TUN. It
# runs as a user of its own, holding only the capability to manage the network, so its own
# connection to the proxy stays outside the tunnel and outside the browser's firewall. If it stops it
# starts again, and meanwhile the firewall lets the browser reach nothing.
set -eu

browser_uid=${1:?usage: egress-tunnel.sh <browser uid>}
tunnel_uid=10002
interface=egress0
dir=/tmp/egress

# Root here holds no DAC_OVERRIDE, so it writes the configuration before handing the directory over.
install -d -m 0700 "$dir"
umask 077
proxy=$(node /opt/remote-browser/egress-proxy.mjs "$browser_uid" "$dir/config.json")
chown -R "$tunnel_uid:$tunnel_uid" "$dir"

as_tunnel() {
  setpriv --reuid="$tunnel_uid" --regid="$tunnel_uid" --clear-groups \
    --inh-caps=-all,+net_admin --ambient-caps=-all,+net_admin "$@"
}

as_tunnel sing-box check -c "$dir/config.json" -D "$dir"
(
  while :; do
    as_tunnel sing-box run -c "$dir/config.json" -D "$dir" || true
    echo "The tunnel to the outside proxy stopped; starting it again." >&2
    sleep 2
  done
) &

tries=0
until ip -o link show dev "$interface" up 2>/dev/null | grep -q .; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "The tunnel to the outside proxy did not come up. The container needs /dev/net/tun;" >&2
    echo "compose.proxy.yml passes it in." >&2
    exit 1
  fi
  sleep 0.1
done
echo "Browser traffic leaves through the outside proxy: $proxy"
