#! /usr/bin/env bash
#
# liveness-audit.sh  -  reconcile the hamon.yml roster against what is actually
# flowing into InfluxDB, and report the gap.  This is the SLOW companion to
# freshness-detector.sh:
#
#   freshness-detector  = fast (5 min), RESTARTS recently-flowing sites that
#                         just stopped.  Recovery.
#   liveness-audit      = slow (daily), REPORTS ONLY.  Surfaces the sites the
#                         detector deliberately ignores — enabled but not
#                         flowing — so "is this site actually active?" is
#                         answered continuously instead of by hand.
#
# It never restarts anything.  `enabled: true` means "hamon should try"; it does
# NOT mean data is flowing (commissioning can fail, a site can die silently and
# fall out of the detector's window).  Buckets reported:
#
#   DROPPED    enabled, has flowed before, but silent > DROP_HOURS  -> investigate
#   NEVER      enabled, no data at all within the lookback window    -> never
#              commissioned / long dead -> re-commission or set enabled:false
#   ODD        disabled, yet data is still flowing                   -> config drift
#   MALFORMED  enabled: is neither true nor false (e.g. a typo like  -> fix the yml;
#              `flase`) so consumers disagree on whether it is live     intent unknown
#
# Usage:  ./liveness-audit.sh           # print + log the report
# Env overrides: ACTIVE_MIN, DROP_HOURS, LOOKBACK, ORG, BUCKET, SLACK_WEBHOOK

set -uo pipefail

HAMON="${HAMON:-/home/greg/hamon}"
YML="$HAMON/hamon.yml"
LOG="${LOG:-$HAMON/alerts/liveness.log}"
ENVFILE="${ENVFILE:-$HAMON/.hamon-backup.env}"

ORG="${ORG:-HA}"
BUCKET="${BUCKET:-hamon}"
ACTIVE_MIN="${ACTIVE_MIN:-20}"        # flowing if last point younger than this (min)
DROP_HOURS="${DROP_HOURS:-6}"          # enabled+silent beyond this = DROPPED
LOOKBACK="${LOOKBACK:-180d}"           # "ever seen" window; older than this = NEVER
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"

# token optional (prod has one; staging queries unauthenticated) - see detector
# shellcheck source=/dev/null
[ -f "$ENVFILE" ] && . "$ENVFILE"
INFLUX_TOKEN="${INFLUX_TOKEN:-}"
TOKARG=(); [ -n "$INFLUX_TOKEN" ] && TOKARG=(-t "$INFLUX_TOKEN")

mkdir -p "$(dirname "$LOG")"
emit() { printf '%s\n' "$*" | tee -a "$LOG"; }

