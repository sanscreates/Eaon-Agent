#!/usr/bin/env bash
# make-icns.sh — build macapp/build/icon.icns from the generated icon.png.
#
# Generates the master PNG first if it is missing, then produces a complete
# Icon Composer iconset (all 10 required sizes) and packs it into icon.icns.
# macOS only (needs sips + iconutil). Regenerating often? It stays idempotent:
# missing icon.png -> gen-icon.mjs runs; existing -> reused.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACAPP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$MACAPP_DIR/build"

SRC="$BUILD_DIR/icon.png"
ICONSET="$BUILD_DIR/icon.iconset"

mkdir -p "$BUILD_DIR"

if [[ ! -f "$SRC" ]]; then
  echo "icon.png missing — generating with gen-icon.mjs"
  node "$SCRIPT_DIR/gen-icon.mjs"
fi

# Name and size are passed as "$1" and "$2" -> (name, px)
make_size() {
  sips -z "$2" "$2" --out "$ICONSET/$1" "$SRC" >/dev/null 2>&1
}

rm -rf "$ICONSET"
mkdir -p "$ICONSET"
trap 'rm -rf "$ICONSET"' EXIT

make_size icon_16x16.png     16
make_size icon_16x16@2x.png  32
make_size icon_32x32.png     32
make_size icon_32x32@2x.png  64
make_size icon_128x128.png   128
make_size icon_128x128@2x.png 256
make_size icon_256x256.png   256
make_size icon_256x256@2x.png 512
make_size icon_512x512.png   512
make_size icon_512x512@2x.png 1024

iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"

SIZE=$(stat -f "%z" "$BUILD_DIR/icon.icns")
echo "icon.icns written ($SIZE bytes)"