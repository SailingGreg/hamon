#! /usr/bin/env bash
#
# setup.sh  -  run the Pi-VPN OpenVPN server (docs/pi-vpn.md) as a container.
#
# Site Pis dial out to this server; each gets a fixed tunnel IP 10.86.0.N (its
# ccd file), which is the site's KNX endpoint for hamon (dns: 10.86.0.N).  The
# container uses the host network, so the `pivpn` tun and 10.86.0.0/16 appear
# on the host and hamon reaches the Pis directly.  UDP 1194 must be reachable.
#
#   ./setup.sh <public-host> [ca-name]      # as the user that owns the data (greg)
#
# Data (config, PKI incl. the CA key, ccd, client configs) lives in DATA
# (default ~/pivpn, 0700), owned by this user; the server drops to the same uid
# after start-up.  It belongs in the nightly backup.
#
# Add a site Pi (prints the path of its inline .ovpn):
#   docker exec --user "$(id -u)" pivpn-server pivpn-add <name> 10.86.0.N [10.100.N.0]
# Revoke: easyrsa revoke + gen-crl in the container (as the same user), then
#   remove ccd/<name>; the server re-reads the CRL on each connection.
#
# Idempotent: an existing image tag is rebuilt (cheap), existing PKI/config is
# kept, and an existing container is left alone.

set -euo pipefail

PUBLIC_HOST=${1:?usage: $0 <public-host> [ca-name]}
CA_NAME=${2:-pivpn-ca}
IMAGE="${IMAGE:-openvpn-pivpn}"
NAME="${NAME:-pivpn-server}"
DATA="${DATA:-$HOME/pivpn}"
HERE="$(cd "$(dirname "$0")" && pwd)"

install -d -m 0700 "$DATA"
docker build -q -t "$IMAGE" --build-arg PIVPN_UID="$(id -u)" "$HERE" >/dev/null
echo "built $IMAGE ($(docker run --rm "$IMAGE" openvpn --version | head -1 | cut -d' ' -f1-2))"

docker run --rm --user "$(id -u):$(id -g)" -v "$DATA:/etc/pivpn" "$IMAGE" \
  pivpn-init "$CA_NAME" "$PUBLIC_HOST"

if docker inspect "$NAME" >/dev/null 2>&1; then
  echo "container $NAME already exists - left as is"
else
  docker run -d --name "$NAME" --restart unless-stopped --network host \
    --cap-add NET_ADMIN --device /dev/net/tun -v "$DATA:/etc/pivpn" "$IMAGE" >/dev/null
  echo "started container $NAME"
fi
