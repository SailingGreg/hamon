#! /usr/bin/env bash
#
# hamon-watchdog.sh - watches ha-mon itself (step 4 of docs/site-states.md).
# hamon owns every site (silence ladder, back-off, container restarts); this
# checks the one thing hamon can't: that ha-mon is running, not stuck, and
# that what it receives reaches Influx.
#
# REPORT ONLY. It never restarts ha-mon: a crash caused by a device's data
# (a DPT the stack can't handle, as on 2026-10-21) would crash again on the
# restart and loop. So a crash is logged with its cause (exit status + the
# tail of hamon.err) for a human to judge.
#
# Each run (systemd timer, every 5 min):
#   ha-mon unit (systemctl show, no sudo needed)
#     failed, or inactive with a Result other than success
#                     -> CRASH: exit status, time, last hamon.err lines
#     inactive, Result success
#                     -> STOPPED: a deliberate stop (systemctl stop,
#                        hamon-restart.sh); nothing wrong
#     active          -> the heartbeat: hamon saves tmp/site-state.json every
#                        minute (service.js startHeartbeat), so `updated`
#                        older than HANG_MIN with `running: true` and the
#                        unit's pid = HANG (main thread stuck). A file from
#                        another pid within START_MIN of the start is normal.
#   Influx (only while ha-mon is up and not hung)
#     hamon has data in the last FRESH_MIN from at least MIN_SITES sites, but
#     Influx's newest knx2 point is older than INFLUX_MIN -> INFLUX not
#     storing. An uplink outage stops hamon's data too, so it can't trip this.
#
#   VPN containers (vpn/containers.conf, as utils/vpn-up.sh): an enabled
#     container site whose container is missing or stopped (not just
#     restarting) -> VPN line. hamon restarts a container but can't create
#     one; utils/vpn-up.sh does (at boot, or by hand).
#
# Logging: one line when the status changes (alerts/watchdog.log), and an
# `ok` line on the first run of each hour so the log shows it is alive.
# tmp/watchdog.json = the current status, for the board.
#
# Env overrides (also for test/hamon-watchdog.test.sh): HAMON, UNIT, LOG,
#   STATUS, SITE_STATE, ERRLOG, VPNCONF, YML, HANG_MIN, START_MIN, FRESH_MIN, MIN_SITES,
#   INFLUX_MIN, ORG, BUCKET, ENVFILE, NOW (epoch seconds)

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

HAMON="${HAMON:-/home/greg/hamon}"
UNIT="${UNIT:-ha-mon}"
LOG="${LOG:-$HAMON/alerts/watchdog.log}"
STATUS="${STATUS:-$HAMON/tmp/watchdog.json}"
SITE_STATE="${SITE_STATE:-$HAMON/tmp/site-state.json}"
ERRLOG="${ERRLOG:-$HAMON/hamon.err}"
VPNCONF="${VPNCONF:-$HAMON/vpn/containers.conf}"
YML="${YML:-$HAMON/hamon.yml}"
ENVFILE="${ENVFILE:-$HAMON/.hamon-backup.env}"   # INFLUX_TOKEN
HANG_MIN="${HANG_MIN:-5}"
START_MIN="${START_MIN:-3}"
FRESH_MIN="${FRESH_MIN:-10}"
MIN_SITES="${MIN_SITES:-3}"
INFLUX_MIN="${INFLUX_MIN:-15}"
ORG="${ORG:-HA}"
BUCKET="${BUCKET:-hamon}"
NOW="${NOW:-$(date +%s)}"

# shellcheck source=/dev/null
[ -f "$ENVFILE" ] && . "$ENVFILE"
INFLUX_TOKEN="${INFLUX_TOKEN:-}"
TOKARG=(); [ -n "$INFLUX_TOKEN" ] && TOKARG=(-t "$INFLUX_TOKEN")

mkdir -p "$(dirname "$LOG")" "$(dirname "$STATUS")"
exec 9>"$STATUS.lock"
flock -n 9 || exit 0

