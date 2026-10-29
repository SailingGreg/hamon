#!/usr/bin/env bash
#
# hapi-sheet.sh  -  one-page A4 install sheet for a site Pi, for the installer.
#
#   ./hapi-sheet.sh <hapi-xxxxxx>
#
# Writes <device>-install.html, and .pdf where chromium is installed (the dev
# Pi), in ~/pivpn/labels on prod or docs/labels elsewhere (mode 600: it carries
# the setup code): what to bring, the steps to plug it in, and the setup page with
# a QR code of its address and the setup code. Site-neutral: the sheet names
# the box, not the site. hapi-build.sh makes it after every build and --ship,
# next to the label; send it to the installer yourself.
#
# Needs qrencode; chromium (headless) for the PDF.
#

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAMON="$(dirname "$HERE")"
PROD="${PROD:-greg@home.monitor-software.com}"         # holds the device register
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=10)
OUTDIR="${OUTDIR:-}"

[ "$#" -eq 1 ] || { echo "usage: $0 <hapi-xxxxxx>" >&2; exit 2; }
DEV=$1
die() { echo "hapi-sheet: $*" >&2; exit 1; }
. "$HERE/hapi-register.sh"
command -v qrencode >/dev/null || die "needs qrencode (apt install qrencode)"
CHROMIUM=$(command -v chromium || command -v chromium-browser || true)   # PDF only where present
[ -n "$OUTDIR" ] || { [ "$ON_PROD" = 1 ] && OUTDIR=~/pivpn/labels || OUTDIR="$HAMON/docs/labels"; }

CODE=$(reg_field "$DEV" 7)
[ -n "$CODE" ] || die "$DEV has no setup code in the register (prod ~/pivpn/hapi-devices.md)"
URL="http://$DEV.local/"

umask 077
mkdir -p "$OUTDIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
qr=$(qrencode -l M -m 2 -t SVG "$URL" | sed '1d')   # inline SVG, no XML declaration

cat >"$tmp/sheet.html" <<EOF
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>$DEV install</title>
<style>
  @page { size: A4; margin: 12mm 15mm; }
  body { font: 10pt/1.35 "DejaVu Sans", sans-serif; color: #111; margin: 0; }
  h1 { font-size: 19pt; margin: 0 0 2mm; }
  h2 { font-size: 12pt; margin: 4mm 0 1.5mm; border-bottom: 1px solid #bbb; padding-bottom: 1mm; }
  .sub { color: #444; margin: 0 0 3mm; }
  ol { margin: 0; padding-left: 6mm; } li { margin: 0 0 1.2mm; }
  ul { margin: 0.5mm 0 0; padding-left: 5mm; }
  .need { display: grid; grid-template-columns: 40mm 1fr; gap: 0.6mm 3mm; }
  .need b { font-weight: 600; }
  .setup { display: grid; grid-template-columns: 42mm 1fr; gap: 6mm; align-items: center;
           border: 1.5px solid #111; border-radius: 3mm; padding: 4mm; margin-top: 2mm; }
  .setup svg { width: 42mm; height: 42mm; display: block; }
  .mono { font-family: "DejaVu Sans Mono", monospace; }
  .code { font: 600 15pt "DejaVu Sans Mono", monospace; letter-spacing: 0.3px; }
  .k { color: #444; font-size: 9.5pt; margin-top: 2mm; }
  .note { font-size: 9.5pt; color: #333; }
  .msg { font-family: "DejaVu Sans Mono", monospace; background: #f2f2f2; padding: 1.5mm 2.5mm; border-radius: 1.5mm; }
  .foot { margin-top: 4mm; font-size: 8.5pt; color: #555; border-top: 1px solid #ccc; padding-top: 1.5mm; }
</style></head><body>

<h1>HAMON site box <span class="mono">$DEV</span></h1>
<p class="sub">Installation sheet. One network cable and power; nothing to set up on the box itself. We check everything remotely while you are there.</p>

<h2>What you need</h2>
<div class="need">
  <b>The box</b><span>labelled <span class="mono">$DEV</span>, and its power supply (USB, 5 V 2.5 A)</span>
  <b>A network cable</b><span>long enough to reach the router or switch the KNX IP gateway is on</span>
  <b>A laptop or phone</b><span>only if you need the setup page (below)</span>
  <b>About 20 minutes</b><span>mostly waiting while we check</span>
</div>

<h2>On site</h2>
<ol>
  <li><b>Find where the KNX IP gateway is connected.</b> The box must be on the same network: a free port on the same router or switch is easiest. Avoid a guest network or a separate camera/TV port.</li>
  <li><b>Plug in the network cable</b>, from the box's network socket to that port. Wi-Fi is not used.</li>
  <li><b>Plug in the power.</b> Red light steady = power good; green light flickers for a minute while it starts; network socket lights on = cable live. No screen, keyboard or power button.</li>
  <li><b>Let us know</b> it is plugged in:<br><span class="msg">Box $DEV plugged in at [site] at [time], lights on, connected to [router/switch]</span></li>
  <li><b>Wait about 5 minutes</b> while we check that the box has connected to our server, found the KNX gateway, and that a test connection works. Please don't unplug it meanwhile.</li>
</ol>

<h2>Setup page (only if we ask, e.g. there are several KNX gateways)</h2>
<div class="setup">
  $qr
  <div>
    <div>On a laptop or phone <b>on the same network</b>, scan the code or open</div>
    <div class="mono" style="font-size:13pt;margin:1mm 0 2mm"><b>$URL</b></div>
    <div>Sign in as <b class="mono">admin</b> with the setup code:</div>
    <div class="code">$CODE</div>
    <div class="k">The page shows the box's link to our server, the KNX gateway in use and every gateway it can see; choose one, search again, or run a connection test. It only answers on this network, never from the internet.</div>
  </div>
</div>
<p class="note">If <span class="mono">$DEV.local</span> doesn't open (some older Windows or Android devices), find <span class="mono">$DEV</span> in the router's list of connected devices and open <span class="mono">http://&lt;its address&gt;/</span> instead.</p>

<h2>Good to know</h2>
<ul class="note">
  <li>No ports are opened on the router: the box only makes an outgoing, encrypted connection to our HAMON server, and its own certificate can be cancelled centrally if it is ever lost.</li>
  <li>It forwards only KNX traffic to the KNX gateway: no access to anything else on the network.</li>
  <li>It finds the gateway by itself, follows it if its address changes, reconnects after power or internet cuts, and installs its security updates.</li>
</ul>

<div class="foot">Keep this sheet with the site documentation: the setup code is also on the box's label. $DEV &middot; sheet made $(date +%F)</div>
</body></html>
EOF

html="$OUTDIR/$DEV-install.html"
cp "$tmp/sheet.html" "$html" && chmod 600 "$html"
if [ -z "$CHROMIUM" ]; then
    echo "install sheet: $html (open it in a browser and print, or save as PDF)"
    exit 0
fi
out="$OUTDIR/$DEV-install.pdf"
"$CHROMIUM" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --no-pdf-header-footer \
    --print-to-pdf="$out" "file://$tmp/sheet.html" >/dev/null 2>&1 || die "chromium couldn't print the PDF"
[ -s "$out" ] || die "no PDF written"
chmod 600 "$out"
echo "install sheet: $out (and $html)"
