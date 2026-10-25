#!/usr/bin/env bash
#
# hapi-image-user.sh  -  logins for the image download (/hapi-image/) on prod.
#
#   ./hapi-image-user.sh <name>          add or reset: prints a new password (three words)
#   ./hapi-image-user.sh -d <name>       remove
#   ./hapi-image-user.sh -l              list
#
# One login per integrator, so one can be removed without the others. The
# image holds no secrets; the login keeps it from being public. Needs sudo.
#
set -euo pipefail
F=/etc/nginx/hapi-image.htpasswd
case "${1:-}" in
    -l) sudo cut -d: -f1 "$F"; exit 0 ;;
    -d) [ -n "${2:-}" ] || { echo "usage: $0 -d <name>" >&2; exit 2; }
        sudo sed -i "/^$2:/d" "$F" && echo "removed $2"; exit 0 ;;
    ""|-*) echo "usage: $0 <name> | -d <name> | -l" >&2; exit 2 ;;
esac
name=$1
[[ $name =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || { echo "names are lower-case letters, digits, _ . -" >&2; exit 2; }
pw=$(grep -E '^[a-z]{4,7}$' /usr/share/dict/words 2>/dev/null | shuf -n 3 --random-source=/dev/urandom | paste -sd- -)
[ -n "$pw" ] || pw=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
line="$name:$(openssl passwd -apr1 "$pw")"
tmp=$(mktemp)
sudo grep -v "^$name:" "$F" >"$tmp" || true
echo "$line" >>"$tmp"
sudo install -m 640 -o root -g www-data "$tmp" "$F"
rm -f "$tmp"
echo "login for $name: password $pw"
echo "download: https://$(hostname -f)/hapi-image/"
