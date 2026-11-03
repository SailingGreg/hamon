#!/bin/bash
#
# l2tp-watch.sh - drop log and point-of-failure capture for L2TP VPN sites
#
# The L2TP sites lose their KNX path every few days while the PPP session and
# IPsec stay up, until the freshness detector restarts the container ~10 min
# later. Nothing records what was dead at the time, so this follows hamon's
# combined.log and for each site in an L2TP container (one with a ppp0):
#
#   drops.log      one line per drop when it ends: site, start, end, seconds,
#                  kind (blip = "Invalid Connection ID", outage = "Connection
#                  dead", stall = no events for STALL s with no error logged,
#                  as in the old kapacitor deadman case; stall-dead = hamon
#                  said "Connection dead" later) and what ended it (self, detector = the container
#                  was restarted meanwhile, hamon = ha-mon restarted)
#   capture-DATE   on "Connection dead" or a stall: the container's state (ppp0, IPsec SA
#                  ages, processes, DNAT counters and ppp0 traffic 5 s apart,
#                  conntrack count, pings to the PPP peer and the gateway, a
#                  KNX DESCRIPTION through the DNAT as hamon sees it, the ppp
#                  log tail); again 3 min later if the site is still down.
#                  Once per container per 2 min (sites sharing one are one
#                  capture)
#
# Read-only: it never restarts anything. Logs go to alerts/l2tp-watch/.
# Runs as a service (l2tp-watch.service). One line per event on stdout.
#

set -o nounset

DIR="$(cd "$(dirname "$0")/.." && pwd)"
YML="$DIR/hamon.yml"
CLOG="${CLOG:-$DIR/src/combined.log}"
OUT="${OUT:-$DIR/alerts/l2tp-watch}"
STALL=${STALL:-300}      # seconds without events from a connected site = a stall
RECAPTURE=${RECAPTURE:-180}  # seconds after a capture to capture again if still down
QUIET=120       # seconds between captures of one container

mkdir -p "$OUT"
log() { echo "$(date '+%F %T') $*"; }

# site -> dns: (the container address) for enabled sites
dns_of() {
    awk -v s="$1" '/^ +name:/ {n = $2; gsub(/"/, "", n)} /^ +enabled:/ {e = $2}
                   /^ +dns:/ {if (n == s && e == "true") {print $2; exit}}' "$YML" | tr -d '"'
}

# the running container with this address, if it has a ppp0
l2tp_container() {
    local ip=$1 c
    for c in $(docker ps --format '{{.Names}}'); do
        [ "$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$c" 2>/dev/null)" = "$ip" ] || continue
        docker exec "$c" test -e /sys/class/net/ppp0 2>/dev/null && echo "$c"
        return
    done
}

# when the container last (re)started, epoch seconds
started_at() {
    date -d "$(docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null)" +%s 2>/dev/null || echo 0
}

capture() {
    local c=$1 why=$2 f ip port gw peer
    f="$OUT/capture-$(date +%F).log"
    ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$c")
    {
        echo "===== $(date '+%F %T') $c: $why"
        docker exec "$c" sh -c '
            echo "--- addresses";   ip -br addr
            echo "--- routes";      ip route
            echo "--- processes";   ps -eo pid,etime,args | grep -E "[x]l2tpd|[p]ppd|[c]haron"
            echo "--- ipsec";       ipsec status
            echo "--- conntrack";   cat /proc/sys/net/netfilter/nf_conntrack_count
            echo "--- dnat + ppp0 counters, 5 s apart"
            iptables -t nat -L PREROUTING -v -n -x 2>/dev/null | grep DNAT
            ip -s link show ppp0 | sed -n "3,6p"
            sleep 5
            iptables -t nat -L PREROUTING -v -n -x 2>/dev/null | grep DNAT
            ip -s link show ppp0 | sed -n "3,6p"' 2>&1
        peer=$(docker exec "$c" ip -4 addr show ppp0 2>/dev/null | awk '/peer/ {sub(/\/.*/, "", $4); print $4}')
        gw=$(docker exec "$c" iptables -t nat -S 2>/dev/null | awk '/DNAT/ {for (i = 1; i <= NF; i++) if ($i == "--to-destination") print $(i+1)}' | head -1)
        port=$(docker exec "$c" iptables -t nat -S 2>/dev/null | awk '/DNAT/ && /udp/ {for (i = 1; i <= NF; i++) if ($i == "--dport") print $(i+1)}' | head -1)
        if [ -n "$peer" ]; then
            echo "--- ping ppp peer $peer"; docker exec "$c" ping -c 5 -W 1 -q "$peer" 2>&1 | tail -2
        fi
        if [ -n "$gw" ]; then
            echo "--- ping gateway ${gw%:*}"; docker exec "$c" ping -c 5 -W 1 -q "${gw%:*}" 2>&1 | tail -2
        fi
        if [ -n "$port" ]; then
            echo "--- knx description $ip:$port (through the DNAT)"
            timeout 10 python3 "$DIR/utils/knxdesc.py" "$ip:$port" 2>&1 | head -2
        fi
        # pppd's own log (no timestamps); the image keeps credentials out of it
        echo "--- ppp log tail (LCP echoes left out)"
        docker exec "$c" tail -n 20000 /var/log/xl2tpd.log 2>/dev/null | grep -v -E 'LCP Echo|CHAP' | tail -8
        echo
    } >> "$f"
    log "$c: captured ($why) -> $f"
}

