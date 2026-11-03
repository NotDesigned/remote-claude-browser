#!/bin/sh
# Only this application's service UID is affected; existing host services are untouched.
set -eu
browser_uid=$(id -u claude-browser)
for family in iptables ip6tables; do
  "$family" -w -N CLAUDE-BROWSER 2>/dev/null || true
  "$family" -w -F CLAUDE-BROWSER
  "$family" -w -A CLAUDE-BROWSER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  if [ "$family" = iptables ]; then
    for dns in 127.0.0.53 127.0.0.54; do
      "$family" -w -A CLAUDE-BROWSER -d "$dns" -p udp --dport 53 -j RETURN
      "$family" -w -A CLAUDE-BROWSER -d "$dns" -p tcp --dport 53 -j RETURN
    done
    for network in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
      "$family" -w -A CLAUDE-BROWSER -d "$network" -j REJECT
    done
    ip -o -4 addr show scope global | awk '{print $4}' | cut -d/ -f1 | while read -r address; do
      "$family" -w -A CLAUDE-BROWSER -d "$address" -j REJECT
    done
    if [ -n "${GATEWAY_A_IP:-}" ]; then "$family" -w -A CLAUDE-BROWSER -d "$GATEWAY_A_IP" -j REJECT; fi
  else
    # ::ffff:0:0/96 and 64:ff9b::/96 would otherwise reach blocked IPv4 ranges via mapping/NAT64.
    for network in ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 fc00::/7 fe80::/10 ff00::/8; do
      "$family" -w -A CLAUDE-BROWSER -d "$network" -j REJECT
    done
    ip -o -6 addr show scope global | awk '{print $4}' | cut -d/ -f1 | while read -r address; do
      "$family" -w -A CLAUDE-BROWSER -d "$address" -j REJECT
    done
  fi
  "$family" -w -A CLAUDE-BROWSER -j RETURN
  "$family" -w -C OUTPUT -m owner --uid-owner "$browser_uid" -j CLAUDE-BROWSER 2>/dev/null || \
    "$family" -w -I OUTPUT 1 -m owner --uid-owner "$browser_uid" -j CLAUDE-BROWSER
done
