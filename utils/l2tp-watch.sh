#!/bin/bash
#
# l2tp-watch.sh - drop log and point-of-failure capture for L2TP VPN sites
#
# The L2TP sites lose their KNX path every few days while the PPP session and
# IPsec stay up; hamon logs "Connection dead" ~90 s later and the freshness
# detector restarts the container 10-25 min after that. That is ~3/4 of the
# drops, so this covers only that case. It follows hamon's combined.log and for
# each site in an L2TP container (one with a ppp0):
#
#   drops.log      one line per drop when it ends: site, start (when hamon
#                  logged "Connection dead"), end, seconds,
#                  and what ended it (self, or detector = the container was
#                  restarted meanwhile)
#   capture-DATE   on "Connection dead": the container's state (ppp0, IPsec SA
#                  ages, processes, DNAT counters and ppp0 traffic 5 s apart,
#                  conntrack count, pings to the PPP peer and the gateway, a
#                  KNX DESCRIPTION through the DNAT as hamon sees it, the ppp
#                  log tail); again 3 min later if the site is still down.
#                  Once per container per 2 min (sites sharing one are one
#                  capture)
#
# Stalls (no events and no error logged) are left to the freshness detector,
# whose journal records them (STALE ... restart N).
#
# Read-only: it never restarts anything. Logs go to alerts/l2tp-watch/.
# Runs as a service (l2tp-watch.service). One line per event on stdout.
#

set -o nounset

DIR="$(cd "$(dirname "$0")/.." && pwd)"
YML="$DIR/hamon.yml"
CLOG="${CLOG:-$DIR/src/combined.log}"
OUT="${OUT:-$DIR/alerts/l2tp-watch}"
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

declare -A start cont lastcap

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
    local site=$1 t=$2 how=self s e
    s=$(date -d "${start[$site]}" +%s); e=$(date -d "$t" +%s)
    if [ "$(started_at "${cont[$site]}")" -ge "$s" ]; then
        how=detector
    fi
    echo "$site ${start[$site]/ /T} ${t/ /T} $(( e - s )) $how" >> "$OUT/drops.log"
    log "$site: drop ${start[$site]} -> $t ($(( e - s )) s, $how)"
    rm -f "$OUT/.down-$site"
    unset "start[$site]"
}

# the enabled sites whose dns: is an L2TP container, and those containers;
# read once at start (restart the service after adding an L2TP site)
for site in $(awk '/^ +name:/ {n = $2; gsub(/"/, "", n)} /^ +enabled:/ {e = $2}
                   /^ +dns:/ {if ($2 ~ /^"?172\./ && e == "true") print n}' "$YML"); do
    c=$(l2tp_container "$(dns_of "$site")")
    [ -n "$c" ] && cont[$site]=$c
done
[ ${#cont[@]} -gt 0 ] || { log "no L2TP sites found"; exit 1; }
sites=$(IFS='|'; echo "${!cont[*]}")

rm -f "$OUT"/.down-*
log "start: ${!cont[*]} (containers ${cont[*]})"
tail -n0 -F "$CLOG" 2>/dev/null | sed -u 's/\x1b\[[0-9;]*m//g' | grep --line-buffered -E "\"site\":\"($sites)\"" |
    grep --line-buffered -E '"Connection dead|Connected - ' |
while IFS= read -r line; do
    site=$(sed -n 's/.*"site":"\([^"]*\)".*/\1/p' <<< "$line")
    [ -n "${cont[$site]:-}" ] || continue
    t=$(grep -oE '20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}' <<< "$line" | head -1)
    [ -n "$t" ] || t=$(date '+%F %T')
    case "$line" in
        *'ERROR: '*'"Connection dead'*)
            if [ -z "${start[$site]:-}" ]; then
                # hamon logs this ~90 s after the last event
                start[$site]=$t
                touch "$OUT/.down-$site"
                log "$site: connection dead"
                capture_drop "$site" "${cont[$site]}"
            fi ;;
        *'Connected - '*)
            [ -n "${start[$site]:-}" ] && end_drop "$site" "$t" ;;
    esac
done
# EOF: tail went away, systemd restarts us
