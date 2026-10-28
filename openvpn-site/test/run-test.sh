#!/bin/bash
#
# run-test.sh - test the openvpn-site image against two stand-in sites on a
# private docker network: tun over UDP, and tap over TCP with DHCP on the far
# side. Nothing else is touched (own network, containers ovs-*), so it can run
# on the server next to the real site containers. Run from the repo root:
#
#   openvpn-site/test/run-test.sh [image]     (default: builds openvpn-site:test)
#
# For each site, through the container's forward (UDP + TCP) to the fake KNX
# interface, after: the first connect, docker restart, SIGUSR1 (as
# vpn-reconnect.sh), the server restarting (a VPN blip), and openvpn being
# killed (the container must restart itself). tap also: the DHCP address, and
# no default route or DNS taken from it.

set -o nounset
here=$(cd "$(dirname "$0")" && pwd)
image=${1:-}
work=$(mktemp -d)
net=ovs-test
fails=0

say() { echo "$(date +%T) $*"; }
pass() { say "PASS $*"; }
fail() { say "FAIL $*"; fails=$((fails + 1)); }

cleanup() {
    docker rm -f ovs-tun ovs-tap ovs-srv-tun ovs-srv-tap >/dev/null 2>&1
    docker network rm $net >/dev/null 2>&1
    rm -rf "$work"
}
trap cleanup EXIT
cleanup; work=$(mktemp -d)

if [ -z "$image" ]; then
    image=openvpn-site:test
    docker build -q -t $image "$here/.." >/dev/null || { echo "build failed"; exit 1; }
fi
say "image $image: $(docker run --rm --entrypoint openvpn $image --version | head -1 | cut -d' ' -f1-2)"

# a throwaway CA, server and client certificates
docker build -q -t ovs-test-server -f - "$here" >/dev/null <<'EOF' || { echo "server build failed"; exit 1; }
FROM alpine:3.23
RUN apk --no-cache --no-progress add openvpn easy-rsa dnsmasq socat
COPY server.sh /usr/local/bin/
EOF
# as the host user, so the files are ours (the profiles are written below) and cleanup can remove them
docker run --rm --user "$(id -u):$(id -g)" -v "$work":/w -e EASYRSA_BATCH=1 -e EASYRSA_PKI=/w/pki ovs-test-server sh -c '
    cd /w && /usr/share/easy-rsa/easyrsa init-pki >/dev/null 2>&1 &&
    /usr/share/easy-rsa/easyrsa --req-cn=ovs-ca build-ca nopass >/dev/null 2>&1 &&
    /usr/share/easy-rsa/easyrsa build-server-full server nopass >/dev/null 2>&1 &&
    /usr/share/easy-rsa/easyrsa build-client-full client nopass >/dev/null 2>&1 &&
    mkdir -p srv && cp pki/ca.crt pki/issued/server.crt pki/private/server.key srv/ &&
    for m in tun tap; do mkdir -p $m && cp pki/ca.crt pki/issued/client.crt pki/private/client.key $m/; done &&
    chmod -R a+rX /w' || { echo "PKI failed"; exit 1; }
[ -f "$work/tun/client.key" ] || { echo "PKI failed: no client key"; exit 1; }

docker network create --subnet 10.199.0.0/24 $net >/dev/null
for m in tun tap; do
    docker run -d --name ovs-srv-$m --net $net --cap-add NET_ADMIN --device /dev/net/tun \
        -v "$work/srv":/pki:ro -e MODE=$m --entrypoint /usr/local/bin/server.sh ovs-test-server >/dev/null
done

# the site profiles, as utils/vpn-site/add-site.sh writes them (log + status)
cat > "$work/tun/site.conf" <<EOF
client
dev tun
proto udp
remote ovs-srv-tun 1194
nobind
persist-key
persist-tun
remote-cert-tls server
ca ca.crt
cert client.crt
key client.key
verb 3
log /var/log/openvpn.log
status /var/log/openvpn.stat
EOF
sed -e 's/^dev tun/dev tap/' -e 's/^proto udp/proto tcp-client/' -e 's/ovs-srv-tun/ovs-srv-tap/' \
    "$work/tun/site.conf" > "$work/tap/site.conf"

# the site containers, run as the vpn/*.sh launchers do
declare -A IP=([tun]=10.199.0.21 [tap]=10.199.0.22) DEST=([tun]=10.98.0.1 [tap]=192.168.77.1)
for m in tun tap; do
    docker run -dit --restart on-failure --privileged --name ovs-$m --net $net --ip ${IP[$m]} \
        -v "$work/$m":/vpn -e VPN_REMOTEDEST=${DEST[$m]} -e VPN_REMOTEPORT=3671 -e CONT_PORT=3891 \
        $image >/dev/null
