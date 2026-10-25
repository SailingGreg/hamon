#!/usr/bin/env bash
#
# hapi-benchtest.sh  -  prove a site Pi's whole KNX path on the bench, from the dev Pi.
#
#   ./hapi-benchtest.sh <pi-address>
#
# Needs the Pi built and assigned (hapi-build.sh, hapi-assign.sh) and on the
# same LAN as this machine. It:
#   1. runs pi/fake-gateway.py here: a KNXnet/IP gateway that answers search,
#      description and tunnel connect/state/disconnect (no telegrams)
#   2. has the Pi's hapi-agent find it and point the forward at it
#      (tun0:3671 -> this machine:3671)
#   3. from prod, connects a KNX tunnel to the Pi's tunnel address, state
#      request, disconnect - exactly the way hamon connects (pi/hapi-agent.py
#      test 10.86.0.N)
#   4. stops the fake gateway
#
# The Pi keeps the forward to this machine until it sees a real gateway
# (on site) - ./hapi-build.sh --ship clears it before it leaves the bench.
#
# PROD (default greg@home.monitor-software.com): the Pi-VPN server, with this
# repository checked out at ~/hamon.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
PROD="${PROD:-greg@home.monitor-software.com}"
# one shared connection per host for the whole run (ControlMaster): these
# scripts make many short ssh calls, and a burst of new connections can be dropped
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
        -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-hapi-%C" -o ControlPersist=60)

[ "$#" -eq 1 ] || { echo "usage: $0 <pi-address>" >&2; exit 2; }
PI=$1
# a tunnel address (10.86.0.N): through prod as the ssh jump host
PIOPT=("${SSHOPT[@]}")
[[ $PI == 10.86.* ]] && [ ! -d "$HOME/pivpn/pki" ] && PIOPT+=(-J "$PROD")   # from the dev Pi: through prod
die() { echo "hapi-benchtest: $*" >&2; exit 1; }
. "$HERE/hapi-register.sh"

MAC=$(ssh "${PIOPT[@]}" "pivpn@$PI" cat /sys/class/net/eth0/address) || die "can't log in as pivpn@$PI"
DEV="hapi-$(tr -d : <<<"$MAC" | tail -c 7)"
IP=$(reg_field "$DEV" 4)
[ -n "$IP" ] || die "$DEV has no tunnel address in the register - hapi-assign.sh first"
ss -lun | grep -q ':3671 ' && die "UDP 3671 is in use here - the fake gateway needs it"
echo "$DEV ($PI), tunnel address $IP"

log=$(mktemp)
python3 -u "$HERE/pi/fake-gateway.py" --name "hapi bench gateway" >"$log" 2>&1 &
fake=$!
trap 'kill $fake 2>/dev/null; rm -f "$log"' EXIT
sleep 1
kill -0 "$fake" 2>/dev/null || { cat "$log" >&2; die "the fake gateway didn't start"; }
echo "1. fake gateway running here"

echo "2. hapi-agent on the Pi:"
ssh "${PIOPT[@]}" "pivpn@$PI" 'sudo -n /usr/local/sbin/hapi-agent run' | sed 's/^/   /' || true
fwd=$(ssh "${PIOPT[@]}" "pivpn@$PI" '/usr/local/sbin/hapi-agent status' |
      python3 -c 'import json,sys; s=json.load(sys.stdin); g=s.get("gateway") or {}; print(g.get("ip",""), g.get("name",""))')
echo "   forward -> $fwd"
grep -q "hapi bench gateway" <<<"$fwd" || die "the agent didn't choose the fake gateway (another gateway on the LAN? hapi-agent discover)"

echo "3. KNX tunnel from prod to $IP:3671, as hamon connects:"
if onprod "python3 hamon/pivpn/pi/hapi-agent.py test $IP" | sed 's/^/   /'; then
    result=PASS
else
    result=FAIL
fi
echo "4. fake gateway saw:"
sed 's/^/   /' "$log"
echo
echo "bench test: $result (prod -> VPN -> $DEV -> gateway)"
[ "$result" = PASS ]
