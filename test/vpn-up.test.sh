#!/bin/bash
# vpn-up.test.sh - utils/vpn-up.sh and the watchdog's VPN check on a stubbed
# docker: running left alone, stopped started, missing created by its script,
# disabled/unknown sites, a shared container, the tunnel wait, -n, and the
# watchdog's VPN line on change. Temp dir only; ~5 s.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/hamon/vpn" "$t/hamon/tmp" "$t/hamon/alerts" "$t/d"
fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

# fake docker: $D/<name> = "<status> <ip> <tunnel yes|no>"; calls logged
export D="$t/d"
docker() {
  echo "$*" >> "$D/calls"
  case "$1" in
    inspect)
      local c="${!#}"; [ -f "$D/$c" ] || { echo; return 1; }   # as docker: an empty line, then fail
      read -r st ip tun < "$D/$c"
      case "$*" in *Status*) echo "$st" ;; *IPAddress*) echo "$ip " ;; esac ;;
    start) [ -f "$D/$2" ] || return 1; read -r st ip tun < "$D/$2"; echo "running $ip $tun" > "$D/$2" ;;
    exec) read -r st ip tun < "$D/$2"; [ "$st" = running ] && [ "$tun" = yes ] && echo "5: tun0: <POINTOPOINT,UP> mtu 1500" ;;
  esac
}
export -f docker

cat > "$t/hamon/hamon.yml" <<'Y'
locations:
  a: { name: alpha, dns: 172.18.0.11, port: 3980 }
  b: { name: beta_lc, dns: 172.18.0.12, port: 3880 }
  c: { name: beta_hh, dns: 172.18.0.12, port: 3880 }
  d: { name: gamma, dns: 172.18.0.15, port: 3882 }
  e: { name: offsite, dns: 172.18.0.14, port: 3882, enabled: false }
  f: { name: nobox, dns: 172.18.0.30, port: 3890 }
  g: { name: direct, dns: example.ddns.net, port: 3671 }
Y
cat > "$t/hamon/vpn/containers.conf" <<'C'
# comment
alpha    172.18.0.11  alpha.sh
beta     172.18.0.12  beta.sh
gammabox 172.18.0.15  gamma-v3.sh
offbox   172.18.0.14  off.sh
C
# beta's script creates it (as docker run --rm would after a reboot)
echo 'docker run -dit --rm --name beta xl2tpd >/dev/null; echo "running 172.18.0.12 yes" > "$D/beta"' > "$t/hamon/vpn/beta.sh"
echo "running 172.18.0.11 yes" > "$D/alpha"
echo "exited 172.18.0.15 yes" > "$D/gammabox"
echo "exited 172.18.0.14 yes" > "$D/offbox"

out=$(HAMON="$t/hamon" "$here/utils/vpn-up.sh" -n)
check "-n changes nothing" '[ ! -f "$D/beta" ] && ! grep -q "^start" "$D/calls"'
check "-n says what it would do" 'grep -q "beta (172.18.0.12, beta_lc,beta_hh): missing - creating with beta.sh" <<< "$out" && grep -q "gammabox (172.18.0.15, gamma): exited - starting" <<< "$out"'

: > "$D/calls"
out=$(HAMON="$t/hamon" WAIT=5 "$here/utils/vpn-up.sh"); rc=$?
echo "$out" | sed 's/^/     /'
check "exit 0" '[ $rc = 0 ]'
check "running container left alone" '! grep -qE "^(start|run) .*alpha" "$D/calls"'
check "stopped container started" 'grep -q "^start gammabox" "$D/calls"'
check "missing container created by its script, once for two sites" '[ "$(grep -c "^run .*--name beta" "$D/calls")" = 1 ]'
check "disabled site's container not started" '! grep -q "offbox" "$D/calls"'
check "site with no container line reported" 'grep -q "nobox (172.18.0.30): no container in containers.conf" <<< "$out"'
check "direct site ignored" '! grep -q direct <<< "$out"'
check "all tunnels up" 'grep -q "all 3 tunnels up" <<< "$out"'

