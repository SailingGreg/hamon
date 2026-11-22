#!/bin/bash
#
# vpn-up.sh - bring every VPN container that an enabled hamon.yml site needs
# up, and wait for its tunnel. Run at boot by hamon-vpn.service (before
# ha-mon), and by hand after maintenance: it is safe to run at any time.
#
# Which containers: the enabled sites with a container address (dns: 172.18.*)
# in hamon.yml, matched by that address to a line in vpn/containers.conf:
#
#     <container> <address> <script that creates it, in vpn/>
#
# (names don't always match the site, and two sites can share a container,
# so the address is the join). For each container:
#   running             left alone (a stuck tunnel is hamon's to restart)
#   stopped / created   docker start
#   missing             the script creates it (an L2TP container runs with
#                       --rm, so it is gone after a reboot)
# then wait up to WAIT s for each to show its tunnel (a tun/tap/ppp
# interface). One still without it is reported and left to hamon's back-off.
#
# Exit 0 unless the config can't be read: a site that won't come up must not
# stop ha-mon starting.
#
# usage: utils/vpn-up.sh [-n] [--only <address>]
#                                 -n: say what it would do, change nothing
#                                 --only: just the container at that address
#                                 (hamon's ladder, when no running container
#                                 holds a site's address: stopped or missing)
#        utils/vpn-up.sh --check  is containers.conf consistent with hamon.yml,
#                                 the scripts and docker? Changes nothing;
#                                 exit 1 if anything is wrong
# env:   HAMON (default the checkout this script is in), CONF, WAIT (120)

set -u
HAMON="${HAMON:-$(cd "$(dirname "$0")/.." && pwd)}"
CONF="${CONF:-$HAMON/vpn/containers.conf}"
YML="${YML:-$HAMON/hamon.yml}"
WAIT="${WAIT:-120}"
DRY=0; CHECK=0; ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        -n) DRY=1 ;;
        --check) CHECK=1 ;;
        --only) ONLY="${2:-}"; shift
                [ -n "$ONLY" ] || { echo "vpn-up: --only needs an address" >&2; exit 1; } ;;
        *) echo "vpn-up: unknown argument $1" >&2; exit 1 ;;
    esac
    shift
done

say() { echo "vpn-up: $*"; }

[ -f "$CONF" ] || { say "no $CONF - nothing to bring up"; exit 1; }

# ---- --check: containers.conf against hamon.yml, the scripts and docker -----
if [ "$CHECK" = 1 ]; then
    python3 - "$CONF" "$YML" "$HAMON/vpn" <<'PY'
import json, os, re, subprocess, sys, yaml
conf, yml, vdir = sys.argv[1:4]
errs, notes = [], []
def err(m): errs.append(m)
def note(m): notes.append(m)

# hamon.yml container sites (172.18.*), enabled or not
sites = {}   # ip -> [(name, port, enabled)]
for l in ((yaml.safe_load(open(yml)) or {}).get("locations") or {}).values():
    dns = str(l.get("dns", ""))
    if dns.startswith("172.18."):
        sites.setdefault(dns, []).append((str(l.get("name")), str(l.get("port", "")), l.get("enabled", True) is not False))

# containers.conf
lines, names, ips = [], {}, {}
for n, raw in enumerate(open(conf), 1):
    f = raw.split("#", 1)[0].split()
    if not f: continue
    if len(f) < 3: err(f"containers.conf line {n}: needs <container> <address> <script>: {raw.strip()}"); continue
    c, ip, script = f[:3]
    if c in names: err(f"container {c} listed twice (lines {names[c]} and {n})")
    if ip in ips: err(f"address {ip} listed twice ({ips[ip]} and {c}): one container per address")
    names[c], ips[ip] = n, c
    lines.append((c, ip, script))

def docker(*a):
    try: return subprocess.run(["docker", *a], capture_output=True, text=True, timeout=20)
    except Exception: return None

for c, ip, script in lines:
    users = sites.get(ip, [])
    on = [s for s in users if s[2]]
    if not users: err(f"{c} ({ip}): no site in hamon.yml uses this address - stale line?")
    elif not on: note(f"{c} ({ip}): only disabled sites ({', '.join(s[0] for s in users)}) - not brought up")
    path = os.path.join(vdir, script)
    if not os.path.isfile(path):
        err(f"{c}: script vpn/{script} not found")
    else:
        text = open(path).read()
        sip = re.findall(r'^\s*LOC_IPADDR=["\']?([0-9.]+)', text, re.M)
        if sip and sip[0] != ip: err(f"{c}: vpn/{script} sets LOC_IPADDR={sip[0]}, containers.conf says {ip}")
        if not sip: note(f"{c}: vpn/{script} has no LOC_IPADDR= line to check against")
        sname = re.findall(r'^\s*(?:LOCATION|NAME)=["\']?([A-Za-z0-9_.-]+)', text, re.M)
        if sname and c not in sname: err(f"{c}: vpn/{script} names its container {sname[0]}")
        cmd = re.sub(r'\\\n', ' ', text)
        for run in re.findall(r'^\s*docker run\b.*$', cmd, re.M):
            if not any(t == '--detach' or re.fullmatch(r'-[a-zA-Z]*d[a-zA-Z]*', t) for t in run.split()):
                err(f"{c}: vpn/{script} doesn't run the container detached (-d)")
    r = docker("inspect", c)
    if r is None or r.returncode != 0:
        if on: note(f"{c} ({ip}): no container now - vpn-up creates it")
        continue
    d = json.loads(r.stdout)[0]
    got = [n.get("IPAddress") for n in d["NetworkSettings"]["Networks"].values()]
    if ip not in got: err(f"{c}: container has address {', '.join(filter(None, got)) or 'none'}, containers.conf says {ip}")
    bound = {k.split("/")[0] for k in (d["HostConfig"].get("PortBindings") or {})}
    exposed = {k.split("/")[0] for k in (d["Config"].get("ExposedPorts") or {})}
    for name, port, en in on:
        if port and bound | exposed and port not in bound | exposed:
            err(f"{name}: hamon.yml port {port}, container {c} serves {', '.join(sorted(bound | exposed))}")
    st = d["State"]["Status"]
    if on and st not in ("running", "restarting"): note(f"{c}: {st} - vpn-up starts it")

