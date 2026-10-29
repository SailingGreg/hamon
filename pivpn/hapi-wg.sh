#!/usr/bin/env bash
#
# hapi-wg.sh  -  give a site box WireGuard beside its OpenVPN link, from the dev Pi.
#
#   ./hapi-wg.sh <pi-address>            add (or refresh) the box's WireGuard link
#   ./hapi-wg.sh --remove <pi-address>   revoke it: the link stops at once, OpenVPN stays
#
# The box keeps its OpenVPN address 10.86.0.N and gets 10.88.0.N on WireGuard -
# the same N, so one address plan serves both. It needs:
#   - hapi-build.sh from 0b71d35 on (wireguard-tools and the box's own key,
#     /etc/wireguard/wg0.key, which never leaves it) - re-run the build first
#   - its OpenVPN address (hapi-assign.sh or hapi-approve.sh)
#   - wg-central running on prod (wg-central/)
#
# Steps: the box's public key over ssh; on prod `wg-peer add <box> <key>
# 10.88.0.N` (live, other boxes untouched); wg0.conf on the box (server key,
# endpoint by name, address) and wg-quick@wg0 enabled; wait for the handshake;
# hapi-agent through the WireGuard link; a Builds row in the register.
# OpenVPN is never touched, so this can't cut a box off. Safe to re-run: a
# rebuilt box with a new key is re-admitted under the same address.
#
# hamon then reaches the site on either address: dns 10.86.0.N (OpenVPN) or
# 10.88.0.N (WireGuard), port 3671. Moving a site is a hamon.yml dns change.
#
# PROD (default greg@home.monitor-software.com): wg-central and the register.
# WG_ENDPOINT (default home.monitor-software.com:51820): what boxes dial - a
# name, so the agent can follow the server to a new address.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
PROD="${PROD:-greg@home.monitor-software.com}"
WG_ENDPOINT="${WG_ENDPOINT:-home.monitor-software.com:51820}"
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
        -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-hapi-%C" -o ControlPersist=60)

REMOVE=0
[ "${1:-}" = --remove ] && { REMOVE=1; shift; }
[ "$#" -eq 1 ] || { echo "usage: $0 [--remove] <pi-address>" >&2; exit 2; }
PI=$1
PIOPT=("${SSHOPT[@]}")
[[ $PI == 10.8[68].* ]] && [ ! -d "$HOME/pivpn/pki" ] && PIOPT+=(-J "$PROD")   # from the dev Pi: through prod
die() { echo "hapi-wg: $*" >&2; exit 1; }

. "$HERE/hapi-register.sh"

MAC=$(ssh "${PIOPT[@]}" "pivpn@$PI" cat /sys/class/net/eth0/address) ||
    die "can't log in as pivpn@$PI - built with hapi-build.sh?"
DEV="hapi-$(tr -d : <<<"$MAC" | tail -c 7)"
PW=$(reg_field "$DEV" 6)
[ -n "$PW" ] || die "$DEV isn't in the register - build it with hapi-build.sh first"
# run a command on the box as root (password on stdin, never on a command line)
pisudo() { printf '%s\n' "$PW" | ssh "${PIOPT[@]}" "pivpn@$PI" "sudo -k -S -p '' $*"; }

onprod "docker inspect -f '{{.State.Running}}' wg-central 2>/dev/null | grep -qx true" ||
    die "wg-central isn't running on prod (wg-central/)"

if [ "$REMOVE" = 1 ]; then
    onprod "docker exec wg-central wg-peer remove $DEV" || true
    pisudo "sh -c 'systemctl disable -q --now wg-quick@wg0; rm -f /etc/wireguard/wg0.conf'" ||
        echo "warning: couldn't stop wg0 on $DEV (revoked on the server anyway)"
    reg_build "$DEV" "wireguard removed" "" "$(reg_hostkey "pivpn@$PI")" "" "$(reg_field "$DEV" 7)"
    reg_push
    echo "$DEV: WireGuard removed (OpenVPN untouched); move any site using 10.88.0.x back to its 10.86.0.x address"
    exit 0
fi

# --- address: the box's OpenVPN number on 10.88 ---------------------------------
OVPN=$(reg_field "$DEV" 4)
[[ $OVPN =~ ^10\.86\.0\.([0-9]+)$ ]] ||
    OVPN=$(ssh "${PIOPT[@]}" "pivpn@$PI" "ip -o -4 addr show dev tun0 2>/dev/null | awk '{print \$4}' | cut -d/ -f1")
