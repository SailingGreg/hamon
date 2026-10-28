#!/bin/sh
#
# server.sh - a stand-in site for openvpn-site/test/run-test.sh: an OpenVPN
# server (MODE=tun: udp, the server gives the address; MODE=tap: tcp, bridged,
# the client takes an address by DHCP from dnsmasq on the "site LAN") and a fake
# KNX interface on port 3671 that answers every UDP datagram / TCP line with
# "KNX-ECHO <the sender's address> <what it got>".

set -eu
cd /pki

if [ "$MODE" = tap ]; then
    gw=192.168.77.1
    openvpn --mktun --dev tap0 >/dev/null
    # a fixed MAC, as a real site's bridge keeps across a VPN blip (a new one
    # each server restart would leave the client's ARP entry pointing nowhere)
    ip link set tap0 address 02:00:00:77:00:01
    ip addr add $gw/24 dev tap0
    ip link set tap0 up
    # dnsmasq hands out a router too (its default): the client must not take it
    dnsmasq --interface=tap0 --bind-interfaces --port=0 \
        --dhcp-range=192.168.77.100,192.168.77.150,255.255.255.0,1h
    net="dev tap0
proto tcp-server
server-bridge"
else
    gw=10.98.0.1
    net="dev tun
proto udp
topology subnet
server 10.98.0.0 255.255.255.0"
fi

reply='read -r l; echo "KNX-ECHO $SOCAT_PEERADDR $l"'
socat UDP4-RECVFROM:3671,fork SYSTEM:"$reply" &
socat TCP4-LISTEN:3671,fork,reuseaddr SYSTEM:"$reply" &

cat > /tmp/server.conf <<EOF
port 1194
$net
ca ca.crt
cert server.crt
key server.key
dh none
keepalive 5 20
verb 3
EOF
echo "test site $MODE: gateway $gw:3671"
exec openvpn --config /tmp/server.conf
