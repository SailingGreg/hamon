#!/bin/bash
# hamon-watchdog.test.sh - hamon-watchdog.sh on stubbed systemctl/influx and a
# fake state file: ok, hang (stale heartbeat, wrong pid), crash with the
# hamon.err tail, deliberate stop, Influx not storing, and log-on-change only.
# Runs in a temp dir, touches nothing real.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/hamon/tmp" "$t/hamon/alerts"
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

NOW=$(date -d '2026-11-16 10:30:00' +%s)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
# unit: ACTIVE/RESULT/PID/STATUS set per case; started an hour before NOW
systemctl() { cat <<E
ActiveState=$ACTIVE
Result=$RESULT
MainPID=$PID
ExecMainStatus=$XSTATUS
ExecMainExitTimestamp=Mon 2026-11-16 10:20:00 GMT
ActiveEnterTimestamp=$(date -d "@$((NOW - 3600))" '+%a %F %T %Z')
E
}
# influx: newest point INFLUX_AGE seconds before NOW ("" = no answer)
influx() { [ -z "$INFLUX_AGE" ] && return 0
  echo "#group,false,false,false"; echo "#datatype,string,long,dateTime:RFC3339"; echo "#default,_result,,"
  echo ",result,table,_time"; echo ",,0,$(iso $((NOW - INFLUX_AGE)))"; }
export NOW; export -f systemctl influx iso
# state file: saved UPD_AGE s ago by pid FPID, 4 sites with data DATA_AGE s ago
state() { python3 - "$t/hamon/tmp/site-state.json" "$(iso $((NOW - $1)))" "$2" "$3" "$(iso $((NOW - $4)))" <<'PY'
import json, sys
f, upd, pid, run, last = sys.argv[1:6]
json.dump({"updated": upd, "pid": int(pid), "running": run == "true",
           "sites": {s: {"state": "connected", "lastData": last} for s in "abcd"}}, open(f, "w"))
PY
}
run() { HAMON="$t/hamon" ENVFILE=/dev/null NOW="$NOW" "$here/hamon-watchdog.sh"; }
st() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["status"])' "$t/hamon/tmp/watchdog.json"; }
lines() { wc -l < "$t/hamon/alerts/watchdog.log"; }

export ACTIVE=active RESULT=success PID=4242 XSTATUS=0 INFLUX_AGE=30
state 30 4242 true 60; run
check "running, fresh file, Influx current: ok" '[ "$(st)" = ok ]'
check "first run logs one OK line" '[ "$(lines)" = 1 ] && grep -q "OK      ha-mon running" "$t/hamon/alerts/watchdog.log"'
run
check "same status, same hour: no new line" '[ "$(lines)" = 1 ]'
N0=$NOW; NOW=$((N0 + 3600)); state 30 4242 true 60; run; NOW=$N0
check "next hour: one ok line" '[ "$(lines)" = 2 ] && tail -1 "$t/hamon/alerts/watchdog.log" | grep -q " ok$"'

state 400 4242 true 60; run
check "heartbeat 6m old: hang" '[ "$(st)" = hang ] && grep -q "HANG    ha-mon pid 4242: state file not saved for 6m" "$t/hamon/alerts/watchdog.log"'
state 30 999 true 60; run
check "file from another pid an hour after start: hang" '[ "$(st)" = hang ]'
check "hang to hang: no new line" '[ "$(grep -c HANG "$t/hamon/alerts/watchdog.log")" = 1 ]'

state 30 4242 true 60; INFLUX_AGE=1800 run
check "data in hamon, Influx 30m old: influx" '[ "$(st)" = influx ] && grep -q "INFLUX  not storing: hamon has data from 4 sites" "$t/hamon/alerts/watchdog.log"'
INFLUX_AGE= run
check "Influx no answer: influx" '[ "$(st)" = influx ]'
state 30 4242 true 1800; INFLUX_AGE=1800 run
check "no fresh hamon data (uplink out): not an Influx fault" '[ "$(st)" = ok ] && grep -q "(was influx)" "$t/hamon/alerts/watchdog.log"'

printf '\033[31mERROR\033[39m some site noise\nTypeError: bad dpt\n    at decode (dpt27.js:1:1)\n' > "$t/hamon/hamon.err"
ACTIVE=failed RESULT=exit-code XSTATUS=1 run
check "failed unit: crash with exit status" '[ "$(st)" = crash ] && grep -q "CRASH   ha-mon failed (exit-code), exit status 1 .* NOT restarted" "$t/hamon/alerts/watchdog.log"'
check "crash log has the hamon.err tail, colours stripped" 'grep -q "        | TypeError: bad dpt" "$t/hamon/alerts/watchdog.log" && grep -q "        | ERROR some site noise" "$t/hamon/alerts/watchdog.log"'
ACTIVE=inactive RESULT=signal run
check "inactive after a signal kill: still a crash (no new line)" '[ "$(st)" = crash ] && [ "$(grep -c CRASH "$t/hamon/alerts/watchdog.log")" = 1 ]'
ACTIVE=inactive RESULT=success run
check "inactive, success: deliberate stop" '[ "$(st)" = stopped ] && grep -q "STOPPED ha-mon stopped deliberately" "$t/hamon/alerts/watchdog.log"'
ACTIVE=activating run
check "activating (restart in progress): ok" '[ "$(st)" = ok ]'
check "watchdog.json has since + detail" 'python3 -c "import json,sys;d=json.load(open(sys.argv[1]));assert set(d)>={\"checked\",\"status\",\"since\",\"detail\"}" "$t/hamon/tmp/watchdog.json"'

echo "--- log:"; cat "$t/hamon/alerts/watchdog.log"
[ "$fails" = 0 ] && echo "hamon-watchdog.test.sh: all passed" || { echo "hamon-watchdog.test.sh: $fails failed"; exit 1; }