[[ $OVPN =~ ^10\.86\.0\.([0-9]+)$ ]] || die "$DEV has no OpenVPN address yet - hapi-assign.sh or hapi-approve.sh first"
IP=10.88.0.${BASH_REMATCH[1]}
echo "$PI: $DEV, OpenVPN $OVPN -> WireGuard $IP"

# --- the box's key ---------------------------------------------------------------
PUB=$(pisudo "sh -c 'test -s /etc/wireguard/wg0.key && wg pubkey </etc/wireguard/wg0.key'") ||
    die "$DEV has no WireGuard key - re-run ./hapi-build.sh $PI first (installs wireguard-tools, makes the key)"

# --- prod: admit it ----------------------------------------------------------------
onprod "docker exec wg-central wg-peer add $DEV $PUB $IP" >/dev/null || die "wg-peer add on prod failed"
SERVER=$(onprod "docker exec wg-central wg-peer server") || die "can't read the server key"
SKEY=$(sed -n 's/.*PublicKey=\([^ ]*\).*/\1/p' <<<"$SERVER")
[ -n "$SKEY" ] || die "no server key in: $SERVER"
SERVER_IP=$(onprod "docker exec wg-central sh -c '. /etc/wg-central/wg-central.env 2>/dev/null; echo \${WG_ADDR:-10.87.0.1/16}'" | cut -d/ -f1)
echo "prod: $DEV admitted as $IP (server $SERVER_IP, $WG_ENDPOINT)"

# --- the box: config in, link up --------------------------------------------------
# wg-quick reads the private key from the key file (PostUp), so the config
# holds nothing secret and the key is never copied
CONF="# HAMON WireGuard link to the central server (beside OpenVPN tun0), from hapi-wg.sh
[Interface]
Address = $IP/32
PostUp = wg set %i private-key /etc/wireguard/wg0.key

[Peer]
PublicKey = $SKEY
Endpoint = $WG_ENDPOINT
AllowedIPs = $SERVER_IP/32
PersistentKeepalive = 25"
{ printf '%s\n' "$PW"; printf '%s\n' "$CONF"; } |
    ssh "${PIOPT[@]}" "pivpn@$PI" "sudo -k -S -p '' sh -c 'umask 077; cat >/etc/wireguard/wg0.conf.new &&
        if cmp -s /etc/wireguard/wg0.conf.new /etc/wireguard/wg0.conf && systemctl -q is-active wg-quick@wg0; then
            rm /etc/wireguard/wg0.conf.new; echo unchanged
        else
            mv /etc/wireguard/wg0.conf.new /etc/wireguard/wg0.conf && systemctl enable -q wg-quick@wg0 &&
            systemctl restart wg-quick@wg0 && echo started
        fi'" | sed "s/^/$DEV: wg0 /" || die "installing wg0.conf on $DEV failed"

# --- wait for the handshake --------------------------------------------------------
up=0
for ((i = 0; i < 24; i++)); do
    if onprod "ping -c 1 -W 2 $IP >/dev/null"; then up=1; break; fi
    sleep 3
done
[ "$up" = 1 ] || die "$IP doesn't answer from prod after ~75 s: on the box, sudo wg show wg0; on prod, docker exec wg-central wg-peer list"
echo "$IP answers from prod"
onprod "docker exec wg-central wg-peer list" | awk -v d="$DEV" 'NR == 1 || $1 == d'

# --- what the agent sees, through the WireGuard link ---------------------------------
echo "hapi-agent on $DEV, over WireGuard:"
onprod "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new pivpn@$IP 'sudo -n hapi-agent run'" ||
    echo "  (see above: on the bench this is often 'no gateway' or several - fine until it is on site)"

# --- register --------------------------------------------------------------------------
model=$(ssh "${PIOPT[@]}" "pivpn@$PI" "tr -d '\0' </proc/device-tree/model; echo -n ', Debian '; cat /etc/debian_version")
reg_build "$DEV" "wireguard $IP" "$model" "$(reg_hostkey "pivpn@$PI")" "wg ${PUB:0:12}.." "$(reg_field "$DEV" 7)"
reg_push
echo
echo "hamon-upload / hamon.yml: dns $IP (WireGuard) or $OVPN (OpenVPN), port 3671"
