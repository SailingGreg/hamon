#! /usr/bin/env bash
#
# hapi-hostname.sh  -  name a site Pi hapi-<last 3 bytes of the eth0 MAC>.
#
# The eth0 MAC is burned in and present even when the Pi runs on Wi-Fi, so the
# name is unique per board and survives re-imaging; it is the device identity,
# while the site it serves is recorded centrally (e.g. site X uses hapi-1a2b3c).
# Run at every boot by hapi-hostname.service: a no-op when already correct, and
# a card moved to another board renames itself.

set -euo pipefail

mac=$(cat /sys/class/net/eth0/address)
hex=${mac//:/}
name="hapi-${hex: -6}"
old=$(hostname)

[ "$old" = "$name" ] && exit 0

hostnamectl set-hostname "$name"
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$name/" /etc/hosts
else
  printf '127.0.1.1\t%s\n' "$name" >> /etc/hosts
fi
# re-announce over mDNS as <name>.local
# --no-block: avahi is ordered after this unit, so waiting would deadlock
systemctl --no-block try-restart avahi-daemon 2>/dev/null || true
echo "hostname $old -> $name (eth0 $mac)"