for ip, users in sorted(sites.items()):
    on = [s[0] for s in users if s[2]]
    if on and ip not in ips: err(f"{', '.join(on)} ({ip}): enabled in hamon.yml but not in containers.conf")

# containers on the hamon network not in containers.conf
r = docker("network", "inspect", "hamon")
if r is not None and r.returncode == 0:
    for v in (json.loads(r.stdout)[0].get("Containers") or {}).values():
        ip = v.get("IPv4Address", "").split("/")[0]
        if v.get("Name") not in names:
            note(f"container {v.get('Name')} ({ip}) on the hamon network isn't in containers.conf")

for m in errs: print("vpn-up: ERROR", m)
for m in notes: print("vpn-up: note ", m)
print(f"vpn-up: {len(lines)} containers, {sum(1 for u in sites.values() for s in u if s[2])} enabled container sites: "
      + ("consistent" if not errs else f"{len(errs)} problem(s)"))
sys.exit(1 if errs else 0)
PY
    exit $?
fi

# enabled container sites: "<address> <site>"
sites=$(python3 - "$YML" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1])) or {}
for l in (d.get("locations") or {}).values():
    dns = str(l.get("dns", ""))
    if dns.startswith("172.18.") and l.get("enabled", True) is not False:
        print(dns, l.get("name"))
PY
) || { say "can't read $YML"; exit 1; }

declare -A NAME=() SCRIPT=() SITES=()
while read -r c ip script _; do
    [[ -z "$c" || "$c" == \#* ]] && continue
    NAME["$ip"]="$c"; SCRIPT["$ip"]="$script"
done < "$CONF"
while read -r ip site; do
    [ -n "$ip" ] && SITES["$ip"]="${SITES[$ip]:+${SITES[$ip]},}$site"
done <<< "$sites"

tunnel() { docker exec "$1" ip -o link 2>/dev/null | grep -qE '^[0-9]+: (tun|tap|ppp)[0-9]+'; }

if [ -n "$ONLY" ] && [ -z "${SITES[$ONLY]:-}" ]; then
    say "$ONLY: no enabled container site at this address - nothing to bring up"
    exit 0
fi

want=()
for ip in $(printf '%s\n' "${!SITES[@]}" | sort -t. -k4 -n); do
    [ -n "$ONLY" ] && [ "$ip" != "$ONLY" ] && continue
    c="${NAME[$ip]:-}"
    if [ -z "$c" ]; then
        say "${SITES[$ip]} ($ip): no container in $(basename "$CONF") - not started"
        continue
    fi
    # (docker inspect prints an empty line for a missing container before failing)
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null) || state=missing
    case "$state" in
        running)
            say "$c ($ip, ${SITES[$ip]}): running" ;;
        missing)
            s="$HAMON/vpn/${SCRIPT[$ip]}"
            if [ ! -f "$s" ]; then say "$c ($ip, ${SITES[$ip]}): missing, and no $s"; continue; fi
            say "$c ($ip, ${SITES[$ip]}): missing - creating with ${SCRIPT[$ip]}"
            if [ "$DRY" = 0 ]; then
                (cd "$HAMON/vpn" && bash "$s" </dev/null >/dev/null 2>&1)
                docker inspect "$c" >/dev/null 2>&1 || { say "$c: ${SCRIPT[$ip]} didn't create it"; continue; }
            fi ;;
        *)
            say "$c ($ip, ${SITES[$ip]}): $state - starting"
            [ "$DRY" = 0 ] && { docker start "$c" >/dev/null 2>&1 || { say "$c: docker start failed"; continue; }; } ;;
    esac
    # a running container whose address isn't the one hamon.yml uses can't serve it
    if [ "$DRY" = 0 ]; then
        got=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$c" 2>/dev/null)
        [[ " $got " == *" $ip "* ]] || say "$c: has address ${got:-none}, hamon.yml expects $ip"
    fi
    want+=("$c")
done

[ "$DRY" = 1 ] && exit 0
[ ${#want[@]} = 0 ] && { say "no containers to wait for"; exit 0; }

# wait for the tunnels
end=$((SECONDS + WAIT)); left=("${want[@]}")
while [ ${#left[@]} -gt 0 ] && [ $SECONDS -lt $end ]; do
    next=()
    for c in "${left[@]}"; do tunnel "$c" || next+=("$c"); done
    left=("${next[@]}")
    [ ${#left[@]} -gt 0 ] && sleep 3
done
up=$(( ${#want[@]} - ${#left[@]} ))
if [ ${#left[@]} = 0 ]; then
    say "all $up tunnels up in ${SECONDS}s"
else
    say "$up of ${#want[@]} tunnels up after ${WAIT}s; still waiting: ${left[*]} (left to hamon's back-off)"
fi
exit 0
