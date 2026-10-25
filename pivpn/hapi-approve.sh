#!/usr/bin/env bash
#
# hapi-approve.sh  -  accept a box from the HAMON image and adopt it, from the dev Pi.
#
#   ./hapi-approve.sh --list                 boxes waiting for approval
#   ./hapi-approve.sh [-i N] [-y] <box> <site>
#   ./hapi-approve.sh --reject <box>         drop a pending request
#   ./hapi-approve.sh --forget [-y] <box>    a new card in an enrolled box: revoke the
#                                            old one, free its address, clear the approval
#                                            (the register row and its secrets stay, so
#                                            the label stays valid)
#
# A box written from the HAMON image enrols itself at first boot: it makes its
# own VPN key (which never leaves it) and sends a certificate request to the
# enrolment endpoint on prod (hapi-enrol-server.py), where it waits as pending.
# Approving it (after checking the MAC, address and time with the installer):
#   1. on prod: sign its request as the site's VPN client (to the CA's expiry),
#      its tls-crypt-v2 key, the site's address 10.86.0.N (-i N to choose) and
#      ccd entry, and the profile the box collects on its next poll
#   2. wait for the box on the VPN (it polls every 2 minutes)
#   3. adopt it over the VPN through prod: hapi-build.sh 10.86.0.N (password,
#      setup code, register, the image's temporary sudo removed, lock-down check)
#   4. record the site in the register and make the install sheet
#
#   -y   don't ask for confirmation
#
# PROD (default greg@home.monitor-software.com): the Pi-VPN server.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
REGISTER="${REGISTER:-$HAMON/docs/hapi-devices.md}"
PROD="${PROD:-greg@home.monitor-software.com}"
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
        -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-hapi-%C" -o ControlPersist=60)
PIOPT=("${SSHOPT[@]}")
die() { echo "hapi-approve: $*" >&2; exit 1; }
. "$HERE/hapi-register.sh"

if [ "${1:-}" = --list ]; then
    ssh "${SSHOPT[@]}" "$PROD" python3 - <<'PYEOF'
import glob, json, os, time
base = os.path.expanduser("~/pivpn/enrol")
pending = sorted(glob.glob(base + "/pending/*.json"))
print("Pending (approve: hapi-approve.sh <box> <site>):")
if not pending:
    print("  none")
for p in pending:
    d = json.load(open(p))
    print("  %-12s %-17s from %-15s first %s, last %s, %s / %s" % (d["box"], d["mac"], d["addr"], d["first_seen"], d["last_seen"], d.get("model", ""), d.get("image", "")))
recent = [p for p in sorted(glob.glob(base + "/refused/*.json")) if time.time() - os.path.getmtime(p) < 7 * 86400]
if recent:
    print("Refused in the last 7 days:")
    for p in recent:
        d = json.load(open(p))
        print("  %-12s %-17s from %-15s %dx, last %s: %s" % (d["box"], d["mac"], d["addr"], d.get("count", 1), d["last_seen"], d["reason"]))
PYEOF
    exit 0
fi
if [ "${1:-}" = --reject ]; then
    [ "$#" -eq 2 ] && [[ $2 =~ ^hapi-[0-9a-f]{6}$ ]] || die "usage: $0 --reject <hapi-xxxxxx>"
    ssh "${SSHOPT[@]}" "$PROD" "rm -v ~/pivpn/enrol/pending/$2.json" || die "nothing pending for $2"
    exit 0
fi

if [ "${1:-}" = --forget ]; then
    shift
    FYES=0
    if [ "${1:-}" = -y ]; then FYES=1; shift; fi
    [ "$#" -eq 1 ] && [[ $1 =~ ^hapi-[0-9a-f]{6}$ ]] || die "usage: $0 --forget [-y] <hapi-xxxxxx>"
    BOX=$1
    done=$(ssh "${SSHOPT[@]}" "$PROD" "cat ~/pivpn/enrol/approved/$BOX.json" 2>/dev/null) || die "$BOX has no approval to forget"
    read -r fsite fip < <(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["site"], d["ip"])' <<<"$done")
    echo "$BOX: approved for $fsite ($fip). Forgetting it revokes that VPN certificate (the card now in"
    echo "the box loses its VPN), frees $fip and clears the approval, so a new card in this box can enrol."
    echo "The register row stays: the new card is adopted with the same password and setup code (label still valid)."
    if [ "$FYES" != 1 ]; then
        [ -t 0 ] || die "confirm with --forget -y when not run from a terminal"
        read -rp "Forget $BOX ($fsite)? [y/N] " ok
        [[ $ok =~ ^[Yy] ]] || die "not forgotten"
    fi
    ssh "${SSHOPT[@]}" "$PROD" bash -s -- "$BOX" "$fsite" "$fip" <<'PRODEOF'
