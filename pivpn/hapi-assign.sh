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
#   -r       renew the site's certificate (to the CA's expiry, at most 10
#            years); the old one is revoked once the Pi has connected with
#            the new one
#
# PROD (default greg@home.monitor-software.com): the Pi-VPN server.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
REGISTER="${REGISTER:-$HAMON/docs/hapi-devices.md}"
PROD="${PROD:-greg@home.monitor-software.com}"
# one shared connection per host for the whole run (ControlMaster): these
# scripts make many short ssh calls, and a burst of new connections can be dropped
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
        -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-hapi-%C" -o ControlPersist=60)

WANT="" RENEW=0
while [ "$#" -gt 2 ]; do
    case "$1" in
        -i) WANT=$2; shift 2 ;;
        -r) RENEW=1; shift ;;
        *) break ;;
    esac
done
[ "$#" -eq 2 ] || { echo "usage: $0 [-i <N>] [-r] <pi-address> <site>" >&2; exit 2; }
PI=$1 SITE=$2
# a tunnel address (10.86.0.N): through prod as the ssh jump host
PIOPT=("${SSHOPT[@]}")
[[ $PI == 10.86.* ]] && PIOPT+=(-J "$PROD")
die() { echo "hapi-assign: $*" >&2; exit 1; }
[[ $SITE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "site names are letters, digits, _ . and - only"
[ -z "$WANT" ] || [[ $WANT =~ ^[0-9]+$ && $WANT -ge 11 && $WANT -le 254 ]] || die "-i takes N from 11 to 254"

. "$HERE/hapi-register.sh"

MAC=$(ssh "${PIOPT[@]}" "pivpn@$PI" cat /sys/class/net/eth0/address) ||
    die "can't log in as pivpn@$PI - built with hapi-build.sh?"
DEV="hapi-$(tr -d : <<<"$MAC" | tail -c 7)"
PW=$(reg_field "$DEV" 6)
[ -n "$PW" ] || die "$DEV isn't in $REGISTER - build it with hapi-build.sh first"
echo "$PI: $DEV"

# --- prod: address and profile -----------------------------------------------
# ssh joins the arguments into one command line, so an empty one would vanish: "-" = none
IP=$(ssh "${SSHOPT[@]}" "$PROD" bash -s -- "$SITE" "${WANT:--}" "$RENEW" <<'EOF'
set -eu
site=$1 want=$2 renew=$3
[ "$want" != - ] || want=""
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
# to the CA's expiry, at most 10 years (pivpn-add does the same from the
# next image build on; set here for an older image)
days=$(( ($(date -u -d "$(openssl x509 -noout -enddate -in ~/pivpn/pki/ca.crt | cut -d= -f2)" +%s) - $(date +%s)) / 86400 - 1 ))
[ "$days" -le 3650 ] || days=3650
if [ "$renew" = 1 ]; then
    [ -f ~/pivpn/pki/issued/"$site".crt ] || { echo "$site has no certificate to renew" >&2; exit 1; }
    docker exec --user "$(id -u)" -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 -e EASYRSA_CERT_EXPIRE="$days" \
        pivpn-server /usr/share/easy-rsa/easyrsa renew "$site" >&2
fi
docker exec --user "$(id -u)" -e EASYRSA_CERT_EXPIRE="$days" pivpn-server pivpn-add "$site" "$ip" "10.100.${ip##*.}.0" >&2
echo "$ip"
EOF
) || die "pivpn-add on prod failed"
echo "$SITE: tunnel address $IP"

# --- the Pi: profile in, VPN on ----------------------------------------------
# hapi-vpn-swap (installed by hapi-build) applies it detached and goes back
# to the previous profile if the new one doesn't connect in 2 min - the ssh
# session (on site: through this very tunnel) may drop with the restart. A Pi
# built before the switcher gets a plain restart.
since=$(ssh "${SSHOPT[@]}" "$PROD" date -u +%Y-%m-%dT%H:%M:%SZ)
{ printf '%s\n' "$PW"; ssh "${SSHOPT[@]}" "$PROD" cat "pivpn/clients/$SITE.ovpn"; } |
    ssh "${PIOPT[@]}" "pivpn@$PI" "sudo -k -S -p '' sh -c 'umask 077; cat >/etc/openvpn/client/pivpn.conf.new &&
        [ \"\$(head -1 /etc/openvpn/client/pivpn.conf.new)\" = client ] && systemctl enable -q openvpn-client@pivpn &&
        if [ -x /usr/local/sbin/hapi-vpn-swap ]; then
            rm -f /run/hapi/vpn-swap; systemd-run --quiet --collect --unit=hapi-vpn-swap /usr/local/sbin/hapi-vpn-swap
        else
            mv /etc/openvpn/client/pivpn.conf.new /etc/openvpn/client/pivpn.conf && systemctl restart openvpn-client@pivpn
        fi'" || die "installing the profile on the Pi failed"
swap=$(ssh "${PIOPT[@]}" "pivpn@$PI" 'test -x /usr/local/sbin/hapi-vpn-swap && echo yes' 2>/dev/null || true)
echo "$DEV: profile installed, VPN restarting${swap:+ (falls back to the previous profile if it does not connect)}"

# --- wait for it -----------------------------------------------------------------
up=0
if [ "$swap" = yes ]; then
    # the Pi says how it went: up, or restored (the old profile is back)
    for ((i = 0; i < 60; i++)); do
        sleep 5
        st=$(ssh "${PIOPT[@]}" "pivpn@$PI" 'cat /run/hapi/vpn-swap 2>/dev/null' 2>/dev/null || true)
        case "$st" in
            up) up=1; break ;;
            restored) die "the new profile didn't connect: the Pi went back to its previous profile and is up (old certificate kept)" ;;
            restored-down|failed) die "the new profile didn't connect and the Pi is not up again ($st): on the Pi, journalctl -t hapi-vpn-swap" ;;
        esac
    done
