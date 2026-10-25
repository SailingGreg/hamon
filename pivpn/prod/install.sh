#!/usr/bin/env bash
#
# install.sh  -  the two hapi endpoints on prod: enrolment (/hapi-enrol/) and
# the image download (/hapi-image/). Run on prod as greg, from ~/hamon/pivpn/prod,
# with sudo. Idempotent: re-run after a change to these files.
#
set -euo pipefail
cd "$(dirname "$0")"
site=/etc/nginx/sites-available/grafana.conf

# enrolment service
install -d -m 700 ~/pivpn/enrol ~/pivpn/enrol/pending ~/pivpn/enrol/approved ~/pivpn/enrol/refused
sudo install -m 644 hapi-enrol.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable -q hapi-enrol
sudo systemctl restart hapi-enrol

# image download area (hapi-image.sh --publish writes here) and its logins
sudo install -d -m 755 -o greg -g greg /var/www/hapi-image
[ -f /etc/nginx/hapi-image.htpasswd ] || sudo install -m 640 -o root -g www-data /dev/null /etc/nginx/hapi-image.htpasswd

# nginx: rate-limit zone, the two locations, included once in the 443 server
sudo install -m 644 nginx-hapi-limit.conf /etc/nginx/conf.d/hapi-enrol-limit.conf
sudo install -m 644 nginx-hapi.conf /etc/nginx/snippets/hapi.conf
if ! grep -q 'include snippets/hapi.conf;' "$site"; then
    sudo cp -p "$site" "$site.bak-$(date +%Y%m%d%H%M%S)"
    # before the catch-all "location / {" of the 443 server (the only one)
    sudo sed -i '0,/^    location \/ {$/s//    include snippets\/hapi.conf;\n\n    location \/ {/' "$site"
fi
sudo nginx -t
sudo systemctl reload nginx
echo "hapi endpoints installed: https://$(hostname -f)/hapi-enrol/ and /hapi-image/"