stamp() { date -d "@$NOW" '+%F %T'; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# ---- the unit ---------------------------------------------------------------
declare -A U=()
while IFS='=' read -r k v; do U["$k"]="$v"; done < <(
  systemctl show "$UNIT" -p ActiveState -p Result -p MainPID -p ExecMainStatus \
    -p ExecMainExitTimestamp -p ActiveEnterTimestamp 2>/dev/null)
active="${U[ActiveState]:-unknown}"
result="${U[Result]:-unknown}"

status="ok"; detail=""; extra=""
case "$active" in
  active)
    # heartbeat: "<updated epoch> <pid> <running> <sites with fresh data> <newest data epoch>"
    read -r upd fpid frun fresh newest < <(python3 - "$SITE_STATE" "$NOW" "$FRESH_MIN" <<'PY' 2>/dev/null
import json, sys
from datetime import datetime
def ep(s):
    try: return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception: return 0
try: d = json.load(open(sys.argv[1]))
except Exception:
    print("0 0 none 0 0"); sys.exit()
now, fresh_s = int(sys.argv[2]), int(sys.argv[3]) * 60
last = [ep(s.get("lastData") or "") for s in d.get("sites", {}).values() if isinstance(s, dict)]
print(ep(d.get("updated", "")), d.get("pid", 0), str(d.get("running")).lower(),
      sum(1 for t in last if t and now - t <= fresh_s), max(last, default=0))
PY
)
    upd=${upd:-0}; fpid=${fpid:-0}; frun=${frun:-none}; fresh=${fresh:-0}; newest=${newest:-0}
    started=$(date -d "${U[ActiveEnterTimestamp]:-}" +%s 2>/dev/null || echo 0)
    age=$(( (NOW - upd) / 60 ))
    if [ "$fpid" != "${U[MainPID]:-}" ] || [ "$frun" != "true" ]; then
      if [ $(( NOW - started )) -ge $(( START_MIN * 60 )) ]; then
        status="hang"; detail="running ${U[MainPID]:-?} for $(( (NOW - started) / 60 ))m but the state file is from pid $fpid (running: $frun)"
      fi
    elif [ "$age" -ge "$HANG_MIN" ]; then
      status="hang"; detail="pid $fpid: state file not saved for ${age}m (heartbeat every 1m)"
    fi
    # Influx, only while ha-mon is fine and has data to store
    if [ "$status" = ok ] && [ "$fresh" -ge "$MIN_SITES" ]; then
      itime=$(influx query --org "$ORG" "${TOKARG[@]}" --raw "
from(bucket:\"$BUCKET\")
  |> range(start:-6h)
  |> filter(fn:(r)=> r._measurement==\"knx2\" and r._field==\"value\")
  |> last()
  |> group()
  |> max(column:\"_time\")
  |> keep(columns:[\"_time\"])
" 2>/dev/null | tr -d '\r' | awk -F, 'NR>3 && $4 ~ /^[0-9]/{print $4; exit}')
      ie=$(date -u -d "${itime:-}" +%s 2>/dev/null || echo 0)
      if [ -z "$itime" ] || [ $(( NOW - ie )) -ge $(( INFLUX_MIN * 60 )) ]; then
        status="influx"
        if [ -z "$itime" ]; then idesc="no knx2 point in 6h (or no answer)"; else idesc="newest knx2 point $(( (NOW - ie) / 60 ))m old"; fi
        detail="hamon has data from $fresh sites in ${FRESH_MIN}m (newest $(iso "$newest")), Influx $idesc"
      fi
    fi ;;
  inactive|failed)
    if [ "$active" = inactive ] && [ "$result" = success ]; then
      status="stopped"; detail="stopped deliberately at ${U[ExecMainExitTimestamp]:-?}"
    else
      status="crash"
      detail="$active ($result), exit status ${U[ExecMainStatus]:-?} at ${U[ExecMainExitTimestamp]:-?}"
      [ -f "$ERRLOG" ] && extra=$(tail -n 15 "$ERRLOG" | sed "s/\x1b\[[0-9;]*m//g" | cut -c1-300)
    fi ;;
  *) status="ok"; detail="$active" ;;   # activating/deactivating: a restart in progress
esac

# ---- VPN containers ---------------------------------------------------------
# "<container> <state> (<sites>)" for each one an enabled site needs that is
# missing or stopped; empty when all are up (or there is no containers.conf)
vpn=""
if [ -f "$VPNCONF" ]; then
  while read -r ip site; do
    c=$(awk -v ip="$ip" '$1 !~ /^#/ && $2 == ip {print $1; exit}' "$VPNCONF")
    [ -z "$c" ] && { vpn+="${vpn:+; }$site ($ip) has no container in containers.conf (utils/vpn-up.sh --check)"; continue; }
    st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null) || st=missing   # it prints an empty line first
    case "$st" in running|restarting) ;; *) vpn+="${vpn:+; }$c $st ($site)" ;; esac
  done < <(python3 - "$YML" <<'PY' 2>/dev/null
import sys, yaml
d = yaml.safe_load(open(sys.argv[1])) or {}
seen = {}
for l in (d.get("locations") or {}).values():
    dns = str(l.get("dns", ""))
    if dns.startswith("172.18.") and l.get("enabled", True) is not False:
        seen[dns] = seen.get(dns, []) + [str(l.get("name"))]
for ip, names in seen.items():
    print(ip, ",".join(names))
PY
)
fi

# ---- report on change -------------------------------------------------------
prev=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("status",""),d.get("hour",""))' "$STATUS" 2>/dev/null)
prev_status=${prev%% *}; prev_hour=${prev##* }
prev_vpn=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("vpn",""))' "$STATUS" 2>/dev/null)
hour=$(date -d "@$NOW" +%Y%m%d%H)
log() { printf '%s %s\n' "$(stamp)" "$*" >> "$LOG"; }

if [ "$status" != "$prev_status" ]; then
  case "$status" in
    ok)      log "OK      ha-mon running, state file current${prev_status:+ (was $prev_status)}" ;;
    stopped) log "STOPPED ha-mon $detail" ;;
    crash)   log "CRASH   ha-mon $detail - NOT restarted (a data crash would repeat); last hamon.err lines:"
             [ -n "$extra" ] && printf '%s\n' "$extra" | sed 's/^/        | /' >> "$LOG" ;;
    hang)    log "HANG    ha-mon $detail - NOT restarted" ;;
    influx)  log "INFLUX  not storing: $detail" ;;
  esac
elif [ "$hour" != "$prev_hour" ] && [ "$status" = ok ]; then
  log "ok"
fi

if [ "$vpn" != "$prev_vpn" ]; then
  if [ -n "$vpn" ]; then log "VPN     container down: $vpn - utils/vpn-up.sh brings it up"
  else log "VPN     all containers up${prev_vpn:+ (was: $prev_vpn)}"; fi
fi

python3 - "$STATUS" "$status" "$detail" "$(iso "$NOW")" "$hour" "${prev_status:-}" "$vpn" <<'PY'
import json, os, sys
f, status, detail, now, hour, prev, vpn = sys.argv[1:8]
since = now
try:
    old = json.load(open(f))
    if old.get("status") == status: since = old.get("since", now)
except Exception:
    pass
tmp = f + ".tmp"
json.dump({"checked": now, "status": status, "since": since, "detail": detail, "hour": hour, "vpn": vpn}, open(tmp, "w"))
os.replace(tmp, f)
PY
