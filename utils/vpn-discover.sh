#!/bin/bash
#
# vpn-discover.sh - find the KNXnet/IP devices on a VPN site's LAN
#
# Runs knxdesc.py --sweep inside the site's VPN container's network (the
# only place the site LAN is routed), over each LAN the VPN server pushed a
# route for. Read-only: one DESCRIPTION_REQUEST per address on UDP 3671, no
# tunnel slot used. Multicast SEARCH doesn't cross a routed VPN; this does.
#
# usage: vpn-discover.sh <container> [CIDR ...]
#   container  the site's VPN container (docker ps), e.g. one started by
#              ~/hamon/vpn/<site>.sh
#   CIDR       sweep these instead of the routes the VPN pushed
#
# Needs sudo (nsenter into the container's network namespace) and python3
# on the host, not in the container: nsenter runs the host's python3 in the
# container's network, so the VPN images stay as they are. Over a
# non-interactive ssh, prime sudo in the same shell and source the script:
#   bash -c 'sudo -S -v && set -- <container> && . utils/vpn-discover.sh'
# Exit status is 1 if nothing replied.
#

set -o nounset

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <container> [CIDR ...]" >&2
    exit 2
fi
CONTAINER=$1; shift
KNXDESC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/knxdesc.py"

PID=$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null)
if [ -z "$PID" ] || [ "$PID" = 0 ]; then
    echo "$CONTAINER: no such running container" >&2
    exit 2
fi

# the site LANs: routes via a gateway on the tunnel (not the tunnel's own
# subnet, not the default route)
if [ "$#" -gt 0 ]; then
    NETS="$*"
else
    NETS=$(docker exec "$CONTAINER" ip -4 route |
           awk '$1 != "default" && / via / && /dev (tun|tap|ppp)/ {print $1}')
fi
if [ -z "$NETS" ]; then
    echo "$CONTAINER: no VPN routes to sweep (is the tunnel up?)" >&2
    exit 2
fi

rc=1
for net in $NETS; do
    echo "== $CONTAINER: $net"
    sudo nsenter -t "$PID" -n python3 "$KNXDESC" --sweep "$net" && rc=0
done
exit $rc
