#! /usr/bin/env bash
#
# freshness-detector.sh  -  standalone replacement for the kapacitor `deadmanv2`
# hung-site detector.
#
# Every run it asks InfluxDB, per location, "when did we last see a knx2 point?".
# Any site whose newest point is older than THRESHOLD is treated as hung (tunnel
# up + KNX lib thinks it is connected, but no data flowing) and is restarted the
# same way restart.sh would:  container sites (hamon.yml `dns: 172.*`) -> docker
# restart;  standard sites -> write the location to the kpipe that service.js
# reads to re-init that site's KNX connection.
#
# DESIGN NOTES (why it works the way it does)
#   * Watch-list comes from the LIVE Influx tags in a bounded window, NOT from
#     the hamon.yml roster.  A roster would flag never-commissioned / long-dead
#     sites and restart-loop them; deadman only ever fired for groups it had
#     actually seen, and this mirrors that.  WINDOW must stay >> THRESHOLD.
#   * Container resolution is by IP, not by name.  Container names drifted from
#     site names (e.g. site `fox` @ 172.18.0.15 is served by a container called
#     `oldmarketrd`; `OPUS_AQUA` -> container `opusaqua`).  The hamon.yml `dns:`
#     IP is the only reliable join.  Lowercase+strip-non-alnum name matching is
#     a fallback for when no container holds the IP.
#
# Usage:
#   DRYRUN=1 ./freshness-detector.sh     # report only (DEFAULT) - nothing restarted
#   DRYRUN=0 ./freshness-detector.sh     # act: restart stale sites
# Env overrides: THRESH_MIN, WINDOW, ORG, BUCKET, SLACK_WEBHOOK

set -uo pipefail

# ---- config -----------------------------------------------------------------
HAMON="${HAMON:-/home/greg/hamon}"
YML="$HAMON/hamon.yml"
KPIPE="$HAMON/tmp/kpipe"
LOG="${LOG:-$HAMON/alerts/freshness.log}"
ENVFILE="${ENVFILE:-$HAMON/.hamon-backup.env}"   # provides INFLUX_TOKEN

ORG="${ORG:-HA}"
BUCKET="${BUCKET:-hamon}"
THRESH_MIN="${THRESH_MIN:-20}"          # stale if last point older than this (minutes)
WINDOW="${WINDOW:-6h}"                   # freshness query lookback (>> THRESH_MIN)
DRYRUN="${DRYRUN:-1}"                     # 1 = report only (default), 0 = act
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"        # optional; empty = no Slack

# INFLUX_TOKEN comes from the env file on prod; on hosts where influxd accepts
# unauthenticated local queries (e.g. staging) the file may be absent and we
# fall back to the active `influx` CLI config context.
# shellcheck source=/dev/null
[ -f "$ENVFILE" ] && . "$ENVFILE"
INFLUX_TOKEN="${INFLUX_TOKEN:-}"
TOKARG=(); [ -n "$INFLUX_TOKEN" ] && TOKARG=(-t "$INFLUX_TOKEN")

mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

slack() {
  [ -n "$SLACK_WEBHOOK" ] || return 0
  curl -sf -X POST -H 'Content-type: application/json' \
       --data "{\"text\":\"$1\"}" "$SLACK_WEBHOOK" >/dev/null 2>&1 || true
}

# normalise a name the way the (intended) vpn convention does: lowercase, drop
# any non-alphanumeric (so OPUS_AQUA -> opusaqua, bartonw_lc -> bartonwlc).
norm() { echo "$1" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9'; }

# ---- wait for influxd -------------------------------------------------------
for _ in $(seq 1 30); do
  curl -sf http://localhost:8086/health >/dev/null 2>&1 && break
  sleep 2
done

# ---- per-location freshness (bounded window, single round-trip) -------------
# CSV columns: ,result,table,_time,location  ->  $4=_time $5=location
freshness() {
  influx query --org "$ORG" "${TOKARG[@]}" --raw "
from(bucket:\"$BUCKET\")
  |> range(start:-$WINDOW)
  |> filter(fn:(r)=> r._measurement==\"knx2\" and r._field==\"value\")
  |> group(columns:[\"location\"])
  |> last()
  |> keep(columns:[\"location\",\"_time\"])
" 2>/dev/null | tr -d '\r' \
   | awk -F, 'NR>3 && $5!="" && $5!="location"{print $5","$4}'
}

# ---- hamon.yml helpers (case-exact: Influx tag == yml name) ------------------
yml_field() {  # yml_field <site> <field>   (dns | enabled | config)
  grep -A 9 " name: $1" "$YML" 2>/dev/null | grep -m1 " $2:" | awk '{print $2}'
}

# resolve the running container serving a given hamon-network IP; fall back to
# normalised-name match; echo "" if nothing found.
container_for() {  # container_for <ip> <site>
  local ip="$1" site="$2" id name cip want
  for id in $(docker ps -q 2>/dev/null); do
    name=$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')
    for cip in $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id" 2>/dev/null); do
      [ "$cip" = "$ip" ] && { echo "$name"; return 0; }
    done
  done
  want=$(norm "$site")
  for name in $(docker ps --format '{{.Names}}' 2>/dev/null); do
    [ "$(norm "$name")" = "$want" ] && { echo "$name"; return 0; }
  done
  echo ""
}

# ---- main -------------------------------------------------------------------
now=$(date -u +%s)
mode_tag=$([ "$DRYRUN" = 0 ] && echo "ACT" || echo "DRYRUN")
log "freshness scan start ($mode_tag) threshold=${THRESH_MIN}m window=-${WINDOW}"

stale=0
while IFS=, read -r loc ts; do
  [ -n "$loc" ] || continue
  last=$(date -u -d "$ts" +%s 2>/dev/null) || continue
  age=$(( (now - last) / 60 ))
  [ "$age" -lt "$THRESH_MIN" ] && continue

  stale=$((stale + 1))
  enabled=$(yml_field "$loc" enabled)
  if [ "$enabled" = "false" ]; then
    log "SKIP  $loc stale ${age}m but enabled:false"
    continue
  fi

  dns=$(yml_field "$loc" dns)
  if [[ "$dns" == 172.* ]]; then
    cont=$(container_for "$dns" "$loc")
    if [ -z "$cont" ]; then
      log "STALE $loc ${age}m dns=$dns NO CONTAINER at IP -> falling back to kpipe re-init"
      if [ "$DRYRUN" = 0 ]; then echo "$loc" > "$KPIPE"; fi
      slack "HAMON/$loc hung ${age}m: no container at $dns, kpipe re-init"
    else
      log "STALE $loc ${age}m dns=$dns -> docker restart $cont ${DRYRUN:+(dryrun=$DRYRUN)}"
      if [ "$DRYRUN" = 0 ]; then docker restart "$cont" >/dev/null && sleep 10; fi
      slack "HAMON/$loc hung ${age}m: docker restart $cont"
    fi
  else
    log "STALE $loc ${age}m standard -> kpipe re-init"
    if [ "$DRYRUN" = 0 ]; then echo "$loc" > "$KPIPE"; fi
    slack "HAMON/$loc hung ${age}m: kpipe re-init"
  fi
done < <(freshness)

log "freshness scan done ($mode_tag) stale=$stale"
exit 0