# roster: name<TAB>enabled(1/0)<TAB>dns<TAB>desc  (js-yaml resolves from ~/hamon)
roster() {
  ( cd "$HAMON" && node -e '
const y=require("js-yaml"),fs=require("fs");
const d=y.load(fs.readFileSync(process.argv[1],"utf8"))||{};
for(const k in (d.locations||{})){const l=d.locations[k];if(!l||!l.name)continue;
  const en=(l.enabled===true?"true":(l.enabled===false?"false":"malformed"));
  process.stdout.write([l.name,en,(l.dns||""),(l.desc||"")].join("\t")+"\n");}
' "$YML" )
}

# location<TAB>epoch  for every location seen in the lookback window
seen() {
  influx query --org "$ORG" "${TOKARG[@]}" --raw "
from(bucket:\"$BUCKET\") |> range(start:-$LOOKBACK)
 |> filter(fn:(r)=> r._measurement==\"knx2\" and r._field==\"value\")
 |> group(columns:[\"location\"]) |> last() |> keep(columns:[\"location\",\"_time\"])
" 2>/dev/null | tr -d '\r' \
  | awk -F, '$1=="" && $5!="" && $5!="location"{ "date -u -d \""$4"\" +%s" | getline e; print $5"\t"e }'
}

# ---- gather ----
now=$(date -u +%s)
declare -A LAST
while IFS=$'\t' read -r loc epoch; do
  [ -n "$loc" ] && LAST["$loc"]="$epoch"
done < <(seen)

drop_sec=$(( DROP_HOURS * 3600 ))
n_en=0 n_active=0 n_hung=0; dropped=(); never=(); odd=(); malformed=()

while IFS=$'\t' read -r name en dns desc; do
  [ -n "$name" ] || continue
  epoch="${LAST[$name]:-}"
  if [ -n "$epoch" ]; then age=$(( now - epoch )); else age=-1; fi   # -1 = never
  if [ "$en" = "malformed" ]; then
    malformed+=("$name|$dns|$desc")
  elif [ "$en" = "true" ]; then
    n_en=$((n_en+1))
    if   [ "$age" -ge 0 ] && [ "$age" -lt $((ACTIVE_MIN*60)) ]; then n_active=$((n_active+1))
    elif [ "$age" -ge 0 ] && [ "$age" -lt "$drop_sec" ];        then n_hung=$((n_hung+1))
    elif [ "$age" -ge "$drop_sec" ]; then dropped+=("$name|$((age/86400))d|$dns|$desc")
    else never+=("$name|$dns|$desc"); fi
  else
    # disabled but flowing within the active window = config drift
    if [ "$age" -ge 0 ] && [ "$age" -lt "$drop_sec" ]; then odd+=("$name|$((age/60))m|$desc"); fi
  fi
done < <(roster)

# ---- report ----
emit "$(date '+%F %T') liveness audit  (active<${ACTIVE_MIN}m, drop>${DROP_HOURS}h, lookback ${LOOKBACK})"
emit "  enabled=$n_en  active=$n_active  hung=$n_hung  dropped=${#dropped[@]}  never=${#never[@]}  disabled-but-flowing=${#odd[@]}  malformed=${#malformed[@]}"

if [ "${#dropped[@]}" -gt 0 ]; then
  emit "  DROPPED (enabled, was flowing, now silent >${DROP_HOURS}h - investigate):"
  for r in "${dropped[@]}"; do IFS='|' read -r n d dns ds <<<"$r"; emit "    - $n  silent ${d}  dns=${dns}  (${ds})"; done
fi
if [ "${#never[@]}" -gt 0 ]; then
  emit "  NEVER (enabled, no data in ${LOOKBACK} - recommission or set enabled:false):"
  for r in "${never[@]}"; do IFS='|' read -r n dns ds <<<"$r"; emit "    - $n  dns=${dns}  (${ds})"; done
fi
if [ "${#odd[@]}" -gt 0 ]; then
  emit "  ODD (disabled, yet flowing - config drift):"
  for r in "${odd[@]}"; do IFS='|' read -r n a ds <<<"$r"; emit "    - $n  last ${a}  (${ds})"; done
fi
if [ "${#malformed[@]}" -gt 0 ]; then
  emit "  MALFORMED (enabled: not true/false - fix the yml):"
  for r in "${malformed[@]}"; do IFS='|' read -r n dns ds <<<"$r"; emit "    - $n  dns=${dns}  (${ds})"; done
fi

# Slack: one compact line, only when there is something to act on
if [ -n "$SLACK_WEBHOOK" ] && { [ "${#dropped[@]}" -gt 0 ] || [ "${#never[@]}" -gt 0 ] || [ "${#odd[@]}" -gt 0 ] || [ "${#malformed[@]}" -gt 0 ]; }; then
  msg="hamon liveness: ${#dropped[@]} dropped, ${#never[@]} never, ${#odd[@]} disabled-but-flowing, ${#malformed[@]} malformed (enabled=$n_en active=$n_active)"
  curl -sf -X POST -H 'Content-type: application/json' --data "{\"text\":\"$msg\"}" "$SLACK_WEBHOOK" >/dev/null 2>&1 || true
fi
exit 0
