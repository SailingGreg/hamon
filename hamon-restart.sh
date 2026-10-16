#!/usr/bin/env bash
#
# hamon-restart.sh - safe restart of the ha-mon service (e.g. after a deploy).
#
# Never `systemctl restart ha-mon`: on stop, hamon gives its workers ~450ms
# each to send KNXnet/IP DISCONNECTs and then exits regardless, so some
# gateways keep the old tunnel. A new process that reconnects at once races
# those stale tunnels and can sit unconnected (OPUS_AQUA, 2026-10-07).
#
# So:  stop -> verify the process and its sockets are gone -> wait out the
# gateway tunnel timeout (KNXnet/IP drops a tunnel after 120s without a
# heartbeat) -> start -> report enabled sites that have not reconnected.
#
# The waits come from what hamon reports rather than fixed sleeps:
#  - gateway wait: tmp/site-state.json (written as hamon stops) says which
#    sites had a tunnel up; if each of them logged a graceful disconnect in
#    hamon.log, their gateways have already dropped the tunnel and a short
#    wait does. Any that didn't: the full wait, as before.
#  - after the start: done as soon as the new hamon has no site still
#    starting (connected, blocked, down or disabled), at most CHECK_WAIT.
#
# Usage:
#   ./hamon-restart.sh            # asks for confirmation
#   ./hamon-restart.sh -y         # no prompt
# Env overrides: GATEWAY_WAIT (130s), CLEAN_WAIT (10s), CHECK_WAIT (150s),
#                STOP_LIMIT (120s)
#
set -u

HAMON="${HAMON:-$HOME/hamon}"
SERVICE="${SERVICE:-ha-mon}"
YML="$HAMON/hamon.yml"
LOG="$HAMON/src/combined.log"
KPIPE="$HAMON/tmp/kpipe"
STATE="$HAMON/tmp/site-state.json"
OUT="$HAMON/hamon.log"                # hamon's stdout: the workers' disconnect lines
GATEWAY_WAIT="${GATEWAY_WAIT:-130}"   # > 120s KNXnet/IP connection timeout
CLEAN_WAIT="${CLEAN_WAIT:-10}"        # every tunnel was closed by a DISCONNECT
CHECK_WAIT="${CHECK_WAIT:-150}"       # most time for sites to reconnect after start
STOP_LIMIT="${STOP_LIMIT:-120}"       # give up if hamon has not exited by then

log() { echo "$(date '+%F %T') $*"; }
die() { log "ABORT: $*"; exit 1; }

hamon_pids() { pgrep -u "$(id -u)" -f "node .*src/hamon.js"; }

[ -f "$YML" ] || die "no $YML"
[ -f "$LOG" ] || die "no $LOG"

if [ "${1:-}" != "-y" ]; then
  read -r -p "Restart $SERVICE on $(hostname)? [y/N] " ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "not restarted"; exit 0; }
fi
sudo -v || die "sudo needed for systemctl"

# sites in a given state in the state file, one per line ('' if no file)
state_sites() {
  python3 - "$STATE" "$1" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
for name, s in d.get("sites", {}).items():
    if s.get("state") == sys.argv[2]:
        print(name)
PY
}

# ---- stop and verify termination --------------------------------------------
out_offset=$(( $(stat -c %s "$OUT" 2>/dev/null || echo 0) + 1 ))
log "stopping $SERVICE"
sudo systemctl stop "$SERVICE" || die "systemctl stop failed"

for _ in $(seq 1 "$STOP_LIMIT"); do
  [ -z "$(hamon_pids)" ] && ! systemctl is-active -q "$SERVICE" && break
  sleep 1
done
[ -n "$(hamon_pids)" ] && die "hamon still running after ${STOP_LIMIT}s ($(hamon_pids | tr '\n' ' ')) - NOT starting, check by hand"
systemctl is-active -q "$SERVICE" && die "$SERVICE still active - NOT starting"
log "hamon stopped (KNXnet/IP is UDP: its sockets went with the process)"