else
    # the server's log since the install shows the Pi's new connection (the
    # status file can still list the old one for up to 60 s)
    for ((i = 0; i < 24; i++)); do
        sleep 5
        if ssh "${SSHOPT[@]}" "$PROD" "docker logs --since $since pivpn-server 2>&1" |
                grep -q "\[$SITE\] Peer Connection Initiated"; then
            up=1; break
        fi
    done
fi
[ "$up" = 1 ] || die "$SITE not up on the new profile after $(( (i + 1) * 5 )) s: on the Pi, journalctl -u openvpn-client@pivpn"
echo "$SITE: up on the new profile after ~$(( (i + 1) * 5 )) s"
ssh "${SSHOPT[@]}" "$PROD" "ping -c 3 -W 2 $IP >/dev/null" && echo "$IP answers from prod" ||
    echo "warning: $IP doesn't answer ping from prod yet"

# --- renewed: the old certificate goes once the Pi is on the new one -----------------
if [ "$RENEW" = 1 ]; then
    # the CRL runs to the CA's expiry like everything else: easy-rsa's default
    # is 180 days, and an expired CRL makes the server refuse every client
    ssh "${SSHOPT[@]}" "$PROD" 'days=$(( ($(date -u -d "$(openssl x509 -noout -enddate -in ~/pivpn/pki/ca.crt | cut -d= -f2)" +%s) - $(date +%s)) / 86400 - 1 ))
        docker exec --user $(id -u) -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 -e EASYRSA_CRL_DAYS=$days pivpn-server sh -c "/usr/share/easy-rsa/easyrsa revoke-renewed '"$SITE"' && /usr/share/easy-rsa/easyrsa gen-crl"' >/dev/null &&
        echo "$SITE: old certificate revoked (CRL updated)" ||
        echo "warning: revoking the old $SITE certificate failed - easyrsa revoke-renewed $SITE + gen-crl by hand"
fi

# --- what the agent sees, through the tunnel (as hapi-collect will) ------------------
echo "hapi-agent on $DEV, over the VPN:"
ssh "${SSHOPT[@]}" "$PROD" "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new pivpn@$IP 'sudo -n hapi-agent run'" ||
    echo "  (see above: on the bench this is often 'no gateway' or several - fine until it is on site)"

# --- register --------------------------------------------------------------------
if [ -f "$REGISTER" ]; then
    reg_assign "$DEV" "$SITE" "$IP" "Assigned to $SITE $(date +%F)"
    model=$(ssh "${PIOPT[@]}" "pivpn@$PI" "tr -d '\0' </proc/device-tree/model; echo -n ', Debian '; cat /etc/debian_version")
    reg_build "$DEV" "assign $SITE $IP" "$model" "$(reg_hostkey "pivpn@$PI")" "$(reg_vpncert "$SITE")" "$(reg_field "$DEV" 7)"
    reg_push
fi
echo
echo "hamon-upload / hamon.yml for $SITE: dns $IP, port 3671"
echo "before it leaves the bench: ./hapi-build.sh --ship $PI"
