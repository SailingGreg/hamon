#! /usr/bin/env bash
#
# setup.sh  -  install Node-RED for hamon automation as a Docker container.
#
# Node-RED publishes to hamon's MQTT command topics (knx/<site>/<g>/<a>/<d>/write)
# on the local mosquitto, so a flow can switch KNX devices on a schedule.  The
# editor listens on 127.0.0.1 only and is published through nginx with TLS at
# /nodered/ (location block below); it always requires a login.
#
# Idempotent: an existing password, settings.js or flows.json is kept, and an
# existing container is left alone.
#
#   ./setup.sh            # as the user that will own the data (greg)
#
# nginx (inside the 443 server block, then nginx -t && systemctl reload nginx):
#   location = /nodered { return 301 /nodered/; }
#   location /nodered/ {
#       proxy_pass http://127.0.0.1:1880;
#       proxy_set_header Host $host;
#       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#       proxy_set_header X-Forwarded-Proto $scheme;
#       proxy_http_version 1.1;
#       proxy_set_header Upgrade $http_upgrade;
#       proxy_set_header Connection $connection_upgrade;   # needs the usual map
#   }

set -euo pipefail

IMAGE="${IMAGE:-nodered/node-red:4.1}"
NAME="${NAME:-nodered}"
BASE="${BASE:-$HOME/node-red}"
DATA="$BASE/data"
PWFILE="$BASE/.admin-password"
HERE="$(cd "$(dirname "$0")" && pwd)"

umask 077
mkdir -p "$DATA"
docker pull -q "$IMAGE" >/dev/null

if [ ! -s "$PWFILE" ]; then
  openssl rand -base64 18 | tr -d '/+=' > "$PWFILE"
  echo "new admin password written to $PWFILE"
fi

if [ ! -f "$DATA/settings.js" ]; then
  hash=$(docker run --rm -i --entrypoint node "$IMAGE" -e '
    const p = require("fs").readFileSync(0, "utf8").trim();
    console.log(require("/usr/src/node-red/node_modules/bcryptjs").hashSync(p, 8));
  ' < "$PWFILE")
  secret=$(openssl rand -hex 24)
  sed -e "s|@CREDENTIAL_SECRET@|$secret|" -e "s|@ADMIN_HASH@|$hash|" \
      "$HERE/settings.js.template" > "$DATA/settings.js"
  echo "wrote $DATA/settings.js"
fi

if [ ! -f "$DATA/flows.json" ]; then
  cp "$HERE/flows-sample.json" "$DATA/flows.json"
  echo "installed sample flow (placeholder topic knx/poc/... - nothing listens)"
fi

if docker inspect "$NAME" >/dev/null 2>&1; then
  echo "container $NAME already exists - left as is"
else
  docker run -d --name "$NAME" --restart unless-stopped --network host \
    --user "$(id -u):$(id -g)" -v "$DATA:/data" "$IMAGE" >/dev/null
  echo "started container $NAME ($IMAGE)"
fi
