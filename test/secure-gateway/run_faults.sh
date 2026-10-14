#!/bin/bash
# run_faults.sh [config] [fault ...] - run hamon's shim against the simulator once per fault and summarise
# (default: no fault, then every fault). Needs .venv (see README) and node.
cd "$(dirname "$0")"
CFG=${1:-config.example.json}; shift
FAULTS=${*:-"none auth_failed unauthenticated bad_session_mac no_session_response status_timeout status_close no_more_connections silent_heartbeat wrong_group_key plain_to_keyed stale_wrapper"}
PORT=13671
OUT=$(mktemp -d)
for f in $FAULTS; do
  secs=14; [ "$f" = silent_heartbeat ] && secs=50
  arg=""; [ "$f" != none ] && arg="--fault $f"
  .venv/bin/python securegw.py -c "$CFG" -p $PORT $arg > "$OUT/$f.gw" 2>&1 & gw=$!
  sleep 1.5
  timeout $((secs + 10)) node shim_client.js "$CFG" $secs $PORT > "$OUT/$f.client" 2>&1
  kill $gw 2>/dev/null; wait $gw 2>/dev/null
  rx=$(grep -c "^  rx " "$OUT/$f.client")
  sessions=$(grep -c "<- SESSION_REQUEST" "$OUT/$f.gw")
  conn=$(grep -c "^  CONNECTED" "$OUT/$f.client")
  secure_rx=$(grep -cE "^  rx .* -> 1/2/[34] " "$OUT/$f.client")
  note=$(grep -hE "shim (error|warn)|error event" "$OUT/$f.client" | sed -E 's/^ +//' | sort | uniq -c | sort -rn | head -2 | sed -E 's/^ +//' | cut -c1-120 | tr '\n' ';')
  gwnote=$(grep -hE "dropped|failed|fault" "$OUT/$f.gw" | sed -E 's/^[0-9:.]+ \([^)]*\) //' | sort | uniq -c | sort -rn | head -1 | sed -E 's/^ +//' | cut -c1-90)
  printf "%-20s sessions=%-2s connected=%-2s rx=%-2s (keyed %s) | %s %s\n" "$f" "$sessions" "$conn" "$rx" "$secure_rx" "$note" "${gwnote:+| gw: $gwnote}"
done
echo "logs: $OUT"
