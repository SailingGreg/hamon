#!/usr/bin/env bash
#
# grafana-whitelabel.sh - put our logo, favicon and title on Grafana OSS
#
# Successor to the 2022 whitelabeling.sh (kept on the servers only). That
# script changed the first build file with "Welcome to Grafana" and stopped
# when grep found more than one: Grafana 11 has three, 12 has four, so prod
# was finished by hand. This one changes every match and is safe to re-run.
#
# A Grafana package upgrade puts the stock files back, so run it after every
# upgrade (then hard-refresh the browser). Each stock file is kept once as
# <file>.org before it is changed; --revert puts those back.
#
# The branding stays out of git: the images and title are arguments.
#
# Usage (as root):
#   grafana-whitelabel.sh --svg logo.svg --favicon fav32.png --title "My Title"
#   grafana-whitelabel.sh --revert
#   grafana-whitelabel.sh --check  --svg logo.svg --favicon fav32.png --title "My Title"
# Options: --dir (default /usr/share/grafana/public)
#

set -euo pipefail

DIR=/usr/share/grafana/public
SVG= FAV= TITLE= MODE=apply
STOCK="Welcome to Grafana"

while [ $# -gt 0 ]; do
    case "$1" in
        --svg) SVG=$2; shift 2 ;;
        --favicon) FAV=$2; shift 2 ;;
        --title) TITLE=$2; shift 2 ;;
        --dir) DIR=$2; shift 2 ;;
        --revert) MODE=revert; shift ;;
        --check) MODE=check; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done

[ -d "$DIR/img" ] && [ -d "$DIR/build" ] || { echo "no Grafana public dir at $DIR" >&2; exit 1; }
echo "Grafana $(cat "$DIR/../VERSION" 2>/dev/null || echo '?') at $DIR ($MODE)"

if [ "$MODE" = revert ]; then
    n=0
    for org in "$DIR"/img/grafana_icon.svg.org "$DIR"/img/fav32.png.org "$DIR"/build/*.js.org; do
        [ -f "$org" ] || continue
        f=${org%.org}
        # build files are renamed (content hash) on upgrade: drop stale backups
        if [ -f "$f" ]; then cp -p "$org" "$f"; echo "restored $f"; n=$((n+1)); fi
    done
    echo "$n file(s) restored"
    exit 0
fi

[ -f "$SVG" ] && [ -f "$FAV" ] && [ -n "$TITLE" ] || { echo "need --svg FILE --favicon FILE --title TEXT" >&2; exit 2; }
# sed replacement: escape & / and \ in the title
ESC=$(printf '%s' "$TITLE" | sed 's/[&/\]/\\&/g')
bad=0

# one image: keep the stock file once (only if it isn't already ours), copy ours
image() {
    local ours=$1 target=$2
    if cmp -s "$ours" "$target"; then echo "ok      $target"; return; fi
    if [ "$MODE" = check ]; then echo "STOCK   $target"; bad=1; return; fi
    cp -p "$target" "$target.org"
    cp "$ours" "$target"; chmod 644 "$target"
    echo "changed $target (stock kept as .org)"
}
image "$SVG" "$DIR/img/grafana_icon.svg"
image "$FAV" "$DIR/img/fav32.png"

# the welcome text, in every build file that has it
found=0
for f in $(grep -l "$STOCK" "$DIR"/build/*.js 2>/dev/null || true); do
    found=$((found+1))
    if [ "$MODE" = check ]; then echo "STOCK   $f"; bad=1; continue; fi
    [ -f "$f.org" ] || cp -p "$f" "$f.org"
    sed -i "s/$STOCK/Welcome to $ESC/g" "$f"
    echo "changed $f"
done
done_n=$(grep -l "Welcome to $TITLE" "$DIR"/build/*.js 2>/dev/null | wc -l)
echo "welcome text: $done_n build file(s) say \"Welcome to $TITLE\", $found had the stock text this run"
[ "$done_n" -gt 0 ] || { echo "WARNING: no build file has the welcome text - Grafana may have moved it" >&2; bad=1; }

[ "$MODE" = check ] && { [ $bad = 0 ] && echo "all branded" || echo "NOT fully branded"; }
exit $bad
