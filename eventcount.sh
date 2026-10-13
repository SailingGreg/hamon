#!/usr/bin/bash
#
# eventcount.sh [full|inc]
#
# Maintain knx2 event counts in the dbstats measurement of the hamon InfluxDB
# bucket so Grafana panels can show them instantly, instead of scanning ~1e9
# points (a full count() takes ~1 min) on every dashboard load:
#
#   dbstats,metric=knx2 event_total                     all sites
#   dbstats,metric=knx2_site,location=<site> event_total  one per site
#
#   full : exact count of ALL knx2 events, then write it      (slow, ~1 min)
#   inc  : count only events since the last recorded total,
#          add to it and write                                 (~0.3 s)
#
# Run 'inc' hourly (cron) for freshness; run 'full' on influxd startup and to
# re-true the numbers.  Grafana panels:
#   SELECT last("event_total") FROM "dbstats" WHERE "metric" = 'knx2'
#   SELECT last("event_total") FROM "dbstats" WHERE "metric" = 'knx2_site' AND "location" = '<site>'
# The per-site series use their own metric value so the all-sites query above
# never picks up a site's count.
#
# Count queries are range|>filter|>count() first (pushed down to storage,
# per series) and only then grouped by location and summed; grouping before
# count() makes influxd pull every raw point through Flux (4.8G RSS, 3.5 min
# on prod for a full run).
#
# All lines of one run share one timestamp, which is also the stop of the
# counting range, so the next 'inc' starts exactly where this run stopped.
# That timestamp is LAG seconds in the past so points hamon writes a little
# late (batched) still land in the range they are counted in.
# 'inc' needs per-site baselines from a 'full' run; until there is one it
# keeps the all-sites total going and skips the per-site lines.

set -uo pipefail
ENVFILE="${ENVFILE:-/home/greg/hamon/.hamon-backup.env}"   # provides INFLUX_TOKEN
[ -f "$ENVFILE" ] && . "$ENVFILE"
# no token on hosts where the influx CLI config already has one (staging)
TOKARG=(); [ -n "${INFLUX_TOKEN:-}" ] && TOKARG=(-t "$INFLUX_TOKEN")
ORG="${ORG:-HA}"
BUCKET="${BUCKET:-hamon}"
MODE="${1:-inc}"
LAG="${LAG:-60}"         # seconds; count up to now-LAG
KNX='r._measurement=="knx2" and r._field=="value"'
DBS='r._measurement=="dbstats" and r._field=="event_total" and r.metric=="knx2"'
SITE='r._measurement=="dbstats" and r._field=="event_total" and r.metric=="knx2_site"'

# run a flux query and return the single scalar (last data row, last column)
q() { influx query --org "$ORG" "${TOKARG[@]}" --raw "$1" 2>/dev/null \
        | tr -d '\r' | awk -F, '/^,/{v=$NF} END{print v}'; }
