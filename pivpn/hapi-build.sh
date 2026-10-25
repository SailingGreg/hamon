#!/usr/bin/env bash
#
# hapi-build.sh  -  build a site Pi on the bench, from the dev Pi.
#
# Flash Raspberry Pi OS Lite 64-bit with Raspberry Pi Imager, with ssh on
# and this machine's public key for the first user (any name). Boot it on
# the bench LAN, find it (./hapi-find.sh), then:
#
#   ./hapi-build.sh [-u <imager-user>] <pi-address>
#
# It copies pivpn/pi to the Pi and runs pi/hapi-install.sh there (packages,
# hapi-<MAC> hostname, pivpn user with the dev Pi's and prod's keys, key-only
# ssh, hapi-agent, setup page, unattended upgrades), then checks the result as
# pivpn and only then removes Imager's passwordless sudo and locks the Imager
# user. Nothing about the site: pivpn/hapi-assign.sh does that.
#
# The pivpn password and the setup code are three random words each, made
# here, sent over ssh on stdin, and recorded in the device register
# (docs/hapi-devices.md: local only, 600). A re-run keeps them; -n makes new
# ones. Re-runs log in as pivpn and use its password for sudo.
#
#   -u <user>   the user Imager created (default pivpn); flashed with a
#               password instead of a key, the first run installs this
#               machine's key with ssh-copy-id (prompts, or SSHPASS=<password>)
#   -n          new password and setup code
#   --ship      instead of building: clear the bench state before it goes to
#               site (gateway choice, forward, Wi-Fi profiles) and re-check
#               the sudo lock-down
#
# PROD (default greg@home.monitor-software.com) is where prod's key comes from.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
REGISTER="${REGISTER:-$HAMON/docs/hapi-devices.md}"
PROD="${PROD:-greg@home.monitor-software.com}"
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

LOGIN=pivpn NEWSECRETS=0 SHIP=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        -u) LOGIN=$2; shift 2 ;;
        -n) NEWSECRETS=1; shift ;;
        --ship) SHIP=1; shift ;;
        -*) echo "usage: $0 [-u <imager-user>] [-n] [--ship] <pi-address>" >&2; exit 2 ;;
        *) break ;;
    esac
done
[ "$#" -eq 1 ] || { echo "usage: $0 [-u <imager-user>] [-n] [--ship] <pi-address>" >&2; exit 2; }
PI=$1
die() { echo "hapi-build: $*" >&2; exit 1; }

# three random lower-case words, like the existing ones
words() {
    grep -E '^[a-z]{4,7}$' /usr/share/dict/words | shuf -n 3 --random-source=/dev/urandom | paste -sd-
}

# a register row's field for a device: 6 = password, 7 = setup code
reg_field() {
    [ -f "$REGISTER" ] || return 0
    awk -F'|' -v d="$1" -v n="$2" '$2 ~ "^ *" d " *$" { f = $(n + 1); gsub(/[ `]/, "", f); print f; exit }' "$REGISTER"
}

# write or replace the device's register row (the table of "| hapi-" lines)
reg_row() {
    local row=$1 dev=$2 tmp at
    [ -f "$REGISTER" ] || die "no register at $REGISTER - the row to add by hand: $row"
    tmp=$(mktemp)
    if grep -q "^| *$dev *|" "$REGISTER"; then
        awk -v d="$dev" -v row="$row" '$0 ~ "^\\| *" d " *\\|" { print row; next } { print }' "$REGISTER" >"$tmp"
    else
        # a new device: after the last device row, or the table's header
        at=$(grep -n '^| *hapi-' "$REGISTER" | tail -1 | cut -d: -f1)
        [ -n "$at" ] || at=$(grep -n '^|---' "$REGISTER" | head -1 | cut -d: -f1)
        [ -n "$at" ] || { rm -f "$tmp"; die "no device table in $REGISTER - the row to add by hand: $row"; }
        awk -v at="$at" -v row="$row" '{ print } NR == at { print row }' "$REGISTER" >"$tmp"
    fi
    cat "$tmp" >"$REGISTER"
    rm -f "$tmp"
    chmod 600 "$REGISTER"
}

