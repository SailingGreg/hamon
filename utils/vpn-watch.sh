#!/bin/bash
#
# vpn-watch.sh - ask hamon to check a VPN site's KNX tunnel when its OpenVPN
# link comes back
#
# After a VPN drop hamon's tunnel may be dead with nothing to say so until its
# next heartbeat, up to 60 s later. This watches each site container's OpenVPN
# log and, on "Initialization Sequence Completed", sends kpipe "check <site>"
# so that heartbeat goes at once. Harmless when the tunnel is fine, and when
# hamon isn't connected the check is simply not sent.
#
# A site container is any running container whose address is the dns: of an
# enabled site in hamon.yml, so new sites need no setup. A container without
# an OpenVPN log (L2TP) is watched but never fires. A connection made while a
# container is being restarted isn't seen: its tail attaches after that.
#
# Runs as a service (vpn-watch.service). One line per event on stdout.
#

set -o nounset

DIR="$(cd "$(dirname "$0")/.." && pwd)"
YML="$DIR/hamon.yml"
KPIPE="$DIR/tmp/kpipe"
SETTLE=2    # seconds from tunnel up to the check (tap gets its address first)
SCAN=30     # seconds between looks for new containers

log() { echo "$(date '+%F %T') $*"; }

# the enabled site whose dns: is this container's address, if any
site_of() {
    local ip
    ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1" 2>/dev/null)
    [ -n "$ip" ] || return
    awk -v ip="$ip" '/^ +name:/ {n = $2} /^ +enabled:/ {e = $2}
                     /^ +dns:/ {if ($2 == ip && e == "true") print n}' "$YML" | tr -d '"' | head -1
}

check_site() {
    local c=$1 site
    site=$(site_of "$c")
    if [ -z "$site" ]; then
        log "$c: tunnel back, no enabled site for it"
    elif [ ! -p "$KPIPE" ]; then
        log "$c: tunnel back; no $KPIPE - is ha-mon running?"
    elif ! timeout 5 sh -c 'echo "check $1" > "$2"' _ "$site" "$KPIPE"; then
        # a FIFO write blocks with no reader (ha-mon stopping or restarting)
        log "$c: tunnel back; kpipe not read - no check"
    else
        log "$c: tunnel back - asked hamon to check $site"
    fi
}

watch_container() {
    local c=$1 line
    docker exec "$c" tail -n0 -F /var/log/openvpn.log 2>/dev/null |
    while IFS= read -r line; do
        case "$line" in
            *"Initialization Sequence Completed"*) sleep "$SETTLE"; check_site "$c" ;;
        esac
    done
}

declare -A pids
log "start"
while true; do
    for c in $(docker ps --format '{{.Names}}'); do
        p=${pids[$c]:-}
        [ -n "$p" ] && kill -0 "$p" 2>/dev/null && continue
        [ -n "$(site_of "$c")" ] || continue
        log "$c: watching"
        watch_container "$c" &
        pids[$c]=$!
    done
    sleep "$SCAN"
done
