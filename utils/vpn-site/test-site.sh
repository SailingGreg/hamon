#!/bin/bash
#
# test-site.sh - try a site's OpenVPN profile (set up by add-site.sh) in a
# throwaway container before the real one: does the tunnel come up, which
# LANs does the server route, and which KNX interfaces are on them
#
# The test container is <site>-test: no address on the hamon network, no
# port forward, the site directory mounted read-only, and it stops itself
# after <seconds> (default 120). The real container (vpn/<site>.sh) can run
# at the same time only if the server allows two sessions for the login.
#
# usage: test-site.sh <site> [seconds]
#
# The interface search is utils/vpn-discover.sh, which needs sudo (nsenter).
# It runs when sudo works without a prompt, e.g. primed in the same shell:
#   bash -c 'sudo -S -v && set -- <site> && . utils/vpn-site/test-site.sh'
# otherwise the command to run is printed while the test container is up.
#

set -o nounset

HAMON="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VPN_DIR="${VPN_DIR:-$HAMON/vpn}"
IMAGE=openvpn-tunv2

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <site> [seconds]" >&2
    exit 2
fi
SITE=$1
LIFE=${2:-120}
TEST=$SITE-test
SITEDIR="$VPN_DIR/$SITE"

[ -f "$SITEDIR/$SITE.conf" ] || { echo "$SITE: no $SITEDIR/$SITE.conf - run add-site.sh first" >&2; exit 1; }
if docker inspect "$TEST" >/dev/null 2>&1; then
    echo "$TEST exists - docker rm -f $TEST" >&2
    exit 1
fi

docker run -d --rm --name "$TEST" --cap-add NET_ADMIN --device /dev/net/tun \
    -v "$SITEDIR":/vpn:ro --entrypoint timeout "$IMAGE" \
    "$LIFE" openvpn --cd /vpn --config "/vpn/$SITE.conf" >/dev/null || exit 1
echo "$TEST: started, stops itself after $LIFE s"

up=0
for ((i = 0; i < 60; i++)); do
    sleep 1
    log=$(docker exec "$TEST" cat /var/log/openvpn.log 2>/dev/null) || break
    if grep -q "Initialization Sequence Completed" <<<"$log"; then up=1; break; fi
    grep -qE "AUTH_FAILED|Exiting due to fatal error" <<<"$log" && break
done

if [ "$up" = 0 ]; then
    echo "$SITE: no tunnel after $((i + 1)) s. The last lines of its log:" >&2
    docker exec "$TEST" tail -15 /var/log/openvpn.log 2>/dev/null >&2 ||
        echo "  (the container has gone: docker logs isn't kept with --rm)" >&2
    docker rm -f "$TEST" >/dev/null 2>&1
    exit 1
fi

echo "$SITE: tunnel up after $((i + 1)) s"
push=$(grep -o "PUSH_REPLY,[^']*" <<<"$log" | tail -1)
echo "  pushed: $(tr ',' '\n' <<<"$push" | grep -E '^(route |ifconfig |route-gateway |topology )' | paste -sd ';' | sed 's/;/; /g')"
if ! grep -q '^route ' <<<"$(tr ',' '\n' <<<"$push")"; then
    echo "  warning: no route pushed - the site LAN may not be reachable through this VPN"
fi

if sudo -n true 2>/dev/null; then
    # sourced, not run: over ssh sudo's cached login holds only in this shell.
    # vpn-discover.sh ends with exit, so the test container goes in the trap
    trap 'docker rm -f "$TEST" >/dev/null 2>&1; echo; echo "next: add-site.sh -f -d <the interface'"'"'s LAN address> $SITE (one offering tunnelling; ask the installer if there are several)"' EXIT
    echo "KNX interfaces on the routed LANs:"
    set -- "$TEST"
    . "$HAMON/utils/vpn-discover.sh"
    exit
fi

echo "to find the KNX interface, while $TEST is up (the next $((LIFE - i - 1)) s or so):"
echo "  $HAMON/utils/vpn-discover.sh $TEST     (needs sudo)"
echo "then: add-site.sh -f -d <the interface's LAN address> $SITE"
echo "stop the test early: docker rm -f $TEST"