# root on the Pi: passwordless (fresh image) or pivpn's password on stdin
as_root() {   # as_root <user> <password-or-empty> <command> ; rest of stdin follows
    local user=$1 pw=$2 cmd=$3
    if [ -z "$pw" ]; then
        ssh "${SSHOPT[@]}" "$user@$PI" "sudo -n bash -c $(printf %q "$cmd")"
    else
        { printf '%s\n' "$pw"; cat; } | ssh "${SSHOPT[@]}" "$user@$PI" "sudo -S -p '' bash -c $(printf %q "$cmd")"
    fi
}

# --- who is it ----------------------------------------------------------------
# an image flashed with a password rather than a key: install this machine's
# key first (asks for the Imager password; or SSHPASS=<it> in the environment)
if ! ssh "${SSHOPT[@]}" "$LOGIN@$PI" true 2>/dev/null; then
    echo "$LOGIN@$PI: no key login yet - installing this machine's key"
    if [ -n "${SSHPASS:-}" ]; then
        sshpass -e ssh-copy-id -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ed25519.pub "$LOGIN@$PI" >/dev/null 2>&1
    elif [ -t 0 ]; then
        ssh-copy-id -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ed25519.pub "$LOGIN@$PI"
    fi
fi
MAC=$(ssh "${SSHOPT[@]}" "$LOGIN@$PI" cat /sys/class/net/eth0/address) ||
    die "can't log in as $LOGIN@$PI with this machine's key (-u for the user Imager created)"
DEV="hapi-$(tr -d : <<<"$MAC" | tail -c 7)"
echo "$PI: $DEV (eth0 $MAC), logged in as $LOGIN"

PW=$(reg_field "$DEV" 6) CODE=$(reg_field "$DEV" 7)

if [ "$SHIP" = 1 ]; then
    [ -n "$PW" ] || die "$DEV isn't in the register - build it first"
    as_root pivpn "$PW" '
        set -e
        rm -f /var/lib/hapi/state.json
        sed -i -E "s/^(gateway_ip|gateway_serial|gateway_mac) *=.*/\1 =/" /etc/hapi/agent.conf
        for c in HAPI-DNAT HAPI-SNAT; do iptables -t nat -F $c 2>/dev/null || true; done
        netfilter-persistent save >/dev/null 2>&1 || true
        # Wi-Fi profiles go only once it is on Ethernet: otherwise this cuts it off
        if [ "$(ip -4 route show default | awk "{print \$5; exit}")" != eth0 ]; then
            echo "still on Wi-Fi (default route not via eth0): Wi-Fi profiles kept - connect Ethernet and run --ship again" >&2
            exit 1
        elif command -v nmcli >/dev/null; then
            nmcli -t -f NAME,TYPE connection show | awk -F: "\$2 ~ /wireless/ {print \$1}" |
                while read -r c; do nmcli connection delete "$c" >/dev/null && echo "removed Wi-Fi profile $c"; done
        fi
        echo "bench gateway choice and forward cleared"' </dev/null
