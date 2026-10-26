#!/bin/bash
#
# vpn-reconnect.sh - planned OpenVPN reconnect for Gira S1 site containers
#
# A Gira S1 renegotiates TLS 55-58 min after a connection starts, and no
# renegotiation works across Gira's relay (the S1's, or ours with reneg-sec):
# data stops until the relay resets the session ~5 min later. A soft restart
# (SIGUSR1) before then starts a fresh session instead: the tunnel is back in
# ~5 s with tun0 and its routes kept, and hamon's KNX tunnel usually rides
# through it. When a telegram arrives while the VPN is down, though, the S1
# gets no TUNNELLING_ACK and, as ISO 22510 5.4.2.6 requires, repeats it once
# and closes the KNX connection - its DISCONNECT_REQUEST is lost with the VPN,
# so hamon only finds out from its next heartbeat (up to 60 s later, answered
# E_CONNECTION_ID). So once the tunnel is back, the script asks hamon (kpipe
# "check <site>") to send that heartbeat at once.
#
# Run from cron every minute. For each container, the connection's age is
# read from its last "Initialization Sequence Completed" line, so an
# unplanned reconnect simply restarts the clock.
#
# usage: vpn-reconnect.sh [-n] <max-minutes> <container>[:<site>] ...
#   -n   dry run: say what would be done
#   <site> is the hamon.yml site name, if it isn't the container's
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

KPIPE="$(cd "$(dirname "$0")/.." && pwd)/tmp/kpipe"
UP_WAIT=30   # seconds to wait for the tunnel to come back

now=$(date +%s)
for arg in "$@"; do
    c=${arg%%:*}
    site=${arg#*:}
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
    before=$(docker exec "$c" grep -c "Initialization Sequence Completed" /var/log/openvpn.log)
    if ! docker exec "$c" pkill -USR1 -x openvpn; then
        echo "$stamp $c: connected ${age} min - SIGUSR1 failed"
        continue
    fi
    echo "$stamp $c: connected ${age} min (since $last UTC) - reconnect (SIGUSR1)"
    for ((i = 0; i < UP_WAIT; i++)); do
        sleep 1
        n=$(docker exec "$c" grep -c "Initialization Sequence Completed" /var/log/openvpn.log)
        [ "$n" -gt "$before" ] && break
    done
    if [ "$n" -le "$before" ]; then
        echo "$(date '+%F %T') $c: tunnel not back after ${UP_WAIT} s - no hamon check"
    elif [ ! -p "$KPIPE" ]; then
        echo "$(date '+%F %T') $c: tunnel back after $((i + 1)) s; no $KPIPE - is ha-mon running?"
    elif ! timeout 5 sh -c 'echo "check $1" > "$2"' _ "$site" "$KPIPE"; then
        # a FIFO write blocks with no reader (ha-mon stopping or restarting)
        echo "$(date '+%F %T') $c: tunnel back after $((i + 1)) s; kpipe not read - no hamon check"
    else
        echo "$(date '+%F %T') $c: tunnel back after $((i + 1)) s - asked hamon to check $site"
    fi
done
