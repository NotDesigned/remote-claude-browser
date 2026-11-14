#!/bin/sh
# Runs only in the server container's network namespace, under the root runtime broker.
set -eu
action=$1
name=$2
host_if=$3
host_ip=$4
peer_ip=$5
subnet=$6
browser_uid=${BROWSER_UID:-10001}

case "$action" in
  start)
    ip netns add "$name"
    ip link add "$host_if" type veth peer name eth0 netns "$name"
    ip addr add "$host_ip/30" dev "$host_if"
    ip link set "$host_if" up
    ip -n "$name" addr add "$peer_ip/30" dev eth0
    ip -n "$name" link set lo up
    ip -n "$name" link set eth0 up
    ip -n "$name" route add default via "$host_ip"
    # Root Mihomo uses eth0; browser sockets use its TUN, including interface-bound UDP.
    # Docker mounts /proc/sys read-only; netlink and namespace-local IPv6 filtering suffice.
    ip -n "$name" link set eth0 addrgenmode none
    ip -n "$name" -6 addr flush dev eth0
    for chain in INPUT OUTPUT FORWARD; do
      ip netns exec "$name" ip6tables -P "$chain" DROP
    done
    ip netns exec "$name" iptables -A OUTPUT -m owner --uid-owner "$browser_uid" -o lo -j ACCEPT
    ip netns exec "$name" iptables -A OUTPUT -m owner --uid-owner "$browser_uid" ! -o profile0 -j REJECT
    # User-imported proxy hosts must not turn root Mihomo into a route to host/LAN services.
    # Only the isolated protocol fixture uses private proxy servers; production never sets this.
    if [ "${EGRESS_TEST_PRIVATE_PROXY:-}" != 1 ]; then
      ip netns exec "$name" iptables -N PROFILE-UPSTREAM
      ip netns exec "$name" iptables -A PROFILE-UPSTREAM -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
      for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
        ip netns exec "$name" iptables -A PROFILE-UPSTREAM -d "$network" -j REJECT
      done
      for address in $(printf '%s' "${EGRESS_BLOCK:-}" | tr ',' ' '); do
        case "$address" in *:*) ;; *) ip netns exec "$name" iptables -A PROFILE-UPSTREAM -d "$address" -j REJECT ;; esac
      done
      ip netns exec "$name" iptables -A OUTPUT -m owner --uid-owner 0 -j PROFILE-UPSTREAM
    fi
    for protocol in udp tcp; do
      ip netns exec "$name" iptables -t nat -A OUTPUT -m owner --uid-owner "$browser_uid" \
        -p "$protocol" --dport 53 -j REDIRECT --to-ports 1053
    done
    # A profile proxy is reachable only from the gateway and broker, never another namespace.
    ip netns exec "$name" iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ip netns exec "$name" iptables -A INPUT -i lo -j ACCEPT
    # The userspace TUN synthesizes return packets outside the kernel's conntrack flow.
    ip netns exec "$name" iptables -A INPUT -i profile0 -j ACCEPT
    ip netns exec "$name" iptables -A INPUT -s "$host_ip" -p tcp --dport 8780 -j ACCEPT
    ip netns exec "$name" iptables -A INPUT -j REJECT
    iptables -t nat -A POSTROUTING -s "$subnet" ! -o "$host_if" -j MASQUERADE
    iptables -I FORWARD 1 -i "$host_if" -s "$peer_ip" -j ACCEPT
    iptables -I FORWARD 1 -o "$host_if" -d "$peer_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Override the legacy whole-gateway Xray rule for this one internal proxy address.
    ip rule add priority 100 to "$peer_ip/32" lookup main
    iptables -I OUTPUT 1 -m owner --uid-owner "$browser_uid" -d "$peer_ip" -p tcp --dport 8780 -j ACCEPT
    ;;
  route)
    ip -n "$name" route add table 201 default dev profile0
    ip -n "$name" rule add priority 100 uidrange "$browser_uid-$browser_uid" lookup 201
    ;;
  stop)
    iptables -D OUTPUT -m owner --uid-owner "$browser_uid" -d "$peer_ip" -p tcp --dport 8780 -j ACCEPT 2>/dev/null || true
    ip rule del priority 100 to "$peer_ip/32" lookup main 2>/dev/null || true
    iptables -D FORWARD -i "$host_if" -s "$peer_ip" -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -o "$host_if" -d "$peer_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    iptables -t nat -D POSTROUTING -s "$subnet" ! -o "$host_if" -j MASQUERADE 2>/dev/null || true
    ip link del "$host_if" 2>/dev/null || true
    ip netns del "$name" 2>/dev/null || true
    ;;
  *) exit 2 ;;
esac
