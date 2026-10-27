#!/usr/bin/env bash
#
# vpn-probe.sh - packet loss through each site VPN container's tunnel
#
# On 2026-10-27 one site's tunnel lost 15-25% of its packets for 12.5 hours
# after a reconnect (docs/vpn-loss-20261027.md, local). hamon kept
# reconnecting and data thinned, but nothing alerted: the freshness detector
# only sees silence, and the containers' healthcheck tests their internet
# access, not the tunnel. A soft reconnect (SIGUSR1) fixed it at once.
#
# Every run pings each site's gateway from inside its container, through the
# tunnel, and logs loss and round trip. The containers are found by their
# DNAT rule to a KNXnet/IP port (:3671): its target is the gateway, so new
# sites are picked up with no list to keep. Site names come from hamon.yml
# (dns = container IP, port = DNAT port); two sites can share a gateway.
#
# A container is LOSSY when loss >= LOSS_PCT on BAD_RUNS runs in a row: one
# line in LOG and one Slack message per spell, and one more when it clears.
# A container with no reply at all is DOWN (same rules) - hamon and the
# freshness detector handle a dead tunnel, but it is reported here too.
# Report only: nothing is reconnected (see utils/vpn-reconnect.sh for that).
#
# Usage: vpn-probe.sh            from a systemd timer (vpn-probe.timer)
# Env overrides: LOSS_PCT (10), BAD_RUNS (2), COUNT (20), INTERVAL (0.5),
#   LOG, STATE, SECRETS (provides SLACK_WEBHOOK), SLACK_CHANNEL, NOTIFY (1)
#

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

HAMON="${HAMON:-/home/greg/hamon}"
YML="$HAMON/hamon.yml"
LOG="${LOG:-$HAMON/alerts/vpn-probe.log}"
STATE="${STATE:-$HAMON/tmp/vpn-probe-state}"
SECRETS="${SECRETS:-$HAMON/.freshness.env}"
[ -f "$SECRETS" ] && . "$SECRETS"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"
SLACK_CHANNEL="${SLACK_CHANNEL:-#knx}"
NOTIFY="${NOTIFY:-1}"

LOSS_PCT="${LOSS_PCT:-10}"   # % loss that counts as a bad run
BAD_RUNS="${BAD_RUNS:-2}"    # bad runs in a row before it is reported
COUNT="${COUNT:-20}"         # pings per container per run
INTERVAL="${INTERVAL:-0.5}"  # seconds between pings

mkdir -p "$(dirname "$LOG")" "$(dirname "$STATE")"
exec 9>"$STATE.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

slack() {
  [ -n "$SLACK_WEBHOOK" ] && [ "$NOTIFY" = 1 ] || return 0
  curl -sf -X POST -H 'Content-type: application/json' \
       --data "{\"channel\":\"$SLACK_CHANNEL\",\"text\":\"$1\"}" \
       "$SLACK_WEBHOOK" >/dev/null 2>&1 || true
}

# site names per "<ip> <port>", from hamon.yml (enabled sites only)
declare -A SITES=()
while read -r ip port name; do
  [ -n "$ip" ] && SITES["$ip $port"]="${SITES["$ip $port"]:+${SITES["$ip $port"]},}$name"
done < <(python3 - "$YML" <<'PY'
import sys, yaml
try:
    locs = (yaml.safe_load(open(sys.argv[1])) or {}).get("locations") or {}
except Exception:
    sys.exit(0)
for s in (locs.values() if isinstance(locs, dict) else locs):
    if isinstance(s, dict) and s.get("enabled") and str(s.get("dns", "")).startswith("172."):
        print(s["dns"], s.get("port"), s.get("name"))
PY
)

# state: <container> <bad runs in a row> <reported 0|1>
declare -A BAD=() REPORTED=()
if [ -f "$STATE" ]; then
  while read -r c n r; do
    [ -n "$c" ] && { BAD["$c"]="$n"; REPORTED["$c"]="$r"; }
  done < "$STATE"
fi

# probe every container with a DNAT to :3671, in parallel (~COUNT*INTERVAL s)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
declare -A TARGET=() LABEL=()
for c in $(docker ps --format '{{.Names}}'); do
  rule=$(docker exec "$c" iptables -t nat -S PREROUTING 2>/dev/null |
         grep -m1 -oE 'dport [0-9]+ -j DNAT --to-destination [0-9.]+:3671')
  [ -n "$rule" ] || continue
  port=$(echo "$rule" | awk '{print $2}')
  target=$(echo "$rule" | awk '{print $NF}' | cut -d: -f1)
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$c" | awk '{print $1}')
  TARGET["$c"]="$target"
  LABEL["$c"]="${SITES["$ip $port"]:-?}"
  docker exec "$c" ping -c "$COUNT" -i "$INTERVAL" -W 2 "$target" > "$tmp/$c" 2>&1 &
done
wait

out=$(mktemp)
for c in "${!TARGET[@]}"; do
  sites="${LABEL[$c]}" target="${TARGET[$c]}"
  # busybox: "15% packet loss" + "round-trip min/avg/max = a/b/c ms"
  # iputils: "15% packet loss" + "rtt min/avg/max/mdev = a/b/c/d ms"
  loss=$(grep -oE '[0-9.]+% packet loss' "$tmp/$c" | cut -d% -f1)
  rtt=$(grep -E 'min/avg/max' "$tmp/$c" | sed -E 's/.*= //; s/ ms//')
  avg=$(echo "$rtt" | cut -d/ -f2) max=$(echo "$rtt" | cut -d/ -f3)
  [ -n "$loss" ] || loss=100
  loss=${loss%.*}
  log "$c ($sites) $target loss=${loss}% avg=${avg:--}ms max=${max:--}ms"

  n=${BAD[$c]:-0} r=${REPORTED[$c]:-0}
  if [ "$loss" -ge "$LOSS_PCT" ]; then
    n=$((n + 1))
    if [ "$n" -ge "$BAD_RUNS" ] && [ "$r" = 0 ]; then
      what=$([ "$loss" -ge 100 ] && echo DOWN || echo LOSSY)
      log "$what $c ($sites): ${loss}% loss to $target, $n runs in a row"
      slack "HAMON/$sites VPN $what: ${loss}% loss to the gateway through container $c ($n runs) - try: docker exec $c pkill -USR1 -x openvpn"
      r=1
    fi
  else
    if [ "$r" = 1 ]; then
      log "CLEAR $c ($sites): ${loss}% loss, avg ${avg}ms"
      slack "HAMON/$sites VPN clear: ${loss}% loss through container $c"
    fi
    n=0 r=0
  fi
  echo "$c $n $r" >> "$out"
done
mv "$out" "$STATE"