done

inits() { docker exec ovs-$1 grep -c "Initialization Sequence Completed" /var/log/openvpn.log 2>/dev/null || echo 0; }

# wait until the site has more than $2 completed connects and its interface an address
wait_up() { local m=$1 before=$2 i
    for ((i = 0; i < 90; i++)); do
        [ "$(inits $m)" -gt "$before" ] &&
            docker exec ovs-$m sh -c 'ip -4 addr show dev $(cat /run/vpn-ifname) | grep -q inet' 2>/dev/null &&
            { echo $i; return 0; }
        sleep 1
    done
    return 1
}

# UDP and TCP through the forward; the fake KNX interface must see the site's VPN address
probe() { local m=$1 what=$2 vip out
    vip=$(docker exec ovs-$m sh -c 'ip -4 -o addr show dev $(cat /run/vpn-ifname)' | awk '{print $4}' | cut -d/ -f1)
    out=$(python3 - "${IP[$m]}" 3891 <<'PY'
import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
res = []
for kind in ("udp", "tcp"):
    try:
        if kind == "udp":
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
            s.sendto(b"ping-udp\n", (host, port)); r = s.recv(200)
        else:
            s = socket.create_connection((host, port), timeout=3)
            s.sendall(b"ping-tcp\n"); r = s.recv(200)
        res.append(r.decode().strip())
    except Exception as e:
        res.append(f"{kind} ERROR {e}")
print("|".join(res))
PY
)
    if [ "$out" = "KNX-ECHO $vip ping-udp|KNX-ECHO $vip ping-tcp" ]; then
        pass "$m $what: udp+tcp forward ok (gateway sees $vip)"
    else
        fail "$m $what: '$out' (expected from $vip)"
    fi
}

step() { local m=$1 what=$2 before=$3 t
    if t=$(wait_up $m $before); then probe $m "$what (up in ${t}s)"
    else fail "$m $what: not up in 90 s"; docker exec ovs-$m tail -5 /var/log/openvpn.log; fi
}

for m in tun tap; do step $m "first connect" 0; done

# tap: a DHCP address, but no route or DNS from the site
r=$(docker exec ovs-tap sh -c 'ip -4 -o addr show dev tap0 | awk "{print \$4}"; ip route | grep default; grep nameserver /etc/resolv.conf')
if grep -q "^192.168.77.1[0-5][0-9]/24" <<<"$r" && grep -q "default via 10.199.0.1 dev eth0" <<<"$r" &&
   grep -q "nameserver 127.0.0.11" <<<"$r"; then
    pass "tap DHCP: $(head -1 <<<"$r"), default route + DNS unchanged"
else
    fail "tap DHCP/route/DNS: $(tr '\n' ' ' <<<"$r")"
fi
# what the other tools read
for m in tun tap; do
    docker exec ovs-$m iptables -t nat -S PREROUTING | grep -q "DNAT --to-destination ${DEST[$m]}:3671" &&
        docker exec ovs-$m ping -c 3 -i 0.5 -W 2 ${DEST[$m]} >/dev/null &&
        pass "$m: iptables -S shows the forward (vpn-discover), ping through the tunnel (vpn-probe)" ||
        fail "$m: iptables -S / ping"
done

for m in tun tap; do
    n=$(inits $m); docker restart ovs-$m >/dev/null; step $m "docker restart" 0
    n=$(inits $m); docker exec ovs-$m pkill -USR1 -x openvpn; step $m "SIGUSR1 (vpn-reconnect)" $n
    n=$(inits $m); docker restart ovs-srv-$m >/dev/null; step $m "server restart (blip)" $n
    rc=$(docker inspect -f '{{.RestartCount}}' ovs-$m)
    docker exec ovs-$m pkill -KILL -x openvpn; sleep 3; step $m "openvpn killed" 0
    [ "$(docker inspect -f '{{.RestartCount}}' ovs-$m)" -gt "$rc" ] &&
        pass "$m: container restarted itself after openvpn died" || fail "$m: no restart after openvpn died"
done

for m in tun tap; do
    for ((i = 0; i < 90; i++)); do
        h=$(docker inspect -f '{{.State.Health.Status}}' ovs-$m); [ "$h" = healthy ] && break; sleep 2
    done
    [ "$h" = healthy ] && pass "$m: healthcheck healthy" || fail "$m: healthcheck $h"
done

say "$([ $fails -eq 0 ] && echo "all PASS" || echo "$fails FAIL")"
exit $((fails > 0))
