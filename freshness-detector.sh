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
#   * Thresholds live in a site-local file (THRESH_FILE), not hamon.yml:
#     hamon.yml is written by hamon-upload, which owns its format, and the file
#     names sites so it stays out of git (see freshness-thresholds.conf.example).
#     One `<key> <minutes>` per line, `#` comments allowed.  Reserved keys, all
#     required - the script refuses to run without them rather than guess:
#       default       stale threshold for every site not listed
#       cooldown      wait after the first restart of a stale spell; doubles
#                     with each further restart ...
#       cooldown_max  ... up to this cap
#     Any other key is a location (case-exact, as in Influx) whose threshold
#     overrides `default` - for low-traffic sites with long normal quiet spells.
#   * Cooldown: a site that stays stale is restarted at once, then after
#     cooldown, 2x, 4x ... cooldown_max, instead of on every 5-minute run.  The
#     spell (and the doubling) resets as soon as the site is seen fresh again.
#     State is kept in STATE (one per mode, so a dry run never delays live
#     action).  This is the external counterpart of hamon's own back-off, which
#     a kpipe restart deliberately overrides.
#
# Usage:
#   DRYRUN=1 ./freshness-detector.sh     # report only (DEFAULT) - nothing restarted
#   DRYRUN=0 ./freshness-detector.sh     # act: restart stale sites
# From cron (every 5 min; output is already in LOG, so discard it or cron mails it):
#   */5 * * * * DRYRUN=0 /home/greg/hamon/freshness-detector.sh >/dev/null 2>&1
# Env overrides: THRESH_MIN, COOLDOWN_MIN, COOLDOWN_MAX (beat the file),
#   THRESH_FILE, STATE, SECRETS, WINDOW, ORG, BUCKET, SLACK_WEBHOOK, SLACK_CHANNEL

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"   # cron's PATH is minimal

# ---- config -----------------------------------------------------------------
HAMON="${HAMON:-/home/greg/hamon}"
YML="$HAMON/hamon.yml"
KPIPE="$HAMON/tmp/kpipe"
LOG="${LOG:-$HAMON/alerts/freshness.log}"
ENVFILE="${ENVFILE:-$HAMON/.hamon-backup.env}"   # provides INFLUX_TOKEN
SECRETS="${SECRETS:-$HAMON/.freshness.env}"      # provides SLACK_WEBHOOK (optional)

ORG="${ORG:-HA}"
BUCKET="${BUCKET:-hamon}"
THRESH_FILE="${THRESH_FILE:-$HAMON/freshness-thresholds.conf}"  # thresholds + cooldown
WINDOW="${WINDOW:-24h}"                  # freshness query lookback (>> THRESH_MIN);
                                         # must exceed worst tolerated outage or a
                                         # hard-down site ages out of the report
DRYRUN="${DRYRUN:-1}"                     # 1 = report only (default), 0 = act
STATE="${STATE:-$HAMON/tmp/freshness-state$([ "$DRYRUN" = 0 ] || echo .dryrun)}"

# INFLUX_TOKEN comes from the env file on prod; on hosts where influxd accepts
# unauthenticated local queries (e.g. staging) the file may be absent and we
# fall back to the active `influx` CLI config context.
# shellcheck source=/dev/null
[ -f "$ENVFILE" ] && . "$ENVFILE"
# shellcheck source=/dev/null
[ -f "$SECRETS" ] && . "$SECRETS"
SLACK_WEBHOOK="${SLACK_WEBHOOK:-}"        # optional; empty = no Slack
SLACK_CHANNEL="${SLACK_CHANNEL:-#knx}"
INFLUX_TOKEN="${INFLUX_TOKEN:-}"
TOKARG=(); [ -n "$INFLUX_TOKEN" ] && TOKARG=(-t "$INFLUX_TOKEN")

mkdir -p "$(dirname "$LOG")" "$(dirname "$STATE")"

# cron does not stop a slow run overlapping the next one (a docker restart
# sleeps, influxd may be slow to answer) - skip this run if one is in progress
exec 9>"$STATE.lock"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

slack() {  # only when acting: a dry run alongside kapacitor must not double-post
  [ -n "$SLACK_WEBHOOK" ] && [ "$DRYRUN" = 0 ] || return 0
  curl -sf -X POST -H 'Content-type: application/json' \
       --data "{\"channel\":\"$SLACK_CHANNEL\",\"text\":\"$1\"}" \
       "$SLACK_WEBHOOK" >/dev/null 2>&1 || true
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

# ---- thresholds + cooldown (THRESH_FILE; env beats file) --------------------
declare -A SITE_THRESH=()
declare -A CONF=()
if [ -f "$THRESH_FILE" ]; then
  while read -r key mins _; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if ! [[ "$mins" =~ ^[0-9]+$ ]]; then
      log "WARN  $THRESH_FILE: ignoring bad value for '$key': '$mins'"; continue
    fi
    case "$key" in
      default|cooldown|cooldown_max) CONF["$key"]="$mins" ;;
      *) SITE_THRESH["$key"]="$mins" ;;
    esac
  done < "$THRESH_FILE"
