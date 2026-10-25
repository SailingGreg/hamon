# hapi-register.sh  -  the site Pi device register, for hapi-build.sh and hapi-assign.sh
# (sourced, not run).
#
# The register is a Markdown file kept locally ($REGISTER, default
# docs/hapi-devices.md: not in git, mode 600) and copied to prod's
# ~/pivpn/hapi-devices.md (in the nightly backup). It holds secrets: each Pi's
# pivpn password and setup code. Two tables:
#
#   the device table   one row per Pi, its current state:
#     | Device | eth0 MAC | Site (VPN client) | Tunnel IP | User | Password | Setup page login | Status |
#   ## Builds          one row per hapi-build / hapi-assign / --ship run:
#     | Date | Device | Step | hamon | Model, OS | ssh host key (ED25519) | VPN certificate | Setup code |
#
# The caller sets REGISTER, PROD and SSHOPT and defines die().

# a device row's field: 2 = MAC, 3 = site, 4 = tunnel IP, 6 = password, 7 = setup code
reg_field() {
    [ -f "$REGISTER" ] || return 0
    awk -F'|' -v d="$1" -v n="$2" '$2 ~ "^ *" d " *$" { f = $(n + 1); gsub(/[ `]/, "", f); print f; exit }' "$REGISTER"
}

# replace a file's content in place (keeps the file and its mode 600)
reg_replace() {
    cat "$1" >"$REGISTER"
    rm -f "$1"
    chmod 600 "$REGISTER"
}

# write or replace the device's row in the device table
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
    reg_replace "$tmp"
}

# set a device row's site, tunnel IP and status
reg_assign() {   # reg_assign <device> <site> <ip> <status>
    local tmp
    tmp=$(mktemp)
    awk -F'|' -v OFS='|' -v d="$1" -v s=" $2 " -v ip=" $3 " -v st="$4" '
        $2 ~ "^ *" d " *$" { $4 = s; $5 = ip
                             sub(/^ *Assigned to [^;]*; */, "", $9); sub(/; not assigned to a site yet/, "", $9); sub(/ +$/, "", $9)
                             $9 = " " st "; " $9 " " }
        { print }' "$REGISTER" >"$tmp"
    reg_replace "$tmp"
}

# the Pi's ssh host key fingerprint (ED25519, SHA256), as ssh shows it
reg_hostkey() {   # reg_hostkey <user@pi>
    ssh "${SSHOPT[@]}" "$1" 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' 2>/dev/null | awk '{print $2}'
}

# a site's VPN client certificate on prod: "CN, serial S, expires DATE"
reg_vpncert() {   # reg_vpncert <site>
    [ -n "$1" ] || return 0
    ssh "${SSHOPT[@]}" "$PROD" "openssl x509 -in pivpn/pki/issued/$1.crt -noout -subject -serial -enddate" 2>/dev/null | awk -F= '
        /^subject/ { cn = $NF; gsub(/^ +/, "", cn) }
        /^serial/  { sn = substr($2, 1, 8) }
        /^notAfter/ { split($2, d, " "); until = d[4] "-" d[1] "-" d[2] }
        END { if (cn != "") printf "%s, serial %s.., expires %s", cn, sn, until }'
}

# add a row to the Builds table (made at the end of the file the first time)
reg_build() {   # reg_build <device> <step> <model-os> <hostkey> <vpncert> <code>
    local tmp commit
    [ -f "$REGISTER" ] || return 0
    commit=$(git -C "$HAMON" rev-parse --short HEAD 2>/dev/null)$(git -C "$HAMON" diff --quiet HEAD -- pivpn 2>/dev/null || echo "+changes")
    if ! grep -q '^## Builds' "$REGISTER"; then
        printf '\n## Builds\n\nOne row per hapi-build / hapi-assign / --ship run (written by the scripts).\n\n%s\n%s\n' \
            '| Date | Device | Step | hamon | Model, OS | ssh host key (ED25519) | VPN certificate | Setup code |' \
            '|---|---|---|---|---|---|---|---|' >>"$REGISTER"
    fi
    tmp=$(mktemp)
    # after the last row of the Builds table
    awk -v row="| $(date '+%F %H:%M') | $1 | $2 | ${commit:--} | ${3:--} | \`${4:--}\` | ${5:--} | \`${6:--}\` |" '
        { line[NR] = $0 }
        /^## Builds/ { inb = 1 }
        inb && /^\|/ { last = NR }
        inb && /^## / && !/^## Builds/ { inb = 0 }
        END { for (i = 1; i <= NR; i++) { print line[i]; if (i == last) print row } }' "$REGISTER" >"$tmp"
    reg_replace "$tmp"
}

# copy the register to prod (in its nightly backup)
reg_push() {
    scp -q "${SSHOPT[@]}" "$REGISTER" "$PROD:pivpn/hapi-devices.md" &&
        ssh "${SSHOPT[@]}" "$PROD" chmod 600 pivpn/hapi-devices.md &&
        echo "register updated here and copied to prod"
}
