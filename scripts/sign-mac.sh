#!/bin/bash
# Ad-hoc sign the macOS bundles (required on Apple Silicon) and zip them with symlinks preserved.
# Uses rcodesign (https://github.com/indygreg/apple-platform-rs) so it also works on Linux/CI.
set -euo pipefail
RC=${RCODESIGN:-rcodesign}
VER=$(node -p "require('./package.json').version")
for pair in "mac-arm64:arm64" "mac:x64"; do
  dir=${pair%%:*}; arch=${pair##*:}
  APP="dist/$dir/Zri.app"
  [ -d "$APP" ] || continue
  "$RC" sign "$APP/Contents/Resources/ffmpeg/ffmpeg" >/dev/null 2>&1
  for n in "$APP"/Contents/Resources/koffi/*/koffi.node; do "$RC" sign "$n" >/dev/null 2>&1; done
  "$RC" sign "$APP" >/dev/null 2>&1
  OUT="$PWD/dist/Zri-$VER-mac-$arch.zip"
  rm -f "$OUT"
  (cd "dist/$dir" && zip -qry "$OUT" Zri.app)
  echo "signed + zipped: $OUT ($(du -h "$OUT" | cut -f1))"
done
