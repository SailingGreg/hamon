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
# Usage:
#   ./hamon-restart.sh            # asks for confirmation
#   ./hamon-restart.sh -y         # no prompt
# Env overrides: GATEWAY_WAIT (130s), CHECK_WAIT (150s), STOP_LIMIT (120s)
#
set -u

HAMON="${HAMON:-$HOME/hamon}"
SERVICE="${SERVICE:-ha-mon}"
YML="$HAMON/hamon.yml"
LOG="$HAMON/src/combined.log"
KPIPE="$HAMON/tmp/kpipe"
GATEWAY_WAIT="${GATEWAY_WAIT:-130}"   # > 120s KNXnet/IP connection timeout
CHECK_WAIT="${CHECK_WAIT:-150}"       # time for sites to reconnect after start
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

# ---- stop and verify termination --------------------------------------------
log "stopping $SERVICE"
sudo systemctl stop "$SERVICE" || die "systemctl stop failed"

for _ in $(seq 1 "$STOP_LIMIT"); do
  [ -z "$(hamon_pids)" ] && ! systemctl is-active -q "$SERVICE" && break
  sleep 1
done
[ -n "$(hamon_pids)" ] && die "hamon still running after ${STOP_LIMIT}s ($(hamon_pids | tr '\n' ' ')) - NOT starting, check by hand"
systemctl is-active -q "$SERVICE" && die "$SERVICE still active - NOT starting"
log "hamon stopped (KNXnet/IP is UDP: its sockets went with the process)"

log "waiting ${GATEWAY_WAIT}s for gateways to drop stale tunnels"
sleep "$GATEWAY_WAIT"

# ---- start ------------------------------------------------------------------
offset=$(( $(stat -c %s "$LOG") + 1 ))
log "starting $SERVICE"
sudo systemctl start "$SERVICE" || die "systemctl start failed"
sleep 5
systemctl is-active -q "$SERVICE" || die "$SERVICE not active after start - see hamon.err"

log "waiting ${CHECK_WAIT}s for sites to reconnect"
sleep "$CHECK_WAIT"
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
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Not connected:"
  for site in "${missing[@]}"; do
    err=$(grep -m1 "Worker error: $site -" <<<"$new" | sed 's/.*Worker error: [^ ]* - //; s/ {.*//')
    echo "  - $site${err:+  ($err)}"
  done
  echo "Known-dead sites will always appear here. For a site that should be up:"
  echo "  echo <site> > $KPIPE     # re-init just that worker"
fi
