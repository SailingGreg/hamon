#!/usr/bin/env bash
#
# hapi-label.sh  -  print-ready label for a site Pi, from the device register.
#
#   ./hapi-label.sh <hapi-xxxxxx>
#
# Writes docs/labels/<device>.png (local only, mode 600: it carries the setup
# code) at 300 dpi, 62 x 29 mm (Brother DK-22205 / DK-11209 style; LABEL_MM=WxH
# for another size): the hostname, the setup page address with a QR code of it,
# and the setup code. The QR holds only the address, not the code.
# hapi-build.sh makes it after every build and --ship.
#
# Needs qrencode and ImageMagick (convert).
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
PROD="${PROD:-greg@home.monitor-software.com}"         # holds the device register
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10)
OUTDIR="${OUTDIR:-}"
LABEL_MM="${LABEL_MM:-62x29}"
DPI=300

[ "$#" -eq 1 ] || { echo "usage: $0 <hapi-xxxxxx>" >&2; exit 2; }
DEV=$1
die() { echo "hapi-label: $*" >&2; exit 1; }
. "$HERE/hapi-register.sh"
command -v qrencode >/dev/null || die "needs qrencode (apt install qrencode)"
[ -n "$OUTDIR" ] || { [ "$ON_PROD" = 1 ] && OUTDIR=~/pivpn/labels || OUTDIR="$HAMON/docs/labels"; }

CODE=$(reg_field "$DEV" 7)
[ -n "$CODE" ] || die "$DEV has no setup code in the register (prod ~/pivpn/hapi-devices.md)"
URL="http://$DEV.local/"

w_mm=${LABEL_MM%x*} h_mm=${LABEL_MM#*x}
W=$((w_mm * DPI * 10 / 254)) H=$((h_mm * DPI * 10 / 254))
Q=$((H - 20))                        # QR square incl. its 2-module quiet zone
font=$(fc-match -f '%{file}' 'DejaVu Sans:bold' 2>/dev/null || true)
mono=$(fc-match -f '%{file}' 'DejaVu Sans Mono' 2>/dev/null || true)

umask 077
mkdir -p "$OUTDIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
qrencode -l M -m 2 -s 10 -o "$tmp/qr.png" "$URL"
# SVG everywhere (print it from a browser at 100 %, or with any label software)
svg="$OUTDIR/$DEV.svg"
tx=$((Q + 45)) tw=$((W - Q - 60))
qr64=$(base64 -w0 "$tmp/qr.png")
{
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="%smm" height="%smm" viewBox="0 0 %s %s">\n' "$w_mm" "$h_mm" "$W" "$H"
  printf '<rect width="100%%" height="100%%" fill="#fff"/>\n'
  printf '<image x="10" y="10" width="%s" height="%s" style="image-rendering:pixelated" href="data:image/png;base64,%s"/>\n' "$Q" "$Q" "$qr64"
  printf '<g font-family="DejaVu Sans, Arial, sans-serif" fill="#000">\n'
  printf '<text x="%s" y="%s" font-size="%s" font-weight="bold">%s</text>\n' "$tx" $((H * 26 / 100)) $((H * 17 / 100)) "$DEV"
  printf '<text x="%s" y="%s" font-size="%s" font-family="DejaVu Sans Mono, monospace">%s</text>\n' "$tx" $((H * 48 / 100)) $((H * 10 / 100)) "$DEV.local"
  printf '<text x="%s" y="%s" font-size="%s" font-family="DejaVu Sans Mono, monospace">setup code</text>\n' "$tx" $((H * 67 / 100)) $((H * 9 / 100))
  printf '<text x="%s" y="%s" font-size="%s" font-weight="bold">%s</text>\n' "$tx" $((H * 88 / 100)) $((H * 12 / 100)) "$CODE"
  printf '</g></svg>\n'
} >"$svg"
chmod 600 "$svg"
if ! command -v convert >/dev/null; then
    echo "label: $svg (${LABEL_MM} mm, $URL, setup code)"
    exit 0
fi

out="$OUTDIR/$DEV.png"
convert -size "${W}x${H}" xc:white -units PixelsPerInch -density $DPI \
    \( "$tmp/qr.png" -filter point -resize "${Q}x${Q}" \) -geometry +10+10 -composite \
    -fill black -font "${font:-DejaVu-Sans-Bold}" \
    \( -background white -size "${tw}x$((H * 30 / 100))" -gravity west label:"$DEV" \) -gravity northwest -geometry +$tx+18 -composite \
    -font "${mono:-DejaVu-Sans-Mono}" \
    \( -background white -size "${tw}x$((H * 15 / 100))" -gravity west label:"$DEV.local" \) -gravity northwest -geometry +$tx+$((H * 38 / 100)) -composite \
    \( -background white -size "${tw}x$((H * 12 / 100))" -gravity west label:"setup code" \) -gravity northwest -geometry +$tx+$((H * 58 / 100)) -composite \
    -font "${font:-DejaVu-Sans-Bold}" \
    \( -background white -size "${tw}x$((H * 20 / 100))" -gravity west label:"$CODE" \) -gravity northwest -geometry +$tx+$((H * 72 / 100)) -composite \
    "$out"
chmod 600 "$out"
echo "label: $out and $svg (${LABEL_MM} mm, $URL, setup code)"