set -eu
box=$1 site=$2 ip=$3 P=~/pivpn
days=$(( ($(date -u -d "$(openssl x509 -noout -enddate -in "$P/pki/ca.crt" | cut -d= -f2)" +%s) - $(date +%s)) / 86400 - 1 ))
E=(docker exec --user "$(id -u)" -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 -e EASYRSA_CRL_DAYS="$days" pivpn-server)
if [ -f "$P/pki/issued/$site.crt" ]; then
    "${E[@]}" /usr/share/easy-rsa/easyrsa revoke "$site" >/dev/null
    "${E[@]}" /usr/share/easy-rsa/easyrsa gen-crl >/dev/null
    echo "$site: certificate revoked (CRL to the CA's expiry)"
fi
rm -f "$P/ccd/$site" "$P/clients/$site.tc2" "$P/enrol/approved/$box.json" "$P/enrol/approved/$box.ovpn" "$P/enrol/refused/$box.json"
ssh-keygen -R "$ip" >/dev/null 2>&1 || true
echo "$box: approval cleared, $ip free"
PRODEOF
    ssh-keygen -R "$fip" >/dev/null 2>&1 || true
    reg_assign "$BOX" "" "" "Forgotten $(date +%F) (was $fsite $fip), awaiting a new card"
    reg_push
    echo "a new card in $BOX asks to enrol within 2 minutes of boot: hapi-approve.sh --list"
    exit 0
fi

WANT="" YES=0
while [ "$#" -gt 2 ]; do
    case "$1" in
        -i) WANT=$2; shift 2 ;;
        -y) YES=1; shift ;;
        *) break ;;
    esac
