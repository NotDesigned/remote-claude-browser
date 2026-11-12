#!/bin/sh
# Stops web pages reaching private networks, the Docker host and cloud metadata services. These rules
# live in the container's own network namespace, so the host's firewall is untouched. They apply to
# the browser user, which is also what the gateway runs as: replies to incoming connections still
# pass, and the gateway makes no other connections.
#
# With EGRESS_TUNNEL set to the outside proxy's interface, nothing else leaves: if the proxy is down,
# pages get no connection rather than one from this host's own address.
set -eu

browser_uid=${1:?usage: server-egress.sh <browser uid>}
chain=REMOTE-BROWSER

# Docker's resolver redirects port 53 on 127.0.0.11 to a port of its own, so these match the
# destination the connection was opened to. Any other connection to that address is refused below.
allow_dns() {
  for protocol in udp tcp; do
    "$1" -w -A "$chain" -p "$protocol" -m conntrack \
      --ctorigdst "$2" --ctproto "$protocol" --ctorigdstport 53 -j RETURN
  done
}

reject() {
  "$1" -w -A "$chain" -d "$2" -j REJECT
}

prepare() {
  "$1" -w -N "$chain" 2>/dev/null || true
  "$1" -w -F "$chain"
  "$1" -w -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
}

finish() {
  if [ -n "${EGRESS_TUNNEL:-}" ]; then
    "$1" -w -A "$chain" ! -o "$EGRESS_TUNNEL" -j REJECT
  fi
  "$1" -w -A "$chain" -j RETURN
  "$1" -w -C OUTPUT -m owner --uid-owner "$browser_uid" -j "$chain" 2>/dev/null ||
    "$1" -w -I OUTPUT 1 -m owner --uid-owner "$browser_uid" -j "$chain"
}

# EGRESS_BLOCK adds addresses a container cannot see for itself, above all the host's public IP.
extra=$(printf '%s' "${EGRESS_BLOCK:-}" | tr ',' ' ')
resolvers=$(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)

prepare iptables
for resolver in $resolvers; do
  case $resolver in
    *:*) ;;
    *) allow_dns iptables "$resolver" ;;
  esac
done
for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
  192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  reject iptables "$network"
done
for address in $(ip -o -4 addr show scope global | awk '{ print $4 }' | cut -d/ -f1); do
  reject iptables "$address"
done
for address in $extra; do
  case $address in
    *:*) ;;
    *) reject iptables "$address" ;;
  esac
done
finish iptables

# compose.yml turns IPv6 off in this container. If it is on anyway, it gets the same treatment, and
# failing to set that up stops the browser from starting.
if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || echo 1)" = 0 ]; then
  prepare ip6tables
  for resolver in $resolvers; do
    case $resolver in
      *:*) allow_dns ip6tables "$resolver" ;;
      *) ;;
    esac
  done
  # ::ffff:0:0/96 and 64:ff9b::/96 would otherwise reach blocked IPv4 ranges by mapping or NAT64.
  for network in ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 fc00::/7 fe80::/10 ff00::/8; do
    reject ip6tables "$network"
  done
  for address in $(ip -o -6 addr show scope global | awk '{ print $4 }' | cut -d/ -f1); do
    reject ip6tables "$address"
  done
  for address in $extra; do
    case $address in
      *:*) reject ip6tables "$address" ;;
      *) ;;
    esac
  done
  finish ip6tables
fi