# a tunnel that never comes up: reported after WAIT, still exit 0
echo "running 172.18.0.15 no" > "$D/gammabox"
out=$(HAMON="$t/hamon" WAIT=3 "$here/utils/vpn-up.sh"); rc=$?
check "tunnel not up: reported, exit 0" '[ $rc = 0 ] && grep -q "2 of 3 tunnels up after 3s; still waiting: gammabox" <<< "$out"'
# wrong address
echo "running 172.18.0.99 yes" > "$D/gammabox"
out=$(HAMON="$t/hamon" WAIT=3 "$here/utils/vpn-up.sh")
check "wrong address reported" 'grep -q "gammabox: has address 172.18.0.99 , hamon.yml expects 172.18.0.15\|gammabox: has address 172.18.0.99 hamon.yml\|gammabox: has address" <<< "$out"'
echo "running 172.18.0.15 yes" > "$D/gammabox"
check "no conf: exit 1" '! CONF=/nonexistent HAMON="$t/hamon" "$here/utils/vpn-up.sh" >/dev/null'

# --only <address>: just that container (hamon's ladder for a stopped/missing one)
echo "exited 172.18.0.15 yes" > "$D/gammabox"; echo "exited 172.18.0.11 yes" > "$D/alpha"
out=$(HAMON="$t/hamon" "$here/utils/vpn-up.sh" -n --only 172.18.0.15)
check "--only -n: says it, changes nothing" 'grep -q "gammabox (172.18.0.15, gamma): exited - starting" <<< "$out" && ! grep -q alpha <<< "$out" && grep -q "^exited" "$D/gammabox"'
: > "$D/calls"
out=$(HAMON="$t/hamon" WAIT=3 "$here/utils/vpn-up.sh" --only 172.18.0.15); rc=$?
check "--only: that container started, no other" '[ $rc = 0 ] && grep -q "^start gammabox" "$D/calls" && ! grep -q "^start alpha" "$D/calls" && grep -q "all 1 tunnels up" <<< "$out"'
rm "$D/beta"
out=$(HAMON="$t/hamon" WAIT=3 "$here/utils/vpn-up.sh" --only 172.18.0.12)
check "--only: missing container created" 'grep -q "beta (172.18.0.12, beta_lc,beta_hh): missing - creating with beta.sh" <<< "$out" && [ -f "$D/beta" ]'
out=$(HAMON="$t/hamon" "$here/utils/vpn-up.sh" --only 172.18.0.14); rc=$?
check "--only: disabled/unknown address, nothing done, exit 0" '[ $rc = 0 ] && grep -q "172.18.0.14: no enabled container site at this address" <<< "$out" && ! grep -q offbox "$D/calls"'
check "--only without address: exit 1" '! HAMON="$t/hamon" "$here/utils/vpn-up.sh" --only 2>/dev/null'
echo "running 172.18.0.11 yes" > "$D/alpha"; echo "running 172.18.0.15 yes" > "$D/gammabox"

# the watchdog's VPN check (ha-mon itself reported as stopped, to skip the rest)
systemctl() { printf 'ActiveState=inactive\nResult=success\nMainPID=0\n'; }; export -f systemctl
wd() { HAMON="$t/hamon" ENVFILE=/dev/null "$here/hamon-watchdog.sh"; }
wlog="$t/hamon/alerts/watchdog.log"
wd
check "watchdog: site with no container line reported once" '[ "$(grep -c "VPN     container down: nobox (172.18.0.30) has no container" "$wlog")" = 1 ]'
rm "$D/beta"; echo "exited 172.18.0.11 yes" > "$D/alpha"
wd
check "watchdog: missing + stopped reported, with sites" 'grep -q "VPN     container down: alpha exited (alpha); beta missing (beta_lc,beta_hh); nobox (172.18.0.30) has no container" "$wlog"' 
n=$(wc -l < "$wlog"); wd
check "watchdog: same again, no new line" '[ "$(wc -l < "$wlog")" = "$n" ]'
echo "restarting 172.18.0.11 yes" > "$D/alpha"; echo "running 172.18.0.12 yes" > "$D/beta"
sed -i '/nobox/d' "$t/hamon/hamon.yml"
wd
check "watchdog: restarting counts as up; back up logged" 'grep -q "VPN     all containers up (was: alpha exited" "$wlog"'