# which tunnels did the workers close themselves? The state file (saved as
# hamon stopped) lists the sites that were connected
wait="$GATEWAY_WAIT"
if [ -f "$STATE" ] && [ -f "$OUT" ]; then
  stopped=$(tail -c +"$out_offset" "$OUT")
  connected=$(state_sites connected)
  unclean=()
  for site in $connected; do
    grep -qF "[$site] Disconnected, closed connection gracefully" <<<"$stopped" || unclean+=("$site")
  done
  if [ -n "$connected" ] && [ "${#unclean[@]}" -eq 0 ]; then
    wait="$CLEAN_WAIT"
    log "all $(wc -w <<<"$connected") connected sites closed their tunnels"
  elif [ "${#unclean[@]}" -gt 0 ]; then
    log "no graceful disconnect from: ${unclean[*]}"
  fi
fi
log "waiting ${wait}s for gateways to drop stale tunnels"
sleep "$wait"

# ---- start ------------------------------------------------------------------
offset=$(( $(stat -c %s "$LOG") + 1 ))
log "starting $SERVICE"
sudo systemctl start "$SERVICE" || die "systemctl start failed"
sleep 5
systemctl is-active -q "$SERVICE" || die "$SERVICE not active after start - see hamon.err"

# wait until the new hamon has settled every site (no site still starting),
# at most CHECK_WAIT
pid=$(systemctl show "$SERVICE" -p MainPID --value)
log "waiting for sites to reconnect (at most ${CHECK_WAIT}s)"
settled=""
for _ in $(seq 5 5 "$CHECK_WAIT"); do
  sleep 5
  systemctl is-active -q "$SERVICE" || die "$SERVICE died after start - see hamon.err"
  if python3 - "$STATE" "$pid" <<'PY' 2>/dev/null; then
import json, sys
d = json.load(open(sys.argv[1]))
ok = d.get("pid") == int(sys.argv[2]) and d.get("running") is True \
     and not any(s.get("state") == "starting" for s in d.get("sites", {}).values())
sys.exit(0 if ok else 1)
PY
    settled=yes; break
  fi
done
[ -n "$settled" ] && log "every site settled" || log "still starting after ${CHECK_WAIT}s"
systemctl is-active -q "$SERVICE" || die "$SERVICE died after start - see hamon.err"

# ---- report -----------------------------------------------------------------
new=$(tail -c +"$offset" "$LOG" | sed 's/\x1b\[[0-9;]*m//g')
enabled=$(awk '/^  Location/{if(n&&e=="true")print n; n=e=""}
               /name:/{n=$2} /enabled:/{e=$2}
               END{if(n&&e=="true")print n}' "$YML" | tr -d "\"'")

total=0; ok=0; missing=()
for site in $enabled; do
  total=$((total + 1))
  if grep -q "Connected - $site " <<<"$new"; then
    ok=$((ok + 1))
  else
    missing+=("$site")
  fi
done

log "$SERVICE up: $ok/$total enabled sites connected"
# what hamon says about the rest: blocked (why), down (next retry), starting
if [ -n "$settled" ] || [ -f "$STATE" ]; then
  python3 - "$STATE" "$pid" <<'PY' 2>/dev/null && missing=()
import json, sys
from datetime import datetime
d = json.load(open(sys.argv[1]))
local = lambda t: datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
if d.get("pid") != int(sys.argv[2]):
    sys.exit(1)  # not the new hamon's file: use the log-based list below
rest = {k: v for k, v in d.get("sites", {}).items() if v.get("state") not in ("connected", "disabled")}
for state in ("blocked", "down", "starting"):
    names = sorted(k for k, v in rest.items() if v["state"] == state)
    if names:
        print(f"{state.capitalize()}:")
    for k in names:
        v = rest[k]
        why = v.get("detail") or v.get("reason") or (f"retry at {local(v['nextRetry'])}" if v.get("nextRetry") else "")
        print(f"  - {k}" + (f"  ({why})" if why else ""))
if rest:
    print("Blocked sites: Re-check in hamon-upload, or echo <site> > kpipe")
PY
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Not connected:"
  for site in "${missing[@]}"; do
    err=$(grep -m1 "Worker error: $site -" <<<"$new" | sed 's/.*Worker error: [^ ]* - //; s/ {.*//')
    echo "  - $site${err:+  ($err)}"
  done
  echo "Known-dead sites will always appear here. For a site that should be up:"
  echo "  echo <site> > $KPIPE     # re-init just that worker"
fi
