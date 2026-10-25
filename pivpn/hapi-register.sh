# hapi-register.sh  -  shared by the hapi scripts (sourced, not run): where prod is,
# and the site Pi device register.
#
# The scripts run on prod or on the dev Pi. On prod (it has ~/pivpn/pki) they
# work locally; elsewhere they reach prod over ssh. Everything they keep lives
# on prod - nothing operational depends on the dev Pi, which is only needed for
# bench work on its own LAN (fresh cards, the fake gateway) and image builds.
#
# The register: prod's ~/pivpn/hapi-devices.md (mode 600, not in git, in the
# nightly backup). It holds secrets: each Pi's pivpn password and setup code,
# and the image download logins. Two tables:
#
#   the device table   one row per Pi, its current state:
#     | Device | eth0 MAC | Site (VPN client) | Tunnel IP | User | Password | Setup page login | Status |
#   ## Builds          one row per build / assign / approve / --ship run:
#     | Date | Device | Step | hamon | Model, OS | ssh host key (ED25519) | VPN certificate | Setup code |
#
# The ssh keys put on every box (pivpn's authorized_keys): prod's
# ~/pivpn/hapi-authorized_keys.
#
# The caller sets PROD, SSHOPT (for prod) and PIOPT (for the Pi) and defines die().

if [ -d "$HOME/pivpn/pki" ]; then ON_PROD=1; else ON_PROD=0; fi

# run a command line on prod, like `ssh prod <command>`: locally when on prod
onprod() {
    if [ "$ON_PROD" = 1 ]; then
        bash -c "cd ~ && $*"
    else
        ssh "${SSHOPT[@]}" "$PROD" "$@"
    fi
}
# run the script on stdin on prod with these arguments, each passed exactly
onprod_script() {
    onprod "bash -s -- $(printf '%q ' "$@")"
}

# a device row's field: 2 = MAC, 3 = site, 4 = tunnel IP, 6 = password, 7 = setup code
reg_field() {
    onprod_script "$1" "$2" <<'EOF'
f=~/pivpn/hapi-devices.md
[ -f "$f" ] || exit 0
awk -F'|' -v d="$1" -v n="$2" '$2 ~ "^ *" d " *$" { f = $(n + 1); gsub(/[ `]/, "", f); print f; exit }' "$f"
EOF
}

# write or replace the device's row in the device table
reg_row() {   # reg_row <row> <device>
    onprod_script "$1" "$2" <<'EOF' || die "updating the register on prod failed"
set -e
row=$1 dev=$2 f=~/pivpn/hapi-devices.md
[ -f "$f" ] || { echo "no register at $f" >&2; exit 1; }
tmp=$(mktemp)
if grep -q "^| *$dev *|" "$f"; then
    awk -v d="$dev" -v row="$row" '$0 ~ "^\\| *" d " *\\|" { print row; next } { print }' "$f" >"$tmp"
else
    # a new device: after the last device row, or the table's header
    at=$(grep -n '^| *hapi-' "$f" | tail -1 | cut -d: -f1)
    [ -n "$at" ] || at=$(grep -n '^|---' "$f" | head -1 | cut -d: -f1)
    [ -n "$at" ] || { rm -f "$tmp"; echo "no device table in $f" >&2; exit 1; }
    awk -v at="$at" -v row="$row" '{ print } NR == at { print row }' "$f" >"$tmp"
fi
cat "$tmp" >"$f"; rm -f "$tmp"; chmod 600 "$f"
EOF
}

# set a device row's site, tunnel IP and status (keeps the "Built ..." part)
reg_assign() {   # reg_assign <device> <site> <ip> <status>
    onprod_script "$1" "$2" "$3" "$4" <<'EOF' || die "updating the register on prod failed"
set -e
f=~/pivpn/hapi-devices.md tmp=$(mktemp)
awk -F'|' -v OFS='|' -v d="$1" -v s=" $2 " -v ip=" $3 " -v st="$4" '
    $2 ~ "^ *" d " *$" { $4 = s; $5 = ip
                         if (match($9, /Built [^|]*/)) $9 = substr($9, RSTART, RLENGTH); else $9 = ""
                         sub(/; not assigned to a site yet/, "", $9); sub(/ +$/, "", $9)
                         $9 = " " st ($9 != "" ? "; " $9 : "") " " }
    { print }' "$f" >"$tmp"
cat "$tmp" >"$f"; rm -f "$tmp"; chmod 600 "$f"
EOF
}

# the Pi's ssh host key fingerprint (ED25519, SHA256), as ssh shows it
reg_hostkey() {   # reg_hostkey <user@pi>
    ssh "${PIOPT[@]}" "$1" 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' 2>/dev/null | awk '{print $2}'
}

# a site's VPN client certificate on prod: "CN, serial S, expires DATE"
reg_vpncert() {   # reg_vpncert <site>
    [ -n "$1" ] || return 0
    onprod "openssl x509 -in ~/pivpn/pki/issued/$1.crt -noout -subject -serial -enddate" 2>/dev/null | awk -F= '
        /^subject/ { cn = $NF; gsub(/^ +/, "", cn) }
        /^serial/  { sn = substr($2, 1, 8) }
        /^notAfter/ { split($2, d, " "); until = d[4] "-" d[1] "-" d[2] }
        END { if (cn != "") printf "%s, serial %s.., expires %s", cn, sn, until }'
}

# add a row to the Builds table (made at the end of the file the first time)
reg_build() {   # reg_build <device> <step> <model-os> <hostkey> <vpncert> <code>
    local commit
    commit=$(git -C "$HAMON" rev-parse --short HEAD 2>/dev/null)$(git -C "$HAMON" diff --quiet HEAD -- pivpn 2>/dev/null || echo "+changes")
    onprod_script "| $(date '+%F %H:%M') | $1 | $2 | ${commit:--} | ${3:--} | \`${4:--}\` | ${5:--} | \`${6:--}\` |" <<'EOF' || die "updating the register on prod failed"
set -e
f=~/pivpn/hapi-devices.md
[ -f "$f" ] || exit 0
if ! grep -q '^## Builds' "$f"; then
    printf '\n## Builds\n\nOne row per build / assign / approve / --ship run (written by the scripts).\n\n%s\n%s\n' \
        '| Date | Device | Step | hamon | Model, OS | ssh host key (ED25519) | VPN certificate | Setup code |' \
        '|---|---|---|---|---|---|---|---|' >>"$f"
fi
tmp=$(mktemp)
awk -v row="$1" '
    { line[NR] = $0 }
    /^## Builds/ { inb = 1 }
    inb && /^\|/ { last = NR }
    inb && /^## / && !/^## Builds/ { inb = 0 }
    END { for (i = 1; i <= NR; i++) { print line[i]; if (i == last) print row } }' "$f" >"$tmp"
cat "$tmp" >"$f"; rm -f "$tmp"; chmod 600 "$f"
EOF
}

# kept for the callers: the register is written on prod directly now
reg_push() {
    echo "register updated (prod ~/pivpn/hapi-devices.md)"
}

# the ssh keys every box gets for pivpn
authorized_keys() {
    onprod "cat ~/pivpn/hapi-authorized_keys" 2>/dev/null | grep '^ssh-' || die "no keys in prod's ~/pivpn/hapi-authorized_keys"
}
