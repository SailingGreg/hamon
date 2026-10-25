#!/usr/bin/env bash
#
# hapi-commission.sh  -  site day for a site box: check its KNX side and map a site to it.
#
#   ./hapi-commission.sh <box> [<site>]
#
# Runs on prod or the dev Pi. The box is approved (hapi-approve.sh, usually as
# stock in the integrator's office) and has its tunnel address 10.86.0.N for
# life; on site it reconnects by itself wherever it is plugged in. This checks,
# through the VPN:
#   1. the box is on the VPN
#   2. hapi-agent: the KNX gateways it found and the one it forwards to (several
#      tunnelling gateways: the installer picks on the setup page, or
#      ssh pivpn@10.86.0.N sudo hapi-agent pin <serial>)
#   3. knxdesc through the forward: the gateway answers as hamon will see it
#   4. a KNX tunnel connect/state/disconnect, the way hamon connects
# and with a site:
#   5. records the site against the box in the register
#   6. hamon.yml: the site's dns/port are the box's address and 3671 (set them in
#      hamon-upload - in advance or now); whether hamon has connected
#
# Repeat it freely: it changes nothing on the box.
#
# PROD (default greg@home.monitor-software.com): the Pi-VPN server.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
PROD="${PROD:-greg@home.monitor-software.com}"
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
        -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-hapi-%C" -o ControlPersist=60)
PIOPT=("${SSHOPT[@]}")
die() { echo "hapi-commission: $*" >&2; exit 1; }
. "$HERE/hapi-register.sh"
[ "$ON_PROD" = 1 ] || PIOPT+=(-J "$PROD")

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "usage: $0 <box> [<site>]"
BOX=$1 SITE=${2:-}
[[ $BOX =~ ^hapi-[0-9a-f]{6}$ ]] || die "box names are hapi-xxxxxx"
[ -z "$SITE" ] || [[ $SITE =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "site names are letters, digits, _ . and - only"
IP=$(reg_field "$BOX" 4)
[ -n "$IP" ] || die "$BOX has no tunnel address in the register (approved yet? hapi-approve.sh --list)"
ok=1
say() { printf '%-28s %s\n' "$1" "$2"; }

echo "$BOX ($IP)${SITE:+ for $SITE}"
# 1. VPN
if onprod "ping -c2 -W2 $IP >/dev/null"; then say "1. VPN" "up"; else say "1. VPN" "DOWN - box not connected (power, network cable, internet at the site?)"; exit 1; fi

# 2. agent: run it now and read its view
status=$(ssh "${PIOPT[@]}" "pivpn@$IP" 'sudo -n /usr/local/sbin/hapi-agent run >/dev/null 2>&1; /usr/local/sbin/hapi-agent status' 2>/dev/null) || status=""
read -r gw_ip gw_line ngw errs < <(python3 -c '
import json, sys
try:
    s = json.loads(sys.stdin.read())
except ValueError:
    print("- - 0 no-status"); sys.exit()
g = s.get("gateway") or {}
tun = [d for d in s.get("gateways", []) if d.get("tunnelling")]
line = "%s|%s|%s|%s" % (g.get("name", ""), g.get("individual_address", ""), g.get("serial", ""), g.get("selected_by", ""))
print(g.get("ip") or "-", line.replace(" ", "_") if g else "-", len(tun), ";".join(s.get("errors", [])).replace(" ", "_") or "-")
' <<<"$status")
if [ "$gw_ip" != - ]; then
    say "2. KNX gateway" "$gw_ip  $(tr '_|' ' ,' <<<"$gw_line")  ($ngw tunnelling gateway(s) seen)"
else
    ok=0; say "2. KNX gateway" "NONE: $(tr '_' ' ' <<<"$errs")"
    [ "$ngw" -gt 1 ] && say "" "several gateways: the installer picks one on the setup page, or: ssh pivpn@$IP sudo hapi-agent pin <serial>"
fi

# 3 + 4: through the forward, as hamon sees it
if [ "$gw_ip" != - ]; then
    if d=$(onprod "python3 ~/hamon/utils/knxdesc.py $IP:3671" 2>&1) && ! grep -q NO-REPLY <<<"$d"; then
        say "3. knxdesc via the box" "$(grep -v '^$' <<<"$d" | grep -v replied | head -1 | sed "s/^$IP:3671 *//")"
    else
        ok=0; say "3. knxdesc via the box" "no reply through $IP:3671"
    fi
    if t=$(onprod "python3 ~/hamon/pivpn/pi/hapi-agent.py test $IP" 2>&1) && grep -q '"ok": true' <<<"$t"; then
        say "4. KNX tunnel test" "ok ($(python3 -c 'import json,sys; r=json.loads(sys.stdin.read()); print("%s ms, tunnel address %s" % (r.get("connect_ms"), r.get("tunnel_address")))' <<<"$t" 2>/dev/null))"
    else
        ok=0; say "4. KNX tunnel test" "FAILED: $(tr '\n' ' ' <<<"$t" | cut -c1-120) (no free tunnel slot? ETS or another client connected?)"
    fi
fi

# 5 + 6: the site
if [ -n "$SITE" ]; then
    cur=$(reg_field "$BOX" 3)
    if [ "$cur" != "$SITE" ]; then
        reg_assign "$BOX" "$SITE" "$IP" "Commissioned for $SITE $(date +%F)"
        reg_build "$BOX" "commission $SITE" "" "$(reg_hostkey "pivpn@$IP")" "$(reg_vpncert "$BOX")" "$(reg_field "$BOX" 7)"
    fi
    say "5. register" "$BOX -> $SITE"
    m=$(onprod_script "$SITE" "$IP" <<'EOF'
python3 - "$1" "$2" <<'PY'
import json, sys, yaml
site, ip = sys.argv[1], sys.argv[2]
doc = yaml.safe_load(open("/home/greg/hamon/hamon.yml"))
locs = [l for l in (doc.get("locations") or {}).values() if isinstance(l, dict) and l.get("name") == site]
if not locs:
    print("missing")
    sys.exit()
l = locs[0]
dns, port = str(l.get("dns", "")), str(l.get("port", ""))
try:
    st = json.load(open("/home/greg/hamon/tmp/site-state.json"))
    st = (st.get("sites", st).get(site) or {}).get("state", "?")
except Exception:
    st = "?"
print("ok" if (dns == ip and port == "3671") else "differs", dns, port, l.get("enabled"), st)
PY
EOF
)
    read -r res dns port enabled state <<<"$m"
    case "$res" in
        ok) say "6. hamon.yml" "dns $dns port $port (enabled: $enabled, hamon: $state)" ;;
        missing) ok=0; say "6. hamon.yml" "no location named $SITE: add it in hamon-upload with dns $IP, port 3671" ;;
        *) ok=0; say "6. hamon.yml" "$SITE has dns $dns port $port: set dns $IP, port 3671 in hamon-upload" ;;
    esac
fi

echo
[ "$ok" = 1 ] && echo "commissioning checks: OK" || echo "commissioning checks: see above"
[ "$ok" = 1 ]
