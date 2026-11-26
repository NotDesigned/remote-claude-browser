#!/bin/sh
# Runs only in the server container's network namespace, under the root runtime broker.
set -eu
action=$1
name=$2
host_if=$3
host_ip=$4
peer_ip=$5
subnet=$6
host_ip6=$7
peer_ip6=$8
subnet6=$9
browser_uid=${BROWSER_UID:-10001}

case "$action" in
  start)
    # One ip process for each side instead of one per step.
    printf '%s\n' \
      "netns add $name" \
      "link add $host_if type veth peer name eth0 netns $name" \
      "address add $host_ip/30 dev $host_if" \
      "address add $host_ip6/126 dev $host_if nodad" \
      "link set $host_if up" | ip -batch -
    # Root Mihomo uses eth0; browser sockets use its TUN, including interface-bound UDP. eth0 never
    # gets a link-local address: address generation is off before it comes up.
    printf '%s\n' \
      'link set eth0 addrgenmode none' \
      "address add $peer_ip/30 dev eth0" \
      "address add $peer_ip6/126 dev eth0 nodad" \
      'link set lo up' \
      'link set eth0 up' \
      "route add default via $host_ip" \
      "route add default via $host_ip6" | ip -n "$name" -batch -
    # The namespace is new: each family's rules load whole, in one restore each and both at once,
    # instead of one process per rule (a new namespace's first ip6tables call alone takes ~35 ms).
    {
      echo '*filter'
      echo ':INPUT DROP [0:0]'
      echo ':FORWARD DROP [0:0]'
      echo ':OUTPUT DROP [0:0]'
      # Only neighbor discovery and Mihomo's root sockets may use the upstream IPv6 link.
      for chain in INPUT OUTPUT; do
        for type in neighbor-solicitation neighbor-advertisement; do
          echo "-A $chain -p ipv6-icmp --icmpv6-type $type -m hl --hl-eq 255 -j ACCEPT"
        done
        echo "-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
      done
      echo '-A INPUT -i lo -j ACCEPT'
      echo '-A OUTPUT -o lo -j ACCEPT'
      echo "-A OUTPUT -m owner --uid-owner $browser_uid -j REJECT"
      # User-imported proxy hosts must not turn root Mihomo into a route to host/LAN services.
      # Only the isolated protocol fixture uses private proxy servers; production never sets this.
      if [ "${EGRESS_TEST_PRIVATE_PROXY:-}" != 1 ]; then
        echo ':PROFILE-UPSTREAM - [0:0]'
        for network in ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 fc00::/7 fe80::/10 ff00::/8; do
          echo "-A PROFILE-UPSTREAM -d $network -j REJECT"
        done
        for address in $(printf '%s' "${EGRESS_BLOCK:-}" | tr ',' ' '); do
          case "$address" in *:*) echo "-A PROFILE-UPSTREAM -d $address -j REJECT" ;; esac
        done
        echo '-A OUTPUT -m owner --uid-owner 0 -j PROFILE-UPSTREAM'
      fi
      echo '-A OUTPUT -m owner --uid-owner 0 -j ACCEPT'
      echo 'COMMIT'
    } | ip netns exec "$name" ip6tables-restore &
    ipv6_rules=$!
    {
      echo '*filter'
      echo ':INPUT ACCEPT [0:0]'
      echo ':FORWARD ACCEPT [0:0]'
      echo ':OUTPUT ACCEPT [0:0]'
      echo "-A OUTPUT -m owner --uid-owner $browser_uid -o lo -j ACCEPT"
      echo "-A OUTPUT -m owner --uid-owner $browser_uid ! -o profile0 -j REJECT"
      if [ "${EGRESS_TEST_PRIVATE_PROXY:-}" != 1 ]; then
        echo ':PROFILE-UPSTREAM - [0:0]'
        echo '-A PROFILE-UPSTREAM -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN'
        for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
          echo "-A PROFILE-UPSTREAM -d $network -j REJECT"
        done
        for address in $(printf '%s' "${EGRESS_BLOCK:-}" | tr ',' ' '); do
          case "$address" in *:*) ;; *) echo "-A PROFILE-UPSTREAM -d $address -j REJECT" ;; esac
        done
        echo '-A OUTPUT -m owner --uid-owner 0 -j PROFILE-UPSTREAM'
      fi
      # A profile proxy is reachable only from the gateway and broker, never another namespace.
      echo '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'
      echo '-A INPUT -i lo -j ACCEPT'
      # The userspace TUN synthesizes return packets outside the kernel's conntrack flow.
      echo '-A INPUT -i profile0 -j ACCEPT'
      echo "-A INPUT -s $host_ip -p tcp --dport 8780 -j ACCEPT"
      echo '-A INPUT -j REJECT'
      echo 'COMMIT'
      echo '*nat'
      echo ':PREROUTING ACCEPT [0:0]'
      echo ':INPUT ACCEPT [0:0]'
      echo ':OUTPUT ACCEPT [0:0]'
      echo ':POSTROUTING ACCEPT [0:0]'
      for protocol in udp tcp; do
        echo "-A OUTPUT -m owner --uid-owner $browser_uid -p $protocol --dport 53 -j REDIRECT --to-ports 1053"
      done
      echo 'COMMIT'
    } | ip netns exec "$name" iptables-restore
    wait "$ipv6_rules"
    # This profile's rules in the server's own namespace, added to what is there (--noflush): one
    # restore per family, the same rules in the same order as one command each.
    printf '%s\n' '*nat' \
      "-A POSTROUTING -s $subnet6 ! -o $host_if -j MASQUERADE" \
      'COMMIT' '*filter' \
      "-I FORWARD 1 -i $host_if -s $peer_ip6 -j ACCEPT" \
      "-I FORWARD 1 -o $host_if -d $peer_ip6 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT" \
      'COMMIT' | ip6tables-restore --noflush --wait &
    root_ipv6_rules=$!
    printf '%s\n' '*nat' \
      "-A POSTROUTING -s $subnet ! -o $host_if -j MASQUERADE" \
      'COMMIT' '*filter' \
      "-I FORWARD 1 -i $host_if -s $peer_ip -j ACCEPT" \
      "-I FORWARD 1 -o $host_if -d $peer_ip -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT" \
      "-I OUTPUT 1 -m owner --uid-owner $browser_uid -d $peer_ip -p tcp --dport 8780 -j ACCEPT" \
      'COMMIT' | iptables-restore --noflush --wait
    wait "$root_ipv6_rules"
    # Override the legacy whole-gateway Xray rule for this one internal proxy address.
    ip rule add priority 100 to "$peer_ip/32" lookup main
    ;;
  route)
    # Mihomo accepts connections before it has created and raised its TUN; a route through a
    # device that is not up yet fails ("Device for nexthop is not up"). Wait for it, bounded.
    tries=0
    until ip -n "$name" link show profile0 2>/dev/null | grep -q '[<,]UP[,>]'; do
      tries=$((tries + 1))
      [ "$tries" -lt 250 ] || break
      sleep 0.02
    done
    ip -n "$name" route add table 201 default dev profile0
    ip -n "$name" rule add priority 100 uidrange "$browser_uid-$browser_uid" lookup 201
    ;;
  stop)
    ip6tables -D FORWARD -i "$host_if" -s "$peer_ip6" -j ACCEPT 2>/dev/null || true
    ip6tables -D FORWARD -o "$host_if" -d "$peer_ip6" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
    ip6tables -t nat -D POSTROUTING -s "$subnet6" ! -o "$host_if" -j MASQUERADE 2>/dev/null || true
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
