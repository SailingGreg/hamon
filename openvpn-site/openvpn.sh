#!/usr/bin/env bash
#
# openvpn.sh - entrypoint of the openvpn-site image: the OpenVPN client for one
# KNX site, forwarding CONT_PORT (UDP, and TCP for KNXnet/IP TCP tunnelling) on
# the container to the KNX interface VPN_REMOTEDEST:VPN_REMOTEPORT on the site
# LAN. hamon talks to the container's address on the hamon network.
#
# /vpn holds the site's profile - vpn.conf, or the only *.conf / *.ovpn there -
# and the files it names. tap or tun comes from the profile's dev / dev-type:
#   tun  the server gives the interface its address
#   tap  the interface is on the site LAN and takes an address there by DHCP
# The profile sets its own log (/var/log/openvpn.log: vpn-reconnect.sh and
# test-site.sh read it). Optional: /vpn/vpn.auth (user/password),
# /vpn/vpn.cert_auth (the key's passphrase).
#
# openvpn runs in the foreground as the container's main process: if it exits,
# the container stops and --restart on-failure starts it again (the images this
# replaces ran it as a daemon behind a shell, so a dead openvpn left the
# container up and "healthy").
#
# env: VPN_REMOTEDEST  the KNX interface's LAN address (no forward if unset,
#                      as for utils/vpn-site/test-site.sh)
#      VPN_REMOTEPORT  its port (3671)
#      CONT_PORT       the port hamon uses on the container

set -o nounset

dir=/vpn
conf=$dir/vpn.conf
if [ ! -f "$conf" ]; then
    mapfile -t found < <(ls -d "$dir"/* 2>/dev/null | grep -E '\.(conf|ovpn)$')
    [ "${#found[@]}" -eq 1 ] && conf=${found[0]}
fi
if [ ! -f "$conf" ]; then
    echo "ERROR: no profile in $dir (vpn.conf, or one *.conf / *.ovpn)"
    sleep 120   # don't let --restart spin
    exit 1
fi

# tap or tun, and the interface name ("dev tun" is tun0: the container has no other)
dev=$(awk '$1 == "dev" { print $2; exit }' "$conf" | tr -d '\r')
devtype=$(awk '$1 == "dev-type" { print $2; exit }' "$conf" | tr -d '\r')
case "${devtype:-$dev}" in
    tap*) mode=tap ;;
    tun*) mode=tun ;;
    *) echo "ERROR: $conf: dev '${dev}' is neither tap nor tun"; sleep 120; exit 1 ;;
esac
ifname=$dev
[[ $ifname =~ [0-9]$ ]] || ifname=${mode}0
echo "$ifname" > /run/vpn-ifname
echo "profile $conf: $mode ($ifname)"

mkdir -p /dev/net
[ -c /dev/net/tun ] || mknod -m 0666 /dev/net/tun c 10 200

# the forward; the rules can go in before the interface exists
if [ -n "${VPN_REMOTEDEST:-}" ] && [ -n "${CONT_PORT:-}" ]; then
    to="$VPN_REMOTEDEST:${VPN_REMOTEPORT:-3671}"
    iptables -t nat -A PREROUTING -p udp --dport "$CONT_PORT" -j DNAT --to-destination "$to"
    iptables -t nat -A PREROUTING -p tcp --dport "$CONT_PORT" -j DNAT --to-destination "$to"
    iptables -t nat -A POSTROUTING -o "$ifname" -j MASQUERADE
    echo "forward: $CONT_PORT udp+tcp -> $to via $ifname"
else
    echo "no forward (VPN_REMOTEDEST or CONT_PORT not set)"
fi

# tap: keep a DHCP address on the interface. udhcpc starts once the interface
# is there; if the address goes (the interface recreated on a reconnect without
# persist-tun), it is asked to renew
if [ "$mode" = tap ]; then
    (
        until ip link show "$ifname" >/dev/null 2>&1; do sleep 1; done
        udhcpc -i "$ifname" -b -R -s /usr/local/bin/udhcpc.script -p /run/udhcpc.pid >/dev/null 2>&1
        while sleep 10; do
            ip link show "$ifname" >/dev/null 2>&1 || continue
            ip -4 addr show dev "$ifname" | grep -q inet && continue
            echo "$ifname has no address - DHCP renew"
            if [ -s /run/udhcpc.pid ] && kill -0 "$(cat /run/udhcpc.pid)" 2>/dev/null; then
                kill -USR1 "$(cat /run/udhcpc.pid)"
            else
                udhcpc -i "$ifname" -b -R -s /usr/local/bin/udhcpc.script -p /run/udhcpc.pid >/dev/null 2>&1
            fi
        done
    ) &
fi

args=(--cd "$dir" --config "$conf" --script-security 2)
[ -e "$dir/vpn.auth" ] && args+=(--auth-user-pass "$dir/vpn.auth")
[ -e "$dir/vpn.cert_auth" ] && args+=(--askpass "$dir/vpn.cert_auth")
exec openvpn "${args[@]}"
