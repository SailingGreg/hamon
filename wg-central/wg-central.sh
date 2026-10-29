#!/bin/bash
#
# wg-central.sh - bring up the central WireGuard interface and keep it there
#
# State lives in /etc/wg-central (a host directory, backed up with the rest):
#   server.key          the server's private key (made on first start)
#   wg-central.env      WG_IF (wg0), WG_ADDR (10.87.0.1/16), WG_PORT (51820)
#   peers/<box>.peer    one file per site box: PublicKey= and Address=
#
# The peer files are the whole configuration: the running interface is
# rebuilt from them with `wg syncconf`, which only adds/removes/changes the
# peers that differ - other boxes' sessions carry on untouched. wg-peer
# writes the files and calls `wg-peer sync`; nothing else edits the interface.
#
# Boxes can reach this server but not each other (FORWARD drop wg -> wg).
#

set -euo pipefail
D=/etc/wg-central
[ -f $D/wg-central.env ] && . $D/wg-central.env
WG_IF=${WG_IF:-wg0}
WG_ADDR=${WG_ADDR:-10.87.0.1/16}
WG_PORT=${WG_PORT:-51820}
mkdir -p $D/peers
umask 077
[ -s $D/server.key ] || wg genkey > $D/server.key

if ! ip link show "$WG_IF" >/dev/null 2>&1; then
    ip link add "$WG_IF" type wireguard
fi
ip address replace "$WG_ADDR" dev "$WG_IF"
ip link set "$WG_IF" up
wg set "$WG_IF" listen-port "$WG_PORT" private-key $D/server.key
WG_IF=$WG_IF wg-peer sync

# boxes talk to the server only, never to each other
iptables -C FORWARD -i "$WG_IF" -o "$WG_IF" -j DROP 2>/dev/null ||
    iptables -I FORWARD -i "$WG_IF" -o "$WG_IF" -j DROP
# a box accepts only packets from the server's tunnel address (its AllowedIPs);
# hamon/knxultimate bind to the host's main address, so send everything out of
# the tunnel as WG_ADDR - hamon needs no change and boxes trust one address
iptables -t nat -C POSTROUTING -o "$WG_IF" -j MASQUERADE 2>/dev/null ||
    iptables -t nat -A POSTROUTING -o "$WG_IF" -j MASQUERADE

echo "$(date '+%F %T') $WG_IF up: $WG_ADDR udp $WG_PORT, server key $(wg pubkey < $D/server.key), $(ls $D/peers | wc -l) peer(s)"

# the interface lives in the host namespace and is left up when the container
# stops: it keeps each box's last endpoint and session, so a restart or image
# update is hitless (start-up above only re-syncs the peer files). Deleting it
# lost every endpoint - nothing reached a box until its next keepalive (~15 s).
# `ip link del wg0` on the host is the way to really take it down.
trap 'exit 0' TERM INT
while sleep 3600 & wait $!; do :; done