done
[ "$#" -eq 2 ] || die "usage: $0 [-i N] [-y] <box> <site>   (or --list, --reject <box>)"
BOX=$1 SITE=$2
[[ $BOX =~ ^hapi-[0-9a-f]{6}$ ]] || die "box names are hapi-xxxxxx"
[[ $SITE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "site names are letters, digits, _ . and - only"
[ -z "$WANT" ] || [[ $WANT =~ ^[0-9]+$ && $WANT -ge 11 && $WANT -le 254 ]] || die "-i takes N from 11 to 254"

# --- already approved (a retry after a failed adoption): straight to the adoption ---
done=$(ssh "${SSHOPT[@]}" "$PROD" "cat ~/pivpn/enrol/approved/$BOX.json" 2>/dev/null || true)
if [ -n "$done" ]; then
    read -r dsite IP < <(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["site"], d["ip"])' <<<"$done")
    [ "$dsite" = "$SITE" ] || die "$BOX was approved for $dsite, not $SITE"
    echo "$BOX: already approved for $SITE ($IP) - retrying the adoption"
    RETRY=1
fi

# --- the request ------------------------------------------------------------------
[ "${RETRY:-0}" = 1 ] || {
req=$(ssh "${SSHOPT[@]}" "$PROD" "cat ~/pivpn/enrol/pending/$BOX.json" 2>/dev/null) || die "no pending request for $BOX (./hapi-approve.sh --list)"
python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print("%s: %s, %s, image %s\n  from %s, first seen %s, last seen %s" % (d["box"], d["mac"], d.get("model",""), d.get("image",""), d["addr"], d["first_seen"], d["last_seen"]))' <<<"$req"
if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "confirm with -y when not run from a terminal"
    read -rp "Approve $BOX for site $SITE? [y/N] " ok
    [[ $ok =~ ^[Yy] ]] || die "not approved"
fi

# --- 1. prod: sign, address, ccd, profile ---------------------------------------------
IP=$(ssh "${SSHOPT[@]}" "$PROD" bash -s -- "$BOX" "$SITE" "${WANT:--}" <<'EOF'
set -eu
box=$1 site=$2 want=$3
[ "$want" != - ] || want=""
P=~/pivpn
[ -f "$P/pki/issued/$site.crt" ] && { echo "$site already has a VPN certificate - a box replacing another needs the old one revoked first" >&2; exit 1; }
used=$(cat "$P"/ccd/* 2>/dev/null | awk '/^ifconfig-push/ {print $2}')
if [ -n "$want" ]; then
    n=$want; grep -qx "10.86.0.$n" <<<"$used" && { echo "10.86.0.$n is in use" >&2; exit 1; }
else
    for ((n = 11; n < 200; n++)); do grep -qx "10.86.0.$n" <<<"$used" || break; done
    [ "$n" -lt 200 ] || { echo "no free site address below 10.86.0.200" >&2; exit 1; }
fi
ip=10.86.0.$n
days=$(( ($(date -u -d "$(openssl x509 -noout -enddate -in "$P/pki/ca.crt" | cut -d= -f2)" +%s) - $(date +%s)) / 86400 - 1 ))
[ "$days" -le 3650 ] || days=3650
umask 077
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["csr"])' "$P/enrol/pending/$box.json" >"$P/enrol/$box.csr"
E=(docker exec --user "$(id -u)" -e EASYRSA_PKI=/etc/pivpn/pki -e EASYRSA_BATCH=1 -e EASYRSA_CERT_EXPIRE="$days" pivpn-server)
"${E[@]}" /usr/share/easy-rsa/easyrsa import-req "/etc/pivpn/enrol/$box.csr" "$site" >/dev/null
"${E[@]}" /usr/share/easy-rsa/easyrsa --new-subject="/CN=$site" sign-req client "$site" newsubj >/dev/null
rm -f "$P/enrol/$box.csr"
docker exec --user "$(id -u)" pivpn-server sh -c "cd /etc/pivpn && [ -f clients/$site.tc2 ] || openvpn --tls-crypt-v2 tc2-server.key --genkey tls-crypt-v2-client clients/$site.tc2"
printf 'ifconfig-push %s 255.255.0.0\niroute 10.100.%s.0 255.255.255.0\n' "$ip" "$n" >"$P/ccd/$site"
# the profile without a key: the box adds its own (key line written by hapi-enrol)
{
  printf '%s\n' client "dev tun" "proto udp" "remote $(cat "$P/public-host") 1194" "resolv-retry infinite" nobind \
      persist-key persist-tun "remote-cert-tls server" "tls-version-min 1.2" \
      "data-ciphers CHACHA20-POLY1305:AES-256-GCM:AES-128-GCM" "keepalive 10 60" "verb 3"
  echo "<ca>"; cat "$P/pki/ca.crt"; echo "</ca>"
  echo "<cert>"; sed -n '/BEGIN CERTIFICATE/,/END CERTIFICATE/p' "$P/pki/issued/$site.crt"; echo "</cert>"
  echo "<tls-crypt-v2>"; cat "$P/clients/$site.tc2"; echo "</tls-crypt-v2>"
} >"$P/enrol/approved/$box.ovpn.tmp"
python3 -c '
import json, sys, time
d = json.load(open(sys.argv[1]))
json.dump({"box": d["box"], "mac": d["mac"], "site": sys.argv[2], "ip": sys.argv[3],
           "secret_sha256": d["secret_sha256"], "approved": time.strftime("%F %T")}, open(sys.argv[4], "w"), indent=1)
' "$P/enrol/pending/$box.json" "$site" "$ip" "$P/enrol/approved/$box.json"
mv "$P/enrol/approved/$box.ovpn.tmp" "$P/enrol/approved/$box.ovpn"
rm -f "$P/enrol/pending/$box.json"
echo "$ip"
EOF
) || die "approving on prod failed"
echo "$SITE: certificate signed for $BOX, tunnel address $IP; waiting for the box to collect it (it asks every 2 minutes)"
}

# --- 2. wait for it on the VPN -------------------------------------------------------
since=$(date -u +%s)
for ((i = 0; i < 72; i++)); do
    sleep 5
    if ssh "${SSHOPT[@]}" "$PROD" "ping -c1 -W2 $IP >/dev/null"; then up=1; break; fi
done
[ "${up:-0}" = 1 ] || die "$BOX not on the VPN after 6 min: approval stands; check the box (on site: is it on the network?) and run this again with the same box and site to retry the adoption"
echo "$BOX: on the VPN after ~$(( $(date -u +%s) - since )) s"

# --- 3. adopt over the VPN ------------------------------------------------------------
# a box reusing an address has new host keys: here, and on prod (hapi-collect)
ssh-keygen -R "$IP" >/dev/null 2>&1 || true
ssh "${SSHOPT[@]}" "$PROD" "ssh-keygen -R $IP" >/dev/null 2>&1 || true
"$HERE/hapi-build.sh" "$IP"

# --- 4. register -------------------------------------------------------------------
reg_assign "$BOX" "$SITE" "$IP" "Enrolled + approved for $SITE $(date +%F)"
PIOPT=("${SSHOPT[@]}" -J "$PROD")
model=$(ssh "${PIOPT[@]}" "pivpn@$IP" "tr -d '\0' </proc/device-tree/model; echo -n ', Debian '; cat /etc/debian_version; echo -n ', '; sed -n 's/^image=//p' /etc/hapi/image")
reg_build "$BOX" "approve $SITE $IP" "$model" "$(reg_hostkey "pivpn@$IP")" "$(reg_vpncert "$SITE")" "$(reg_field "$BOX" 7)"
reg_push
"$HERE/hapi-sheet.sh" "$BOX" >/dev/null && echo "install sheet: docs/labels/$BOX-install.pdf (send it to the installer)"
echo
echo "hamon-upload / hamon.yml for $SITE: dns $IP, port 3671"
