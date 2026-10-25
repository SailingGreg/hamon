#!/usr/bin/env bash
#
# hapi-vpn-swap  -  switch the Pi-VPN client to a new profile, safely.
#
# pivpn/hapi-assign.sh writes the new profile to
# /etc/openvpn/client/pivpn.conf.new and starts this detached
# (systemd-run), so it carries on when the ssh session that started it - often
# through the tunnel itself - drops with the restart. It installs the new
# profile and restarts the VPN; if the tunnel isn't up with it within
# WAIT seconds (default 120), it puts the previous profile back and restarts
# again, so a bad profile or certificate can't cut a Pi on site off.
#
# Result in the journal (journalctl -t hapi-vpn-swap) and, readable without
# root, in /run/hapi/vpn-swap: "running", then "up", "restored", "restored-down"
# or "failed" (hapi-assign.sh polls it).
#

set -uo pipefail

DIR=/etc/openvpn/client
NEW=$DIR/pivpn.conf.new CUR=$DIR/pivpn.conf PREV=$DIR/pivpn.conf.prev
UNIT=openvpn-client@pivpn
WAIT=${WAIT:-120}
STATUS=/run/hapi/vpn-swap
say() { logger -t hapi-vpn-swap "$*"; echo "$*"; }
state() { mkdir -p /run/hapi; echo "$1" >"$STATUS"; chmod 644 "$STATUS"; }

[ "$(head -1 "$NEW" 2>/dev/null)" = client ] || { say "no valid $NEW - nothing done"; state failed; exit 1; }
state running

# up = "Initialization Sequence Completed" from this unit since the restart
started() {
    local since i
    since=$(date '+%Y-%m-%d %H:%M:%S')
    systemctl restart "$UNIT"
    for ((i = 0; i < WAIT; i += 2)); do
        sleep 2
        journalctl -u "$UNIT" --since "$since" -q --no-pager 2>/dev/null |
            grep -q "Initialization Sequence Completed" && return 0
    done
    return 1
}

[ -f "$CUR" ] && cp -p "$CUR" "$PREV"
mv "$NEW" "$CUR"
if started; then
    say "new VPN profile up"
    state up
    rm -f "$PREV"
    exit 0
fi
if [ -f "$PREV" ]; then
    mv "$PREV" "$CUR"
    if started; then
        say "new VPN profile did not connect within ${WAIT} s - previous profile restored and up"
        state restored
    else
        say "new VPN profile did not connect within ${WAIT} s - previous profile restored, but it is not up either"
        state restored-down
    fi
else
    say "new VPN profile did not connect within ${WAIT} s - no previous profile to go back to"
    state failed
fi
exit 1
