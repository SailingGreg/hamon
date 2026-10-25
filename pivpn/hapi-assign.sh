#!/usr/bin/env bash
#
# hapi-assign.sh  -  give a built site Pi (hapi-build.sh) its site, from the dev Pi.
#
#   ./hapi-assign.sh [-i <N>] <pi-address> <site>
#
# On prod: the site's fixed tunnel address 10.86.0.N (its existing one, or the
# lowest free from .11; .200 and up are bench/test) and pivpn-add (client
# certificate, tls-crypt-v2 key, ccd/<site>, clients/<site>.ovpn). The .ovpn
# goes straight from prod to the Pi over ssh - it is the Pi's identity and is
# never stored here. Then it starts the VPN, waits for the Pi on the server,
# asks hapi-agent through the tunnel what it sees, records the site in the
# device register and copies the register to prod (~/pivpn/hapi-devices.md).
#
# Re-running it (a new profile, the same site) keeps the address. The site
# name is the VPN client name; use the hamon.yml name.
#
#   -i <N>   use 10.86.0.N instead of the next free address
#
# PROD (default greg@home.monitor-software.com): the Pi-VPN server.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
REGISTER="${REGISTER:-$HAMON/docs/hapi-devices.md}"
PROD="${PROD:-greg@home.monitor-software.com}"
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

WANT=""
if [ "${1:-}" = -i ]; then WANT=$2; shift 2; fi
[ "$#" -eq 2 ] || { echo "usage: $0 [-i <N>] <pi-address> <site>" >&2; exit 2; }
PI=$1 SITE=$2
die() { echo "hapi-assign: $*" >&2; exit 1; }
[[ $SITE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "site names are letters, digits, _ . and - only"
[ -z "$WANT" ] || [[ $WANT =~ ^[0-9]+$ && $WANT -ge 11 && $WANT -le 254 ]] || die "-i takes N from 11 to 254"

reg_field() {
    [ -f "$REGISTER" ] || return 0
    awk -F'|' -v d="$1" -v n="$2" '$2 ~ "^ *" d " *$" { f = $(n + 1); gsub(/[ `]/, "", f); print f; exit }' "$REGISTER"
}

MAC=$(ssh "${SSHOPT[@]}" "pivpn@$PI" cat /sys/class/net/eth0/address) ||
    die "can't log in as pivpn@$PI - built with hapi-build.sh?"
DEV="hapi-$(tr -d : <<<"$MAC" | tail -c 7)"
PW=$(reg_field "$DEV" 6)
[ -n "$PW" ] || die "$DEV isn't in $REGISTER - build it with hapi-build.sh first"
echo "$PI: $DEV"

# --- prod: address and profile -----------------------------------------------
IP=$(ssh "${SSHOPT[@]}" "$PROD" bash -s -- "$SITE" "$WANT" <<'EOF'
set -eu
site=$1 want=$2
ccd=~/pivpn/ccd
if [ -f "$ccd/$site" ]; then
    ip=$(awk '/^ifconfig-push/ {print $2}' "$ccd/$site")
    [ -z "$want" ] || [ "$ip" = "10.86.0.$want" ] || { echo "$site already has $ip" >&2; exit 1; }
else
    used=$(cat "$ccd"/* 2>/dev/null | awk '/^ifconfig-push/ {print $2}')
    if [ -n "$want" ]; then
        n=$want
        grep -qx "10.86.0.$n" <<<"$used" && { echo "10.86.0.$n is in use" >&2; exit 1; }
    else
        for ((n = 11; n < 200; n++)); do grep -qx "10.86.0.$n" <<<"$used" || break; done
        [ "$n" -lt 200 ] || { echo "no free site address below 10.86.0.200" >&2; exit 1; }
    fi
    ip=10.86.0.$n
fi
docker exec --user "$(id -u)" pivpn-server pivpn-add "$site" "$ip" "10.100.${ip##*.}.0" >&2
echo "$ip"
EOF
) || die "pivpn-add on prod failed"
echo "$SITE: tunnel address $IP"

# --- the Pi: profile in, VPN on ----------------------------------------------
{ printf '%s\n' "$PW"; ssh "${SSHOPT[@]}" "$PROD" cat "pivpn/clients/$SITE.ovpn"; } |
    ssh "${SSHOPT[@]}" "pivpn@$PI" "sudo -S -p '' sh -c 'umask 077; cat >/etc/openvpn/client/pivpn.conf.new &&
        [ -s /etc/openvpn/client/pivpn.conf.new ] && mv /etc/openvpn/client/pivpn.conf.new /etc/openvpn/client/pivpn.conf &&
        systemctl enable -q openvpn-client@pivpn && systemctl restart openvpn-client@pivpn'" ||
    die "installing the profile on the Pi failed"
echo "$DEV: profile installed, VPN starting"

# --- wait for it on the server ---------------------------------------------------
for ((i = 0; i < 24; i++)); do
    sleep 5
    if ssh "${SSHOPT[@]}" "$PROD" "docker exec pivpn-server cat /tmp/pivpn-status.log" 2>/dev/null |
            grep -qE "^(CLIENT_LIST,)?$SITE,"; then
        up=1; break
    fi
done
[ "${up:-0}" = 1 ] || die "$SITE not connected to the Pi-VPN server after 2 min: on the Pi, journalctl -u openvpn-client@pivpn"
echo "$SITE: connected to the Pi-VPN server after ~$(((i + 1) * 5)) s"
# the status log is refreshed every 60 s: ping to be sure it's this connection
ssh "${SSHOPT[@]}" "$PROD" "ping -c 3 -W 2 $IP >/dev/null" && echo "$IP answers from prod" ||
    echo "warning: $IP doesn't answer ping from prod yet (the status log lags up to 60 s)"

# --- what the agent sees, through the tunnel (as hapi-collect will) ------------------
echo "hapi-agent on $DEV, over the VPN:"
ssh "${SSHOPT[@]}" "$PROD" "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new pivpn@$IP 'sudo -n hapi-agent run'" ||
    echo "  (see above: on the bench this is often 'no gateway' or several - fine until it is on site)"

# --- register --------------------------------------------------------------------
if [ -f "$REGISTER" ]; then
    awk -F'|' -v OFS='|' -v d="$DEV" -v s=" $SITE " -v ip=" $IP " -v st="Assigned to $SITE $(date +%F)" '
        $2 ~ "^ *" d " *$" { $4 = s; $5 = ip
                             sub(/^ *Assigned to [^;]*; */, "", $9); sub(/; not assigned to a site yet/, "", $9); sub(/ +$/, "", $9)
                             $9 = " " st "; " $9 " " }
        { print }' "$REGISTER" >"$REGISTER.tmp" && cat "$REGISTER.tmp" >"$REGISTER" && rm -f "$REGISTER.tmp"
    chmod 600 "$REGISTER"
    scp -q "${SSHOPT[@]}" "$REGISTER" "$PROD:pivpn/hapi-devices.md" &&
        ssh "${SSHOPT[@]}" "$PROD" chmod 600 pivpn/hapi-devices.md &&
        echo "register updated here and copied to prod"
fi

echo
echo "hamon-upload / hamon.yml for $SITE: dns $IP, port 3671"
echo "before it leaves the bench: ./hapi-build.sh --ship $PI"
