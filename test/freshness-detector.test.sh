#!/bin/bash
# freshness-detector.test.sh - the detector with ha-mon stopped or not reading
# its kpipe: nothing restarted and no hang while ha-mon is down, and a kpipe
# write that gives up rather than blocking. Stubs influx/docker/curl on PATH;
# runs in a temp dir, touches nothing real. ~15 s (two 5 s kpipe timeouts).
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
t=$(mktemp -d)
trap 'kill $hamon_pid 2>/dev/null; rm -rf "$t"' EXIT
mkdir -p "$t/bin" "$t/hamon/tmp" "$t/hamon/alerts/netprobe"
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# influx: two sites, both last seen an hour ago (stale at the 20 min default)
old=$(date -u -d '-60 min' +%Y-%m-%dT%H:%M:%SZ)
cat > "$t/bin/influx" <<EOF
#!/bin/bash
echo "#group,false,false,false,true"; echo "#datatype,string,long,dateTime,string"; echo "#default,_result,,,"
echo ",result,table,_time,location"
echo ",,0,$old,alpha"
echo ",,1,$old,beta"
EOF
# docker: log every call; restart fails (so the detector skips its 10 s VPN wait)
cat > "$t/bin/docker" <<EOF
#!/bin/bash
echo "\$*" >> "$t/docker.calls"
case "\$1" in
  ps) [ "\${2:-}" = "-q" ] && echo cid || echo vpnbeta ;;
  inspect) case "\$*" in *Name*) echo /vpnbeta ;; *) echo "172.18.0.5 " ;; esac ;;
  restart) exit 1 ;;
esac
EOF
printf '#!/bin/bash\nexit 0\n' > "$t/bin/curl"
chmod +x "$t/bin/"*
# the detector puts /usr/bin first on PATH, so the stubs go in as exported
# functions, which bash looks up before PATH
stubs="$t/bin"
influx() { "$stubs/influx" "$@"; }; docker() { "$stubs/docker" "$@"; }; curl() { "$stubs/curl" "$@"; }
export stubs; export -f influx docker curl

cat > "$t/hamon/hamon.yml" <<'EOF'
locations:
  - name: alpha
    dns: gw.example
    enabled: true
  - name: beta
    dns: 172.18.0.5
    enabled: true
EOF
printf 'default 20\ncooldown 20\ncooldown_max 240\ngrace 0\n' > "$t/hamon/freshness-thresholds.conf"
mkfifo "$t/hamon/tmp/kpipe"
# a live process whose command line names hamon.js, as ha-mon's does
bash -c 'exec -a hamon.js sleep 120' & hamon_pid=$!

state() { # state <running> <pid>
  printf '{"updated":"2026-11-09T10:00:00Z","pid":%s,"running":%s,"sites":{"alpha":{"state":"connected"},"beta":{"state":"connected"}}}\n' "$2" "$1" > "$t/hamon/tmp/site-state.json"
}
run() { # run -> output; the detector's own log, fresh each time
  rm -f "$t/docker.calls" "$t/hamon/tmp/freshness-state" "$t/log"
  HAMON="$t/hamon" LOG="$t/log" ENVFILE=/dev/null SECRETS=/dev/null DRYRUN=0 \
    timeout 60 bash "$here/freshness-detector.sh" > /dev/null 2>&1
  echo $?
}

# 1. ha-mon stopped cleanly: nothing restarted, no kpipe write, quick
state false "$hamon_pid"
s=$(date +%s); rc=$(run); secs=$(( $(date +%s) - s ))
check "stopped: exits 0" '[ "$rc" = 0 ]'
check "stopped: no hang (${secs}s)" '[ "$secs" -lt 5 ]'
check "stopped: HAMON down line" 'grep -q "HAMON down (state file says stopped" "$t/log"'
check "stopped: both sites held" '[ "$(grep -c "HOLD .* ha-mon not running" "$t/log")" = 2 ]'
check "stopped: no docker restart" '! grep -q "^restart" "$t/docker.calls" 2>/dev/null'
check "stopped: spell not started" '[ ! -s "$t/hamon/tmp/freshness-state" ]'

# 2. state file says running, pid gone (ha-mon crashed)
state true 999999
run > /dev/null
check "crashed: HAMON down, pid gone" 'grep -q "HAMON down (pid 999999 gone)" "$t/log"'
check "crashed: no docker restart" '! grep -q "^restart" "$t/docker.calls" 2>/dev/null'

# 3. no state file
rm -f "$t/hamon/tmp/site-state.json"
run > /dev/null
check "no file: HAMON down" 'grep -q "HAMON down (no state file)" "$t/log"'

# 4. ha-mon running but not reading the kpipe: the write gives up after 5 s
state true "$hamon_pid"
s=$(date +%s); rc=$(run); secs=$(( $(date +%s) - s ))
check "unread kpipe: exits 0" '[ "$rc" = 0 ]'
check "unread kpipe: gives up (${secs}s)" '[ "$secs" -lt 20 ]'
check "unread kpipe: both restarted, noted" '[ "$(grep -c "STALE .*(kpipe not read)" "$t/log")" = 2 ]'
check "unread kpipe: docker restart tried for beta" 'grep -q "^restart vpnbeta" "$t/docker.calls"'

# 5. ha-mon reading the kpipe: both lines arrive
( cat "$t/hamon/tmp/kpipe"; cat "$t/hamon/tmp/kpipe" ) > "$t/read" &
reader=$!
run > /dev/null
wait $reader
check "read kpipe: lines delivered" '[ "$(sort "$t/read" | tr "\n" " ")" = "alpha beta " ]'
check "read kpipe: no note" '! grep -q "kpipe not read" "$t/log"'

[ "$fails" = 0 ] && echo "freshness-detector.test.sh: all checks passed" || { echo "$fails failed"; exit 1; }