else
    # --- build -------------------------------------------------------------------
    if [ "$NEWSECRETS" = 1 ] || [ -z "$PW" ] || [ -z "$CODE" ]; then
        PW=$(words) CODE=$(words)
        echo "new password and setup code"
    fi
    keys=$(cat ~/.ssh/id_ed25519.pub) || die "no ~/.ssh/id_ed25519.pub here"
    prodkey=$(ssh "${SSHOPT[@]}" "$PROD" cat .ssh/id_ed25519.pub) || die "can't read prod's key from $PROD"
    payload=$(mktemp -d)
    trap 'rm -rf "$payload"' EXIT
    cp "$HERE"/pi/hapi-* "$HERE"/pi/hapi.sudoers "$payload/"
    printf '%s\n%s\n' "$keys" "$prodkey" >"$payload/authorized_keys"
    tar -C "$payload" -cf - . | ssh "${SSHOPT[@]}" "$LOGIN@$PI" 'rm -rf /tmp/hapi-build && mkdir -m 700 /tmp/hapi-build && tar -C /tmp/hapi-build -xf -'

    # a fresh image: passwordless sudo; a re-run: pivpn's password from the register
    sudopw=""
    ssh "${SSHOPT[@]}" "$LOGIN@$PI" 'sudo -n true' 2>/dev/null || sudopw=$(reg_field "$DEV" 6)
    printf '%s\n%s\n' "$PW" "$CODE" |
        as_root "$LOGIN" "$sudopw" 'bash /tmp/hapi-build/hapi-install.sh; rc=$?; rm -rf /tmp/hapi-build; exit $rc'

    model=$(ssh "${SSHOPT[@]}" "pivpn@$PI" "tr -d '\0' </proc/device-tree/model; echo -n ', Debian '; cat /etc/debian_version") ||
        die "pivpn can't log in with this machine's key after the install"
    site=$(reg_field "$DEV" 3) ip=$(reg_field "$DEV" 4)
    reg_row "| $DEV | $MAC | ${site:-} | ${ip:-} | pivpn | \`$PW\` | \`$CODE\` | Built $(date +%F), $model; not assigned to a site yet |" "$DEV"
    echo "register: $REGISTER updated"

    # Imager's passwordless sudo and its user go only now that pivpn works
    as_root pivpn "$PW" "rm -f /etc/sudoers.d/010_pi-nopasswd
        if [ '$LOGIN' != pivpn ] && id '$LOGIN' >/dev/null 2>&1; then
            usermod -L '$LOGIN'; rm -f ~$LOGIN/.ssh/authorized_keys
            echo 'Imager user $LOGIN locked (no password, no ssh keys)'
        fi" </dev/null
fi

# --- checks, as pivpn in a fresh session ------------------------------------------
ssh "${SSHOPT[@]}" "pivpn@$PI" '
    bad=0
    [ "$(ls /etc/sudoers.d | grep -v -e "^README$" -e "^hapi$")" = "" ] || { echo "PROBLEM: extra files in /etc/sudoers.d: $(ls /etc/sudoers.d)"; bad=1; }
    sudo -k; sudo -n true 2>/dev/null && { echo "PROBLEM: sudo works without the password"; bad=1; }
    sudo -n /usr/local/sbin/hapi-agent status >/dev/null || { echo "PROBLEM: passwordless hapi-agent not allowed"; bad=1; }
    for u in hapi-agent.timer hapi-setup ssh; do
        systemctl is-active -q $u || { echo "PROBLEM: $u not running"; bad=1; }
    done
    [ "$(hostname)" = "hapi-$(tr -d : </sys/class/net/eth0/address | tail -c 7)" ] || { echo "PROBLEM: hostname $(hostname)"; bad=1; }
    sshd_pw=$(grep -h "^PasswordAuthentication" /etc/ssh/sshd_config.d/01-hapi.conf)
    [ "$sshd_pw" = "PasswordAuthentication no" ] || { echo "PROBLEM: ssh password login not off"; bad=1; }
    vpn=$(systemctl is-active openvpn-client@pivpn 2>/dev/null || true)
    echo "checks: $([ $bad = 0 ] && echo ok || echo FAILED); VPN profile: $([ "$vpn" = active ] && echo running || echo "not yet (hapi-assign.sh)")"
    exit $bad'

echo
echo "label:  $DEV    setup code: $CODE"
[ "$SHIP" = 1 ] && echo "ready to ship" || echo "next:   ./hapi-assign.sh $PI <site>"