# --check
printf 'LOCATION=alpha\nLOC_IPADDR=172.18.0.11\ndocker run -dit --name $LOCATION img\n' > "$t/hamon/vpn/alpha.sh"
printf 'NAME=beta\nLOC_IPADDR=172.18.0.12\ndocker run --rm -it --name $NAME \\\n  -d --privileged img\n' > "$t/hamon/vpn/beta.sh"
printf 'LOCATION=gammabox\nLOC_IPADDR=172.18.0.15\ndocker run -dit --name $LOCATION img\n' > "$t/hamon/vpn/gamma-v3.sh"
printf 'LOCATION=offbox\nLOC_IPADDR=172.18.0.14\ndocker run -dit --name $LOCATION img\n' > "$t/hamon/vpn/off.sh"
# docker inspect <c> (no -f) and network inspect, as JSON, for --check
docker() {
  case "$1 ${2:-}" in
    "network inspect") echo '[{"Containers":{"x":{"Name":"alpha","IPv4Address":"172.18.0.11/16"},"y":{"Name":"stray","IPv4Address":"172.18.0.40/16"}}}]' ;;
    inspect*) [ -f "$D/$2" ] || return 1; read -r st ip tun < "$D/$2"
      echo "[{\"State\":{\"Status\":\"$st\"},\"NetworkSettings\":{\"Networks\":{\"hamon\":{\"IPAddress\":\"$ip\"}}},\"HostConfig\":{\"PortBindings\":{\"$(cat "$D/$2.port" 2>/dev/null || echo 3980)/udp\":[]}},\"Config\":{}}]" ;;
  esac
}
export -f docker
echo 3880 > "$D/beta.port"; echo 3882 > "$D/gammabox.port"; echo 3882 > "$D/offbox.port"
# python's subprocess can't see the exported function: a docker on PATH that calls it
mkdir -p "$t/bin"; printf '#!/bin/bash\ndocker "$@"\n' > "$t/bin/docker"; chmod +x "$t/bin/docker"
chk() { PATH="$t/bin:$PATH" HAMON="$t/hamon" "$here/utils/vpn-up.sh" --check; }
out=$(chk); rc=$?
echo "$out" | sed 's/^/     /'
check "--check: consistent set passes" '[ $rc = 0 ] && grep -q "4 containers, 4 enabled container sites: consistent" <<< "$out"'
check "--check: disabled-only line and stray container are notes" 'grep -q "note  offbox (172.18.0.14): only disabled sites (offsite)" <<< "$out" && grep -q "note  container stray (172.18.0.40)" <<< "$out"'
cp "$t/hamon/vpn/containers.conf" "$t/conf.bak"
echo "nobox 172.18.0.30 nobox.sh" >> "$t/hamon/vpn/containers.conf"
echo "dup 172.18.0.11 alpha.sh" >> "$t/hamon/vpn/containers.conf"
echo "old 172.18.0.50 old.sh" >> "$t/hamon/vpn/containers.conf"
echo "  z: { name: zeta, dns: 172.18.0.60, port: 3999 }" >> "$t/hamon/hamon.yml"
sed -i 's/LOC_IPADDR=172.18.0.15/LOC_IPADDR=172.18.0.16/' "$t/hamon/vpn/gamma-v3.sh"
printf 'LOCATION=alpha\nLOC_IPADDR=172.18.0.11\ndocker run -it --name $LOCATION img\n' > "$t/hamon/vpn/alpha.sh"
echo 3333 > "$D/gammabox.port"; echo "running 172.18.0.99 yes" > "$D/beta"
out=$(chk); rc=$?
echo "$out" | sed 's/^/     /'
check "--check: problems exit 1" '[ $rc = 1 ]'
check "--check: enabled site missing from conf" 'grep -q "ERROR zeta (172.18.0.60): enabled in hamon.yml but not in containers.conf" <<< "$out"'
check "--check: stale line" 'grep -q "ERROR old (172.18.0.50): no site in hamon.yml uses this address" <<< "$out"'
check "--check: duplicate address" 'grep -q "ERROR address 172.18.0.11 listed twice" <<< "$out"'
check "--check: missing script" 'grep -q "ERROR nobox: script vpn/nobox.sh not found" <<< "$out"'
check "--check: script address differs" 'grep -q "ERROR gammabox: vpn/gamma-v3.sh sets LOC_IPADDR=172.18.0.16" <<< "$out"'
check "--check: not detached" 'grep -q "ERROR alpha: vpn/alpha.sh doesn.t run the container detached" <<< "$out"'
check "--check: container address differs" 'grep -q "ERROR beta: container has address 172.18.0.99" <<< "$out"'
check "--check: port differs" 'grep -q "ERROR gamma: hamon.yml port 3882, container gammabox serves 3333" <<< "$out"'

[ "$fails" = 0 ] && echo "vpn-up.test.sh: all passed" || { echo "vpn-up.test.sh: $fails failed"; exit 1; }
