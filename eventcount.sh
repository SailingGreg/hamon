#!/usr/bin/bash
#
# eventcount.sh [full|inc]
#
# Maintain  dbstats,metric=knx2 event_total  in the hamon InfluxDB bucket so a
# Grafana panel can show the total number of knx2 events instantly, instead of
# scanning ~1e9 points (a full count() takes ~1 min) on every dashboard load.
#
#   full : exact count of ALL knx2 events, then write it      (slow, ~1 min)
#   inc  : count only events since the last recorded total,
#          add to it and write                                 (~0.3 s)
#
# Run 'inc' hourly (cron) for freshness; run 'full' on influxd startup and to
# re-true the number.  Grafana panel:  SELECT last("event_total") FROM "dbstats"

set -uo pipefail
. /home/greg/hamon/.hamon-backup.env        # provides INFLUX_TOKEN
ORG=HA
BUCKET=hamon
MODE="${1:-inc}"
KNX='r._measurement=="knx2" and r._field=="value"'
DBS='r._measurement=="dbstats" and r._field=="event_total"'

# run a flux query and return the single scalar (last data row, last column)
q() { influx query --org "$ORG" -t "$INFLUX_TOKEN" --raw "$1" 2>/dev/null \
        | tr -d '\r' | awk -F, '/^,/{v=$NF} END{print v}'; }
isnum() { [[ "$1" =~ ^[0-9]+$ ]]; }

# wait for influxd to accept queries (matters when triggered on startup)
for i in $(seq 1 30); do
  curl -sf http://localhost:8086/health >/dev/null 2>&1 && break
  sleep 2
done

if [ "$MODE" = "full" ]; then
  total=$(q "from(bucket:\"$BUCKET\") |> range(start:0) |> filter(fn:(r)=> $KNX) |> count() |> group() |> sum() |> keep(columns:[\"_value\"])")
  isnum "$total" || { echo "full count failed (got '$total')" >&2; exit 1; }
else
  prev=$(q "from(bucket:\"$BUCKET\") |> range(start:-3650d) |> filter(fn:(r)=> $DBS) |> last() |> keep(columns:[\"_value\"])")
  ptime=$(q "from(bucket:\"$BUCKET\") |> range(start:-3650d) |> filter(fn:(r)=> $DBS) |> last() |> keep(columns:[\"_time\"])")
  isnum "$prev"   || { echo "no numeric baseline (got '$prev') - run '$0 full' first" >&2; exit 1; }
  [ -n "$ptime" ] || { echo "no baseline timestamp" >&2; exit 1; }
  inc=$(q "from(bucket:\"$BUCKET\") |> range(start: ${ptime}, stop: now()) |> filter(fn:(r)=> $KNX) |> count() |> group() |> sum() |> keep(columns:[\"_value\"])")
  isnum "$inc" || inc=0
  total=$((prev + inc))
fi

influx write --org "$ORG" -t "$INFLUX_TOKEN" -b "$BUCKET" "dbstats,metric=knx2 event_total=${total}i"
echo "$(date '+%F %T') event_total=$total (mode=$MODE)"