fi
THRESH_MIN="${THRESH_MIN:-${CONF[default]:-}}"
COOLDOWN_MIN="${COOLDOWN_MIN:-${CONF[cooldown]:-}}"
COOLDOWN_MAX="${COOLDOWN_MAX:-${CONF[cooldown_max]:-}}"
if [ -z "$THRESH_MIN" ] || [ -z "$COOLDOWN_MIN" ] || [ -z "$COOLDOWN_MAX" ]; then
  log "ERROR $THRESH_FILE must set default, cooldown and cooldown_max - not scanning"
  slack "HAMON freshness detector NOT RUNNING: $THRESH_FILE missing default/cooldown/cooldown_max"
  exit 1
fi

# cooldown state: <location> <epoch of last restart> <restarts this spell>
declare -A LAST_ACT=() N_ACT=()
if [ -f "$STATE" ]; then
  while read -r l t n; do
    [ -n "$l" ] && { LAST_ACT["$l"]="$t"; N_ACT["$l"]="$n"; }
  done < "$STATE"
fi
declare -A NEW_ACT=() NEW_N=()   # only still-stale sites are carried forward

# restart <loc> <age> as kapacitor/restart.sh did: docker restart for 172.*
# container sites, then (all sites) a kpipe re-init of the hamon worker
restart_site() {
  local loc="$1" age="$2" dns cont how
  dns=$(yml_field "$loc" dns)
  how="kpipe re-init"
  if [[ "$dns" == 172.* ]]; then
    cont=$(container_for "$dns" "$loc")
    if [ -z "$cont" ]; then
      how="NO CONTAINER at $dns -> kpipe re-init only"
    else
      how="docker restart $cont + kpipe re-init"
      if [ "$DRYRUN" = 0 ]; then
        docker restart "$cont" >/dev/null 2>&1 && sleep 10   # let the vpn settle
      fi
    fi
  fi
  if [ "$DRYRUN" = 0 ]; then echo "$loc" > "$KPIPE"; fi
  echo "$how"
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
log "freshness scan start ($mode_tag) default=${THRESH_MIN}m overrides=${#SITE_THRESH[@]} cooldown=${COOLDOWN_MIN}-${COOLDOWN_MAX}m window=-${WINDOW}"

stale=0 acted=0
while IFS=, read -r loc ts; do
  [ -n "$loc" ] || continue
  last=$(date -u -d "$ts" +%s 2>/dev/null) || continue
  age=$(( (now - last) / 60 ))
  thresh="${SITE_THRESH[$loc]:-$THRESH_MIN}"
  [ "$age" -lt "$thresh" ] && continue

  stale=$((stale + 1))
  enabled=$(yml_field "$loc" enabled)
  if [ "$enabled" = "false" ]; then
    log "SKIP  $loc stale ${age}m but enabled:false"
    continue
  fi

  # cooldown: restart now on the first stale scan, then after cooldown, 2x ...
  n="${N_ACT[$loc]:-0}"; t="${LAST_ACT[$loc]:-0}"
  if [ "$n" -gt 0 ]; then
    wait=$(( COOLDOWN_MIN * (1 << (n - 1)) ))
    [ "$wait" -gt "$COOLDOWN_MAX" ] && wait=$COOLDOWN_MAX
    if [ $(( (now - t) / 60 )) -lt "$wait" ]; then
      log "HOLD  $loc ${age}m (>=${thresh}m) restart $n was $(( (now - t) / 60 ))m ago, next after ${wait}m"
      NEW_ACT["$loc"]="$t"; NEW_N["$loc"]="$n"
      continue
    fi
  fi

  n=$((n + 1)); acted=$((acted + 1))
  how=$(restart_site "$loc" "$age")
  log "STALE $loc ${age}m (>=${thresh}m) restart $n: $how"
  slack "HAMON/$loc no data for ${age}m: $how (restart $n)"
  NEW_ACT["$loc"]="$now"; NEW_N["$loc"]="$n"
done < <(freshness)

# sites not seen stale this run drop out, so their next spell starts afresh
{ for l in "${!NEW_ACT[@]}"; do echo "$l ${NEW_ACT[$l]} ${NEW_N[$l]}"; done; } > "$STATE.tmp" \
  && mv "$STATE.tmp" "$STATE"

log "freshness scan done ($mode_tag) stale=$stale restarted=$acted"
exit 0