declare -A start kind cont lastcap pending

# a capture now and, if still down, again after RECAPTURE (background)
capture_drop() {
    local site=$1 c=$2 now
    now=$(date +%s)
    if [ $(( now - ${lastcap[$c]:-0} )) -lt "$QUIET" ]; then
        return
    fi
    lastcap[$c]=$now
    capture "$c" "$site connection dead" &
    ( sleep "$RECAPTURE"
      [ -e "$OUT/.down-$site" ] && capture "$c" "$site still down after ${RECAPTURE}s" ) &
}

end_drop() {
    local site=$1 t=$2 how=$3 s e
    s=$(date -d "${start[$site]}" +%s); e=$(date -d "$t" +%s)
    if [ "$how" = self ] && [ -n "${cont[$site]:-}" ] && [ "$(started_at "${cont[$site]}")" -ge "$s" ]; then
        how=detector
    fi
    echo "$site ${start[$site]/ /T} ${t/ /T} $(( e - s )) ${kind[$site]} $how" >> "$OUT/drops.log"
    log "$site: ${kind[$site]} ${start[$site]} -> $t ($(( e - s )) s, $how)"
    rm -f "$OUT/.down-$site"
    unset "start[$site]" "kind[$site]"
}

# the enabled sites whose dns: is an L2TP container, and those containers;
# read once at start (restart the service after adding an L2TP site)
declare -A last
for site in $(awk '/^ +name:/ {n = $2; gsub(/"/, "", n)} /^ +enabled:/ {e = $2}
                   /^ +dns:/ {if ($2 ~ /^"?172\./ && e == "true") print n}' "$YML"); do
    c=$(l2tp_container "$(dns_of "$site")")
    [ -n "$c" ] && cont[$site]=$c
done
[ ${#cont[@]} -gt 0 ] || { log "no L2TP sites found"; exit 1; }
sites=$(IFS='|'; echo "${!cont[*]}")

# a stall: no events for STALL s while hamon still holds the tunnel - the old
# kapacitor case, where nothing logs "Connection dead"
stall_check() {
    local now site
    now=$(date +%s)
    for site in "${!cont[@]}"; do
        [ -n "${last[$site]:-}" ] && [ -z "${start[$site]:-}" ] || continue
        [ $(( now - last[$site] )) -ge "$STALL" ] || continue
        start[$site]=$(date -d "@${last[$site]}" '+%F %T'); kind[$site]=stall
        touch "$OUT/.down-$site"
        log "$site: no events for $(( now - last[$site] )) s - stall"
        capture_drop "$site" "${cont[$site]}"
    done
}

rm -f "$OUT"/.down-*
log "start: ${!cont[*]} (containers ${cont[*]})"
tail -n0 -F "$CLOG" 2>/dev/null | sed -u 's/\x1b\[[0-9;]*m//g' | grep --line-buffered -E "\"site\":\"($sites)\"" |
while true; do
    IFS= read -r -t 30 line; rc=$?
    if [ $rc -ne 0 ]; then
        [ $rc -gt 128 ] || break    # EOF: tail went away, systemd restarts us
        stall_check; continue
    fi
    site=$(sed -n 's/.*"site":"\([^"]*\)".*/\1/p' <<< "$line")
    [ -n "${cont[$site]:-}" ] || continue
    t=$(grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' <<< "$line" | head -1)
    [ -n "$t" ] || t=$(date '+%F %T')
    case "$line" in
        *' Event '*)
            last[$site]=$(date +%s)
            # a stall that clears without a reconnect ends at its first event
            [ "${kind[$site]:-}" = stall ] && end_drop "$site" "$t" self ;;
        *'ERROR: '*'"Connection dead'*)
            if [ -z "${start[$site]:-}" ] || [ "${kind[$site]}" = blip ]; then
                start[$site]=${start[$site]:-$t}; kind[$site]=outage
                touch "$OUT/.down-$site"
                log "$site: connection dead"
                capture_drop "$site" "${cont[$site]}"
            elif [ "${kind[$site]}" = stall ]; then
                kind[$site]=stall-dead      # hamon noticed later; captured already
            fi ;;
        *'ERROR: '*'"Invalid Connection ID"'*)
            [ -n "${start[$site]:-}" ] || { start[$site]=$t; kind[$site]=blip; } ;;
        *'Exiting - doing cleanup'*)
            # ha-mon or kpipe restarting the site: note it, the drop ends at Connected
            [ -n "${start[$site]:-}" ] && pending[$site]=hamon ;;
        *'Connected - '*)
            [ -n "${start[$site]:-}" ] && end_drop "$site" "$t" "${pending[$site]:-self}"
            unset "pending[$site]"
            last[$site]=$(date +%s) ;;
    esac
    stall_check
done