# run a flux query and print "<_value> <location>" per row (columns by name;
# value first so a location containing spaces stays whole in `read n loc`)
qloc() { influx query --org "$ORG" "${TOKARG[@]}" --raw "$1" 2>/dev/null \
        | tr -d '\r' | awk -F, '/^,result,/{delete c; for(i=1;i<=NF;i++) c[$i]=i; next}
            /^,/ && ("_value" in c) && ("location" in c) {print $c["_value"], $c["location"]}'; }
isnum() { [[ "$1" =~ ^[0-9]+$ ]]; }
# line-protocol tag value: escape space, comma and =
tagesc() { sed 's/[ ,=]/\\&/g' <<<"$1"; }

# wait for influxd to accept queries (matters when triggered on startup)
for i in $(seq 1 30); do
  curl -sf http://localhost:8086/health >/dev/null 2>&1 && break
  sleep 2
done

rfc() { echo "$(date -u -d "@${1:0:-9}" +%Y-%m-%dT%H:%M:%S).${1: -9}Z"; }   # ns -> RFC3339
NOWNS=$(( $(date +%s%N) - LAG * 1000000000 ))
NOW=$(rfc "$NOWNS")

# latest all-sites total: the baseline for 'inc'
prev=$(q "from(bucket:\"$BUCKET\") |> range(start:-3650d) |> filter(fn:(r)=> $DBS) |> last() |> keep(columns:[\"_value\"])")
ptime=$(q "from(bucket:\"$BUCKET\") |> range(start:-3650d) |> filter(fn:(r)=> $DBS) |> last() |> keep(columns:[\"_time\"])")
PNS=0; [ -n "$ptime" ] && PNS=$(date -d "$ptime" +%s%N)

declare -A site=()       # location -> total
sites_ok=1
if [ "$MODE" = "full" ]; then
  # a total newer than now-LAG (an 'inc' moments ago) would shadow ours in
  # last(): stamp and stop just after it instead
  [ "$PNS" -ge "$NOWNS" ] && { NOWNS=$((PNS + 1000)); NOW=$(rfc "$NOWNS"); }
  total=0
  while read -r n loc; do
    isnum "$n" || continue
    total=$((total + n))
    [ -n "$loc" ] && site["$loc"]=$n
  done < <(qloc "from(bucket:\"$BUCKET\") |> range(start:0, stop:$NOW) |> filter(fn:(r)=> $KNX) |> count() |> group(columns:[\"location\"]) |> sum() |> keep(columns:[\"location\",\"_value\"])")
  [ "$total" -gt 0 ] || { echo "full count failed (no rows)" >&2; exit 1; }
else
  isnum "$prev"   || { echo "no numeric baseline (got '$prev') - run '$0 full' first" >&2; exit 1; }
  [ -n "$ptime" ] || { echo "no baseline timestamp" >&2; exit 1; }
  # e.g. run within LAG of a 'full': nothing to count yet
  [ "$NOWNS" -gt "$PNS" ] || { echo "$(date '+%F %T') baseline $ptime is not before $NOW - nothing to do (mode=$MODE)"; exit 0; }
  # per-site baselines: only those written with the all-sites total (same _time)
  while read -r n loc; do
    isnum "$n" && site["$loc"]=$n
  done < <(qloc "from(bucket:\"$BUCKET\") |> range(start:$ptime, stop:$NOW) |> filter(fn:(r)=> $SITE) |> filter(fn:(r)=> r._time == time(v:\"$ptime\")) |> keep(columns:[\"location\",\"_value\"])")
  [ ${#site[@]} -gt 0 ] || { sites_ok=0; echo "no per-site baseline at $ptime - per-site lines skipped, run '$0 full'" >&2; }
  inc=0
  while read -r n loc; do
    isnum "$n" || continue
    inc=$((inc + n))
    [ -n "$loc" ] && site["$loc"]=$(( ${site["$loc"]:-0} + n ))
  done < <(qloc "from(bucket:\"$BUCKET\") |> range(start:$ptime, stop:$NOW) |> filter(fn:(r)=> $KNX) |> count() |> group(columns:[\"location\"]) |> sum() |> keep(columns:[\"location\",\"_value\"])")
  total=$((prev + inc))
fi

lines="dbstats,metric=knx2 event_total=${total}i $NOWNS"
if [ "$sites_ok" = 1 ]; then
  for loc in "${!site[@]}"; do
    lines+=$'\n'"dbstats,metric=knx2_site,location=$(tagesc "$loc") event_total=${site[$loc]}i $NOWNS"
  done
fi
influx write --org "$ORG" "${TOKARG[@]}" -b "$BUCKET" "$lines" || { echo "write failed" >&2; exit 1; }
echo "$(date '+%F %T') event_total=$total sites=$([ "$sites_ok" = 1 ] && echo ${#site[@]} || echo skipped) (mode=$MODE)"
