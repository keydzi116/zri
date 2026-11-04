#!/bin/bash
# Downloads the per-platform binaries that are bundled into release builds but not kept in git:
#   - static ffmpeg builds (used to turn the recording into an MP4)
#   - koffi native modules (used to detect mouse clicks for the click highlight)
set -euo pipefail
cd "$(dirname "$0")/.."
FFMPEG_TAG=b6.1.1
KOFFI_VER=$(node -p "require('./node_modules/koffi/package.json').version")
for p in darwin-arm64 darwin-x64 win32-x64 linux-x64; do
  exe=ffmpeg; [ "$p" = win32-x64 ] && exe=ffmpeg.exe
  mkdir -p "vendor/ffmpeg/$p"
  if [ ! -f "vendor/ffmpeg/$p/$exe" ]; then
    echo "ffmpeg $p"
    curl -fsSL --retry 5 "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_TAG/ffmpeg-$p.gz" | gunzip > "vendor/ffmpeg/$p/$exe"
    chmod +x "vendor/ffmpeg/$p/$exe"
  fi
  if [ ! -d "vendor/koffi/$p/package" ]; then
    echo "koffi $p"
    mkdir -p "vendor/koffi/$p"
    (cd "vendor/koffi/$p" && npm pack "@koromix/koffi-$p@$KOFFI_VER" --silent >/dev/null && tar xzf ./*.tgz && rm ./*.tgz)
  fi
done
echo "vendor ready"
