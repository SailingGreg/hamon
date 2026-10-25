#!/usr/bin/env bash
#
# hapi-image.sh  -  build the HAMON site box image, on devserver (arm64).
#
#   ./hapi-image.sh [<raspios-lite-arm64.img.xz>]
#
# Takes the official Raspberry Pi OS Lite 64-bit image (the latest from
# downloads.raspberrypi.com, checked against its SHA-256 and cached, unless a
# file is given), and in a chroot of it - natively, devserver is arm64 - runs
# pi/hapi-install.sh in image mode (HAPI_IMAGE=1): our packages and software,
# the pivpn user with the dev Pi's and prod's ssh keys and no password,
# key-only ssh, and a temporary passwordless sudo for pivpn (hapi-adopt) until
# a box is adopted. Then: Raspberry Pi OS's first-boot user wizard off, the
# placeholder pi user removed, ssh host keys and machine-id cleared (each box
# makes its own on first boot), caches emptied, and a check that nothing secret
# or box-specific is left.
#
# Output in $OUT (default ~/hapi-image/out):
#   hamon-hapi-YYYYMMDD.img.xz      write it with Raspberry Pi Imager (Use custom)
#   hamon-hapi-YYYYMMDD.img.xz.sha256
#   os_list.json                    an Imager repository entry for it
#
# A box from this image is adopted like any other: ./hapi-build.sh <ip> on the
# bench (or, from phase 2 of docs/hapi-image.md, by hapi-approve). Needs sudo,
# xz, parted, e2fsprogs, zerofree and curl; about 8 GB free in $WORK.
#
# PROD (default greg@home.monitor-software.com): where prod's ssh key comes from.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
PROD="${PROD:-greg@home.monitor-software.com}"
BASE="${BASE:-$HOME/hapi-image}"
WORK="${WORK:-$BASE/work}" CACHE="${CACHE:-$BASE/cache}" OUT="${OUT:-$BASE/out}"
LATEST=https://downloads.raspberrypi.com/raspios_lite_arm64_latest
GROW_MB=768
STAMP=$(date +%Y%m%d)
NAME="hamon-hapi-$STAMP"

die() { echo "hapi-image: $*" >&2; exit 1; }
step() { echo "== $*"; }
[ "$(uname -m)" = aarch64 ] || die "build on an arm64 machine (devserver): the chroot runs the image's own binaries"
PATH=$PATH:/usr/sbin:/sbin
for t in xz parted e2fsck resize2fs zerofree curl losetup; do
    command -v "$t" >/dev/null || die "needs $t"
done
sudo -n true 2>/dev/null || die "needs sudo without a prompt (run sudo -v first)"
mkdir -p "$WORK" "$CACHE" "$OUT"

# --- 1. base image ---------------------------------------------------------------
if [ "$#" -ge 1 ]; then
    SRC=$1
    [ -f "$SRC" ] || die "no $SRC"
