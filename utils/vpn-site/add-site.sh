#!/bin/bash
#
# add-site.sh - set up an OpenVPN site container from the files dropped in
# ~/hamon/vpn/source
#
#   source/<site>.ovpn    the client profile (Gira S1 portal or site router
#                         export), certificates inline
#   source/<site>.creds   username on line 1, password on line 2 - only when
#                         the profile has auth-user-pass
#
# and it:
#   1. checks the profile: dev tun only; anything that runs a command, loads
#      a plugin or names a file of its own is refused; laptop settings
#      (redirect-gateway, user/group, Windows options) are commented out
#   2. splits the inline certificates and keys into vpn/<site>/ and writes
#      vpn/<site>/<site>.conf pointing at them under /vpn, with reneg-sec 0,
#      a CBC fallback when the profile names a CBC cipher, and the log lines
#      the container needs
#   3. copies the credentials to vpn/<site>/creds
#   4. allocates the container's address on the hamon network (172.18.0.N)
#      and its UDP port: the next ones free in the run scripts, ipaddrs.txt,
#      docker and ss - or keeps the site's own on a re-run with -f
#   5. writes vpn/<site>.sh from utils/vpn-site/run-site.template and records the
#      site in ipaddrs.txt and locations.txt
#
# It doesn't start anything. Next: utils/vpn-site/test-site.sh <site> (tunnel
# check, finds the KNX interface), then vpn/<site>.sh.
#
# usage: add-site.sh [-n] [-f] [-d <lan-ip>] [-k <knx-port>] [-i <ip>] [-p <port>] <site>
#   -n   dry run: show the config, the allocation and the run script, change nothing
#   -f   replace an existing vpn/<site>/ and vpn/<site>.sh (keeps the address and port)
#   -d   the KNX interface's address on the site LAN (VPN_REMOTEDEST); without
#        it the run script refuses to start until it is set
#   -k   the interface's KNXnet/IP port (default 3671)
#   -i   use this container address instead of the next free one
#   -p   use this UDP port instead of the next free one
#
# VPN_DIR in the environment overrides the vpn directory (default: the vpn/
# directory beside utils/ in this checkout).
#

set -o nounset
umask 077

HAMON="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VPN_DIR="${VPN_DIR:-$HAMON/vpn}"
TEMPLATE="$HAMON/utils/vpn-site/run-site.template"
IMAGE=openvpn-tunv2
NET_PREFIX=172.18.0.
FIRST_HOST=20      # container addresses from 172.18.0.20
FIRST_PORT=3890    # UDP ports from 3890

DRYRUN=0 FORCE=0 DEST="" DESTPORT=3671 WANT_IP="" WANT_PORT=""
while getopts ":nfd:k:i:p:" opt; do
    case "$opt" in
        n) DRYRUN=1 ;;
        f) FORCE=1 ;;
        d) DEST=$OPTARG ;;
        k) DESTPORT=$OPTARG ;;
        i) WANT_IP=$OPTARG ;;
        p) WANT_PORT=$OPTARG ;;
        *) echo "usage: $0 [-n] [-f] [-d <lan-ip>] [-k <knx-port>] [-i <ip>] [-p <port>] <site>" >&2; exit 2 ;;
    esac
done
shift $((OPTIND - 1))
if [ "$#" -ne 1 ]; then
    echo "usage: $0 [-n] [-f] [-d <lan-ip>] [-k <knx-port>] [-i <ip>] [-p <port>] <site>" >&2
    exit 2
fi
SITE=$1

