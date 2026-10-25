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
# (docs/hapi-devices.md: local only, 600, copied to prod; see
# hapi-register.sh), with a Builds row per run: ssh host key fingerprint,
# VPN certificate, setup code. A re-run keeps them; -n makes new ones. Re-runs log in as pivpn and use its password for sudo.
#
#   -u <user>   the user Imager created (default pivpn); flashed with a
#               password instead of a key, the first run installs this
#               machine's key with ssh-copy-id (prompts, or SSHPASS=<password>)
#   -n          new password and setup code
#   --ship      instead of building: clear the bench state before it goes to
#               site (gateway choice, forward, Wi-Fi profiles, the bench Wi-Fi
#               and Imager passwords in the boot partition's cloud-init seed)
#               and re-check the sudo lock-down
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

. "$HERE/hapi-register.sh"

# root on the Pi: passwordless (fresh image) or pivpn's password on stdin
as_root() {   # as_root <user> <password-or-empty> <command> ; rest of stdin follows
    local user=$1 pw=$2 cmd=$3
    if [ -z "$pw" ]; then
        ssh "${SSHOPT[@]}" "$user@$PI" "sudo -n bash -c $(printf %q "$cmd")"
    else
        { printf '%s\n' "$pw"; cat; } | ssh "${SSHOPT[@]}" "$user@$PI" "sudo -S -p '' bash -c $(printf %q "$cmd")"
    fi
}

model_os() {
    ssh "${SSHOPT[@]}" "pivpn@$PI" "tr -d '\0' </proc/device-tree/model; echo -n ', Debian '; cat /etc/debian_version"
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
        # on Wi-Fi and Ethernet in the same LAN avahi hears itself and renames the
        # box <name>-2.local; on Ethernet alone a restart gives it its name back
        systemctl restart avahi-daemon
        # Imager'"'"'s cloud-init seed holds the bench Wi-Fi password and the
        # Imager user'"'"'s password hash: wired DHCP only, nothing else
        if [ -f /boot/firmware/network-config ]; then
            printf "%s\n" "network:" "  version: 2" "  ethernets:" "    eth0:" "      dhcp4: true" "      optional: true" >/boot/firmware/network-config
        fi
        if [ -f /boot/firmware/user-data ]; then
            printf "%s\n" "#cloud-config" "# cleared by hapi-build.sh --ship; cloud-init is disabled on this box" >/boot/firmware/user-data
        fi
        [ -d /etc/cloud ] && touch /etc/cloud/cloud-init.disabled
        echo "bench gateway choice and forward cleared; Imager seed scrubbed"' </dev/null
    reg_build "$DEV" ship "$(model_os)" "$(reg_hostkey "pivpn@$PI")" "$(reg_vpncert "$(reg_field "$DEV" 3)")" "$CODE"
    reg_push
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

    # sudo on the Pi: passwordless (older Imager images), else pivpn's password
    # from the register (a re-run) or the Imager user's password (a fresh image:
    # SSHPASS, or asked for)
    sudopw=""
    if ! ssh "${SSHOPT[@]}" "$LOGIN@$PI" 'sudo -n true' 2>/dev/null; then
        if [ "$LOGIN" = pivpn ] && [ -n "$(reg_field "$DEV" 6)" ]; then
            sudopw=$(reg_field "$DEV" 6)
        elif [ -n "${SSHPASS:-}" ]; then
            sudopw=$SSHPASS
        elif [ -t 0 ]; then
            read -rsp "sudo password for $LOGIN@$PI: " sudopw; echo
        else
            die "sudo on the Pi needs $LOGIN's password: run from a terminal or set SSHPASS"
        fi
    fi
    printf '%s\n%s\n' "$PW" "$CODE" |
        as_root "$LOGIN" "$sudopw" 'bash /tmp/hapi-build/hapi-install.sh; rc=$?; rm -rf /tmp/hapi-build; exit $rc'

    model=$(model_os) || die "pivpn can't log in with this machine's key after the install"
    site=$(reg_field "$DEV" 3) ip=$(reg_field "$DEV" 4)
    status="Built $(date +%F), $model; not assigned to a site yet"
    [ -z "$site" ] || status="Assigned to $site; Built $(date +%F), $model"
    reg_row "| $DEV | $MAC | ${site:-} | ${ip:-} | pivpn | \`$PW\` | \`$CODE\` | $status |" "$DEV"
    reg_build "$DEV" build "$model" "$(reg_hostkey "pivpn@$PI")" "$(reg_vpncert "$site")" "$CODE"
    reg_push

    # Imager's passwordless sudo and its user go only now that pivpn works
    as_root pivpn "$PW" "rm -f /etc/sudoers.d/010_pi-nopasswd
        if [ '$LOGIN' != pivpn ] && id '$LOGIN' >/dev/null 2>&1; then
            usermod -L '$LOGIN'; rm -f ~$LOGIN/.ssh/authorized_keys
            echo 'Imager user $LOGIN locked (no password, no ssh keys)'
        fi" </dev/null
fi

# --- checks ----------------------------------------------------------------------
# sudoers: only hapi may grant anything without a password. The Raspberry Pi
# OS files (010_global-tty, 010_proxy, ...) only set Defaults; Imager's
# 010_pi-nopasswd must be gone. The files are root-only, so as root
nopw=$(as_root pivpn "$PW" 'ls /etc/sudoers.d/010_pi-nopasswd 2>/dev/null
    grep -l NOPASSWD /etc/sudoers.d/* | grep -vx /etc/sudoers.d/hapi; true' </dev/null)
[ -z "$nopw" ] || echo "PROBLEM: passwordless sudo from $(echo $nopw)"
# the rest as pivpn in a fresh session
ssh "${SSHOPT[@]}" "pivpn@$PI" '
    bad=0
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
    exit $bad' && [ -z "$nopw" ]

echo
"$HERE/hapi-label.sh" "$DEV" || echo "(no label image: see hapi-label.sh)"
echo "label:  $DEV    setup code: $CODE"
[ "$SHIP" = 1 ] && echo "ready to ship" || echo "next:   ./hapi-assign.sh $PI <site>"