else
    step "base image: the latest Raspberry Pi OS Lite 64-bit"
    url=$(curl -sSI "$LATEST" | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r')
    [ -n "$url" ] || die "can't resolve $LATEST"
    SRC="$CACHE/$(basename "$url")"
    if [ ! -f "$SRC" ]; then
        curl -sSL -o "$SRC.part" "$url" && mv "$SRC.part" "$SRC"
    fi
    curl -sSL -o "$SRC.sha256" "$url.sha256"
    (cd "$CACHE" && sha256sum -c --quiet "$(basename "$SRC").sha256") || die "checksum mismatch for $SRC"
fi
echo "   $(basename "$SRC")"

# --- 2. working copy, grown for our packages -----------------------------------------
step "working copy (+${GROW_MB} MB)"
IMG="$WORK/$NAME.img"
xz -dc "$SRC" >"$IMG"
truncate -s "+${GROW_MB}M" "$IMG"
sudo parted -s "$IMG" resizepart 2 100%
LOOP=$(sudo losetup -fP --show "$IMG")
MNT="$WORK/mnt"
cleanup() {
    set +e
    for m in dev/pts dev proc sys boot/firmware ""; do
        mountpoint -q "$MNT/$m" && sudo umount "$MNT/$m"
    done
    [ -n "${LOOP:-}" ] && sudo losetup -d "$LOOP" 2>/dev/null
}
trap cleanup EXIT
sudo e2fsck -pf "${LOOP}p2" >/dev/null
sudo resize2fs -p "${LOOP}p2" >/dev/null 2>&1
sudo mkdir -p "$MNT"
sudo mount "${LOOP}p2" "$MNT"
sudo mount "${LOOP}p1" "$MNT/boot/firmware"
for m in dev dev/pts proc sys; do sudo mount --bind "/$m" "$MNT/$m"; done

# --- 3. our install, in image mode ----------------------------------------------------
step "install (chroot, image mode)"
keys=$(cat ~/.ssh/id_ed25519.pub) || die "no ~/.ssh/id_ed25519.pub"
prodkey=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD" cat .ssh/id_ed25519.pub) || die "can't read prod's key from $PROD"
sudo mkdir -p "$MNT/tmp/hapi-build"
sudo cp "$HERE"/pi/hapi-* "$HERE"/pi/hapi.sudoers "$MNT/tmp/hapi-build/"
printf '%s\n%s\n' "$keys" "$prodkey" | sudo tee "$MNT/tmp/hapi-build/authorized_keys" >/dev/null
# DNS for apt inside the chroot, and no daemons started by package scripts
sudo cp -a "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
sudo rm -f "$MNT/etc/resolv.conf"
sudo cp /etc/resolv.conf "$MNT/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' | sudo tee "$MNT/usr/sbin/policy-rc.d" >/dev/null
sudo chmod 755 "$MNT/usr/sbin/policy-rc.d"
sudo chroot "$MNT" env HAPI_IMAGE=1 LC_ALL=C bash /tmp/hapi-build/hapi-install.sh

step "first boot: no user wizard, no placeholder user"
sudo chroot "$MNT" sh -c '
    systemctl disable -q userconfig.service 2>/dev/null || true
    if id pi >/dev/null 2>&1; then userdel -r pi 2>/dev/null || userdel pi; fi
    true'
commit=$(git -C "$HAMON" rev-parse --short HEAD 2>/dev/null)$(git -C "$HAMON" diff --quiet HEAD -- pivpn 2>/dev/null || echo "+changes")
printf 'image=%s\nbase=%s\nhamon=%s\nbuilt=%s\n' "$NAME" "$(basename "$SRC")" "${commit:-?}" "$(date -u '+%F %T UTC')" |
    sudo tee "$MNT/etc/hapi/image" >/dev/null

# --- 4. clean up for cloning -----------------------------------------------------------
step "clean up (host keys, machine-id, caches, logs)"
sudo rm -f "$MNT/usr/sbin/policy-rc.d"
sudo rm -f "$MNT/etc/resolv.conf"
[ -e "$WORK/resolv.conf.orig" ] || [ -L "$WORK/resolv.conf.orig" ] && sudo cp -a "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"
sudo rm -f "$WORK/resolv.conf.orig"
sudo chroot "$MNT" sh -c '
    rm -rf /tmp/hapi-build /var/lib/apt/lists/* /var/cache/apt/*.bin /var/cache/apt/archives/*.deb
    rm -f /etc/ssh/ssh_host_* /root/.bash_history /var/lib/dbus/machine-id
    : >/etc/machine-id
    find /var/log -type f -exec truncate -s 0 {} +
    true'

step "check: nothing secret or box-specific left"
bad=0
check() { if ! eval "$2"; then echo "   PROBLEM: $1"; bad=1; fi; }
check "ssh host keys present" "[ -z \"\$(ls $MNT/etc/ssh/ssh_host_* 2>/dev/null)\" ]"
check "machine-id not empty" "[ ! -s $MNT/etc/machine-id ]"
check "a setup code is set" "[ ! -e $MNT/etc/hapi/setup-code ]"
check "a VPN profile is present" "[ -z \"\$(ls $MNT/etc/openvpn/client/ 2>/dev/null)\" ]"
check "pivpn has a password" "sudo grep -q '^pivpn:!' $MNT/etc/shadow"
check "hapi-adopt missing" "sudo test -f $MNT/etc/sudoers.d/hapi-adopt"
check "pivpn's keys missing" "[ \"\$(sudo grep -c ssh- $MNT/home/pivpn/.ssh/authorized_keys)\" = 2 ]"
check "ssh password login not off" "sudo grep -q '^PasswordAuthentication no' $MNT/etc/ssh/sshd_config.d/01-hapi.conf"
check "cloud-init not disabled" "[ -e $MNT/etc/cloud/cloud-init.disabled ]"
check "user wizard still enabled" "[ ! -e $MNT/etc/systemd/system/multi-user.target.wants/userconfig.service ]"
check "pi user still there" "! grep -q '^pi:' $MNT/etc/passwd"
check "host key regeneration not enabled" "sudo chroot $MNT systemctl is-enabled -q regenerate_ssh_host_keys.service"
check "image stamp missing" "[ -s $MNT/etc/hapi/image ]"
[ "$bad" = 0 ] || die "image check failed - nothing written to $OUT"
echo "   ok"

# --- 5. pack ------------------------------------------------------------------------------
step "pack"
cleanup
LOOP=$(sudo losetup -fP --show "$IMG")
sudo e2fsck -pf "${LOOP}p2" >/dev/null
sudo zerofree "${LOOP}p2"       # free blocks to zeros: smaller download
sudo losetup -d "$LOOP"; LOOP=""
xz -T0 -6 -c "$IMG" >"$OUT/$NAME.img.xz"
rm -f "$IMG"
(cd "$OUT" && sha256sum "$NAME.img.xz" >"$NAME.img.xz.sha256")
size=$(stat -c %s "$OUT/$NAME.img.xz")
extract_size=$(xz --robot -l "$OUT/$NAME.img.xz" | awk '$1 == "totals" { print $5 }')
cat >"$OUT/os_list.json" <<EOF
{
  "os_list": [
    {
      "name": "HAMON site box ($STAMP)",
      "description": "Raspberry Pi OS Lite 64-bit with the HAMON site box software. Plug into the site network; we approve it remotely. Don't apply OS customisation.",
      "url": "$NAME.img.xz",
      "extract_size": $extract_size,
      "image_download_size": $size,
      "extract_sha256": "",
      "release_date": "$(date +%F)",
      "devices": ["pi3-64bit", "pi4-64bit", "pi5-64bit"]
    }
  ]
}
EOF
echo
echo "image: $OUT/$NAME.img.xz ($(( size / 1048576 )) MB; $(cut -c1-16 "$OUT/$NAME.img.xz.sha256")...)"
echo "next:  write it with Raspberry Pi Imager (Use custom), boot a bench Pi, ./hapi-build.sh <ip>"