die() { echo "$SITE: $*" >&2; exit 1; }
note() { echo "  $*"; }
isip() { [[ $1 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# the site name is the container name, the directory and the file names
[[ $SITE =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "site names are letters, digits, _ and - only"
OVPN="$VPN_DIR/source/$SITE.ovpn"
CREDS_SRC="$VPN_DIR/source/$SITE.creds"
SITEDIR="$VPN_DIR/$SITE"
RUNSCRIPT="$VPN_DIR/$SITE.sh"
[ -f "$OVPN" ] || die "no $OVPN"
[ -f "$TEMPLATE" ] || die "no $TEMPLATE"
[ -z "$DEST" ] || isip "$DEST" || die "-d $DEST isn't an IPv4 address"
[[ $DESTPORT =~ ^[0-9]+$ ]] || die "-k $DESTPORT isn't a port"
if [ "$FORCE" = 0 ] && { [ -e "$SITEDIR" ] || [ -e "$RUNSCRIPT" ]; }; then
    die "$SITEDIR or $RUNSCRIPT exists - -f replaces them"
fi

work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
mkdir "$work/site"

# --- 1 + 2: check, split and rebuild the profile -----------------------------
#
# awk writes the inline blocks to files, the rebuilt config to <site>.conf,
# and one line per finding to findings: "refuse <line> <why>", "drop <line>
# <directive>", or "info <key> <value>"
tr -d '\r' <"$OVPN" | awk -v out="$work/site" -v site="$SITE" '
BEGIN {
    file["ca"] = site "-ca.crt"; file["cert"] = site "-client.crt"; file["key"] = site "-client.key"
    file["tls-auth"] = site "-ta.key"; file["tls-crypt"] = site "-tc.key"; file["extra-certs"] = site "-extra.crt"
    # run a command, load code, or read/write a file of their own
    split("up down route-up route-pre-down ipchange tls-verify auth-user-pass-verify client-connect " \
          "client-disconnect learn-address script-security plugin config cd chroot writepid daemon " \
          "log log-append status management management-client-auth dev-node askpass pkcs12 secret " \
          "tls-crypt-v2 iproute tmp-dir", r, " ")
    for (i in r) refuse[r[i]] = 1
    # meant for a laptop: commented out
    split("redirect-gateway user group block-outside-dns register-dns dhcp-option route-method " \
          "route-delay ip-win32 win-sys dhcp-renew dhcp-release service", d, " ")
    for (i in d) drop[d[i]] = 1
    conf = out "/" site ".conf"
    findings = out "/../findings"
}
function finding(s) { print s > findings }
# inline blocks
inblock != "" {
    if ($0 ~ "^[ \t]*</" inblock ">") { if (!skip) close(out "/" file[inblock]); inblock = ""; skip = 0; next }
    if (!skip) print > (out "/" file[inblock])
    next
}
/^[ \t]*<[a-z-]+>[ \t]*$/ {
    tag = $0; gsub(/[ \t<>]/, "", tag)
    if (!(tag in file)) { finding("refuse " NR " inline <" tag "> block"); inblock = tag; skip = 1; next }
    inblock = tag; printf "" > (out "/" file[tag])
    print tag " /vpn/" file[tag] > conf
    finding("info block " tag)
    next
}
/^[ \t]*($|#|;)/ { print > conf; next }
{
    line = $0; sub(/^[ \t]+/, "", line)
    n = split(line, w, /[ \t]+/); k = w[1]
    if (k in refuse) { finding("refuse " NR " " k); next }
    if (k == "dev" && w[2] !~ /^tun/) { finding("refuse " NR " dev " w[2] " (the container is tun only)"); next }
    if (k == "dev-type" && w[2] != "tun") { finding("refuse " NR " dev-type " w[2]); next }
    if (k == "setenv" && w[2] == "opt") { k = "setenv opt" }
    if ((k in drop) || k == "setenv opt") { print "# " line "  (removed by add-site.sh)" > conf; finding("drop " NR " " k); next }
    if (k in file) {   # a certificate or key named by path, not inline
        finding("refuse " NR " " k " names a file - the certificates must be inline"); next
    }
    if (k == "auth-user-pass") {
        if (n > 1) { finding("refuse " NR " auth-user-pass names a file"); next }
        print "auth-user-pass /vpn/creds" > conf; finding("info creds 1"); next
    }
    if (k == "reneg-sec") { finding("info reneg " w[2]); next }   # set below
    if (k == "cipher") finding("info cipher " w[2])
    if (k == "data-ciphers") finding("info data-ciphers 1")
    if (k == "remote") finding("info remote " w[2])
    if (k == "http-proxy") finding("info proxy " w[2])
    print line > conf
}
END { if (inblock != "") finding("refuse " NR " unterminated <" inblock "> block") }
'
touch "$work/findings"

refused=$(awk '$1 == "refuse" { $1 = ""; sub(/^ /, ""); print "  line " $0 }' "$work/findings")
if [ -n "$refused" ]; then
    echo "$SITE: profile refused:" >&2
    echo "$refused" >&2
    exit 1
fi
info() { awk -v k="$1" '$1 == "info" && $2 == k { print $3; exit }' "$work/findings"; }

conf="$work/site/$SITE.conf"
grep -qE '^[[:space:]]*dev[[:space:]]+tun' "$conf" || die "the profile has no 'dev tun'"
grep -qE '^[[:space:]]*remote[[:space:]]' "$conf" || die "the profile has no 'remote'"
[ -s "$work/site/$SITE-ca.crt" ] || die "no inline <ca> in the profile"

REMOTE=$(info remote)
if [[ $(info proxy) == *securedeviceaccess.net* || $REMOTE == *securedeviceaccess.net* ]]; then
    KIND="Gira S1 via Gira's relay"
    GIRA=1
else
    KIND="site router"
    GIRA=0
fi

{
    echo
    echo "# added by add-site.sh"
    # Gira S1: no renegotiation works across the relay; router servers: the
    # S1 lesson applies, and nothing is lost by not renegotiating
    echo "reneg-sec 0"
    cipher=$(info cipher)
    if [[ $cipher == *-CBC && -z $(info data-ciphers) ]]; then
        echo "# the server names $cipher: OpenVPN 2.6 needs it listed to fall back to it"
        echo "data-ciphers AES-256-GCM:AES-128-GCM:$cipher"
        echo "data-ciphers-fallback $cipher"
    fi
    echo "# the container's log and status (read by vpn-reconnect.sh and test-site.sh)"
    echo "log /var/log/openvpn.log"
    echo "status /var/log/openvpn.stat"
} >>"$conf"

# --- 3: credentials ----------------------------------------------------------
if [ -n "$(info creds)" ]; then
    [ -f "$CREDS_SRC" ] || die "the profile has auth-user-pass: put the username and password in $CREDS_SRC (2 lines)"
    tr -d '\r' <"$CREDS_SRC" | awk NF | head -2 >"$work/site/creds"
    [ "$(grep -c . "$work/site/creds")" = 2 ] || die "$CREDS_SRC needs the username on line 1 and the password on line 2"
    CREDS="creds from source/$SITE.creds"
else
    [ -f "$CREDS_SRC" ] && note "warning: $CREDS_SRC is there but the profile doesn't ask for a password - not used"
    CREDS="no creds (certificate only)"
fi
chmod 600 "$work/site/"*

# --- 4: address and port -----------------------------------------------------
# what is in use: the run scripts (ours and the hand-made ones), ipaddrs.txt,
# the containers on the hamon network, and the UDP ports listening on the host
own_ip="" own_port=""
if [ -f "$RUNSCRIPT" ]; then
    own_ip=$(sed -n 's/^LOC_IPADDR=\([0-9.]*\).*/\1/p' "$RUNSCRIPT" | head -1)
    own_port=$(sed -n 's/^LOC_PORT=\([0-9]*\).*/\1/p' "$RUNSCRIPT" | head -1)
fi
used_ips=$( {
    cat "$VPN_DIR"/*.sh "$VPN_DIR"/*.run "$VPN_DIR/ipaddrs.txt" 2>/dev/null | grep -v '^[[:space:]]*#' |
        grep -oE "${NET_PREFIX//./\\.}[0-9]+"
    docker network inspect hamon -f '{{range .Containers}}{{.IPv4Address}} {{end}}' 2>/dev/null |
        tr ' ' '\n' | cut -d/ -f1
} | grep -vx "$own_ip" | sort -u)
used_ports=$( {
    cat "$VPN_DIR"/*.sh "$VPN_DIR"/*.run 2>/dev/null | grep -v '^[[:space:]]*#' |
        grep -oE '(LOC_PORT=|CONT_PORT=|DPORT=|-p *)[0-9]+' | grep -oE '[0-9]+$'
    grep -oE ':[0-9]+' "$VPN_DIR/ipaddrs.txt" 2>/dev/null | tr -d :
    ss -lunH 2>/dev/null | awk '{ n = split($4, a, ":"); print a[n] }'
} | grep -vx "$own_port" | sort -un)

if [ -n "$WANT_IP" ]; then
    IPADDR=$WANT_IP
    [[ $IPADDR == "$NET_PREFIX"* ]] && isip "$IPADDR" || die "-i $IPADDR isn't on the hamon network (${NET_PREFIX}N)"
    grep -qx "$IPADDR" <<<"$used_ips" && die "$IPADDR is in use"
elif [ -n "$own_ip" ]; then
    IPADDR=$own_ip
else
    for ((h = FIRST_HOST; h < 255; h++)); do
        grep -qx "$NET_PREFIX$h" <<<"$used_ips" || break
    done
    [ "$h" -lt 255 ] || die "no free address on the hamon network"
    IPADDR=$NET_PREFIX$h
fi
if [ -n "$WANT_PORT" ]; then
    PORT=$WANT_PORT
    [[ $PORT =~ ^[0-9]+$ ]] || die "-p $PORT isn't a port"
    grep -qx "$PORT" <<<"$used_ports" && die "UDP port $PORT is in use"
elif [ -n "$own_port" ]; then
    PORT=$own_port
else
    for ((PORT = FIRST_PORT; PORT < 4000; PORT++)); do
        grep -qx "$PORT" <<<"$used_ports" || break
    done
    [ "$PORT" -lt 4000 ] || die "no free UDP port below 4000"
fi

# --- 5: run script -----------------------------------------------------------
sed -e "s|@SITE@|$SITE|g" -e "s|@IPADDR@|$IPADDR|g" -e "s|@PORT@|$PORT|g" \
    -e "s|@DEST@|$DEST|g" -e "s|@DESTPORT@|$DESTPORT|g" -e "s|@IMAGE@|$IMAGE|g" \
    -e "s|@VPNDIR@|$VPN_DIR|g" -e "s|@KIND@|$KIND|g" -e "s|@DATE@|$(date '+%F %T')|g" \
    "$TEMPLATE" >"$work/run.sh"
chmod 700 "$work/run.sh"

# --- report ------------------------------------------------------------------
echo "$SITE: $KIND, $CREDS"
echo "  container $IPADDR, UDP $PORT -> KNX interface ${DEST:-(not set yet)}:$DESTPORT"
awk '$1 == "drop" { print "  commented out: " $3 " (line " $2 ")" }' "$work/findings"
if [ "$GIRA" = 0 ] && isip "${REMOTE:-x}"; then
    note "warning: remote is the raw address $REMOTE - it stops working at the site's next address change; ask for its dynamic DNS name"
fi
echo "  files: $(cd "$work/site" && ls | tr '\n' ' ')"

if [ "$DRYRUN" = 1 ]; then
    echo "--- $SITE.conf"
    cat "$conf"
    echo "--- $SITE.sh (values)"
    grep -E '^(LOCATION|LOC_IPADDR|LOC_PORT|CONT_PORT|VPN_REMOTEDEST|VPN_REMOTEPORT|IMAGE|SITEDIR)=' "$work/run.sh"
    echo "(dry run: nothing written)"
    exit 0
fi

# into place: the site directory and the run script together
if [ -e "$SITEDIR" ]; then
    bak="$SITEDIR.bak-$(date +%Y%m%d%H%M%S)"
    mv "$SITEDIR" "$bak" && note "old directory kept as $bak"
fi
if [ -e "$RUNSCRIPT" ]; then
    cp -p "$RUNSCRIPT" "$RUNSCRIPT.bak-$(date +%Y%m%d%H%M%S)"
fi
mv "$work/site" "$SITEDIR" && chmod 700 "$SITEDIR"
mv "$work/run.sh" "$RUNSCRIPT"
chmod 600 "$OVPN" "$CREDS_SRC" 2>/dev/null

# the hand-kept lists, until nothing reads them
if [ -f "$VPN_DIR/ipaddrs.txt" ] && ! grep -qE "^$IPADDR - $SITE:$PORT\$" "$VPN_DIR/ipaddrs.txt"; then
    echo "$IPADDR - $SITE:$PORT" >>"$VPN_DIR/ipaddrs.txt"
fi
if [ -f "$VPN_DIR/locations.txt" ] && ! grep -qx "$SITE" "$VPN_DIR/locations.txt"; then
    echo "$SITE" >>"$VPN_DIR/locations.txt"
fi

echo "  written: $SITEDIR/ and $RUNSCRIPT"
echo "next:"
[ -z "$DEST" ] && echo "  utils/vpn-site/test-site.sh $SITE          tunnel check + find the KNX interface, then add-site.sh -f -d <address> $SITE"
[ -n "$DEST" ] && echo "  utils/vpn-site/test-site.sh $SITE          (optional) tunnel check before the real container"
echo "  $RUNSCRIPT                        start it"
echo "  python3 utils/knxdesc.py $IPADDR:$PORT   the interface answers through the container"
echo "  hamon.yml / hamon-upload: dns: $IPADDR, port: $PORT"
if [ "$GIRA" = 1 ]; then
    echo "  Gira S1: add $SITE to the vpn-reconnect.sh cron line (planned reconnect before the S1 renegotiates)"
fi
