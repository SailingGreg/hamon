#!/bin/bash
#
# vpn-reconnect.sh - planned OpenVPN reconnect for Gira S1 site containers
#
# A Gira S1 renegotiates TLS 55-58 min after a connection starts, and no
# renegotiation works across Gira's relay (the S1's, or ours with reneg-sec):
# data stops until the relay resets the session ~5 min later. A soft restart
# (SIGUSR1) before then starts a fresh session instead: the tunnel is back in
# ~5 s with tun0 and its routes kept, and hamon's KNX tunnel rides through it.
#
# Run from cron every minute. For each container, the connection's age is
# read from its last "Initialization Sequence Completed" line, so an
# unplanned reconnect simply restarts the clock.
#
# usage: vpn-reconnect.sh [-n] <max-minutes> <container> ...
#   -n   dry run: say what would be done
#
# One line per reconnect (or problem) on stdout; nothing when all is well.
#

set -o nounset

DRYRUN=0
if [ "${1:-}" = "-n" ]; then DRYRUN=1; shift; fi
if [ "$#" -lt 2 ]; then
    echo "usage: $0 [-n] <max-minutes> <container> ..." >&2
    exit 2
fi
MAXMIN=$1; shift

now=$(date +%s)
for c in "$@"; do
    stamp="$(date '+%F %T')"
    # container log times are UTC (the containers run without a TZ)
    last=$(docker exec "$c" grep "Initialization Sequence Completed" /var/log/openvpn.log 2>/dev/null |
           tail -1 | cut -c1-19)
    if [ -z "$last" ]; then
        echo "$stamp $c: no completed connection in its log - left alone"
        continue
    fi
    started=$(date -u -d "$last" +%s 2>/dev/null) || {
        echo "$stamp $c: can't read the time '$last' - left alone"; continue; }
    age=$(( (now - started) / 60 ))
    [ "$age" -lt "$MAXMIN" ] && continue
    if [ "$DRYRUN" = 1 ]; then
        echo "$stamp $c: connected ${age} min (since $last UTC) - would reconnect"
        continue
    fi
    if docker exec "$c" pkill -USR1 -x openvpn; then
        echo "$stamp $c: connected ${age} min (since $last UTC) - reconnect (SIGUSR1)"
    else
        echo "$stamp $c: connected ${age} min - SIGUSR1 failed"
    fi
done
