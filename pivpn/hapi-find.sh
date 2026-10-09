#! /usr/bin/env bash
#
# hapi-find.sh  -  list the Raspberry Pis on this LAN and their hapi-<MAC> names.
#
# For bench prep: run on a machine on the same network as freshly imaged Pis
# (e.g. the dev Pi).  A site Pi names itself hapi-<last 6 hex of its eth0 MAC>
# (pi/hapi-hostname.sh), so the name can be worked out from the MAC before
# anything else is known.  This sweeps the subnet, picks out Raspberry Pi MACs
# from the neighbour table, and for each shows the expected name and whether
# the box already answers to it over mDNS (<name>.local), ssh and the setup page.
#
#   ./hapi-find.sh                 # the subnet of the default-route interface
#   ./hapi-find.sh 192.168.1.0/24  # another subnet (must be directly attached)
#
# Needs nmap (for the sweep), curl, and libnss-mdns for the .local check.  No root.
# "not yet" under mDNS usually means the hostname unit isn't installed (fresh
# image still called raspberrypi); a Pi on Wi-Fi shows its wlan0 MAC, which
# doesn't give the eth0-based name.

set -euo pipefail

# Raspberry Pi OUIs: b8:27:eb (Pi 1-3), dc:a6:32 / e4:5f:01 / 28:cd:c1 (Pi 4,
# 400, CM4), d8:3a:dd / 2c:cf:67 / 88:a2:9e (Pi 5, CM5, later Pi 4 batches)
OUIS='^(b8:27:eb|dc:a6:32|e4:5f:01|28:cd:c1|d8:3a:dd|2c:cf:67|88:a2:9e):'

field_after() { awk -v k="$1" '{for (i = 1; i < NF; i++) if ($i == k) {print $(i + 1); exit}}'; }

if [ $# -gt 0 ]; then
  subnet=$1
  route=$(ip -4 -o route get "${subnet%/*}")
  if grep -q ' via ' <<<"$route"; then
    echo "$subnet is reached through a router; MACs (and so names) are only visible on a directly attached network" >&2
    exit 1
  fi
  dev=$(field_after dev <<<"$route")
else
  dev=$(ip -4 route show default | field_after dev)
  subnet=$(ip -4 -o addr show dev "$dev" | awk '{print $4; exit}')
fi
[ -n "$subnet" ] && [ -n "$dev" ] || { echo "no subnet: pass one, e.g. $0 192.168.1.0/24" >&2; exit 1; }
command -v nmap >/dev/null || { echo "needs nmap (apt install nmap)" >&2; exit 1; }

echo "sweeping $subnet ..." >&2
nmap -sn -n -T5 --max-retries 1 "$subnet" >/dev/null 2>&1 || true   # fills the neighbour table

port_open() {   # host port -> 0 if a TCP connect succeeds within 1 s
  timeout 1 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

printf '%-16s %-18s %-13s %-9s %-4s %s\n' IP MAC "EXPECTED NAME" MDNS SSH "SETUP PAGE"
found=0
while read -r ip mac; do
  name="hapi-$(tr -d ':' <<<"$mac" | tail -c 7)"
  if [ "$(getent hosts "$name.local" | awk '{print $1; exit}')" = "$ip" ]; then
    mdns=yes
  else
    mdns="not yet"
  fi
  ssh=no;   port_open "$ip" 22 && ssh=yes
  setup=no
  if curl -s -m 2 -o /dev/null -D - "http://$ip/" | grep -qi '^server: hapi-setup'; then
    if [ "$mdns" = yes ]; then setup="http://$name.local/"; else setup="http://$ip/"; fi
  fi
  printf '%-16s %-18s %-13s %-9s %-4s %s\n' "$ip" "$mac" "$name" "$mdns" "$ssh" "$setup"
  found=$((found + 1))
done < <(ip neigh show dev "$dev" | awk '{for (i = 2; i < NF; i++) if ($i == "lladdr") print $1, tolower($(i + 1))}' \
           | grep -E " ${OUIS#^}" | sort -t . -k 4 -n)

[ "$found" -gt 0 ] || echo "no Raspberry Pis seen on $subnet (is the Pi wired to this network and booted?)" >&2
