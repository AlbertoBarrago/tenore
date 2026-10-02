#!/bin/sh
# Regenerates the PNG logos and the og.png link preview from assets/logo.svg and assets/og.html.
# Needs rsvg-convert (brew install librsvg) and Google Chrome (set CHROME to override its path).
set -eu
cd "$(dirname "$0")/../assets"
for size in 512 256 180 32 16; do
  rsvg-convert -w "$size" -h "$size" logo.svg -o "logo-$size.png"
done
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
# Headless Chrome sometimes keeps running after writing the screenshot: cap it at 45s.
(perl -e 'alarm 45; exec @ARGV' "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$PROFILE" --window-size=1200,630 --virtual-time-budget=5000 \
  --screenshot="$PWD/og.png" "file://$PWD/og.html") >/dev/null 2>&1 || true
rm -rf "$PROFILE"
test -s og.png && echo "assets regenerated"
