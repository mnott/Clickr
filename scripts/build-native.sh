#!/bin/bash
# Compiles the native helper. Run automatically by `npm run build` and postinstall.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/clickr-helper.swift"
APP="$ROOT/bin/ClickrHelper.app"
OUT="$APP/Contents/MacOS/clickr-helper"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "clickr: swiftc not found — install the Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

mkdir -p "$APP/Contents/MacOS"

swiftc -O -swift-version 5 \
  -framework AppKit \
  -framework CoreGraphics \
  -framework ApplicationServices \
  -framework ImageIO \
  -framework CoreText \
  -o "$OUT" "$SRC"

chmod +x "$OUT"

# A real .app bundle gives LaunchServices the helper's own identity (an embedded plist does not).
cp "$ROOT/native/clickr-helper-Info.plist" "$APP/Contents/Info.plist"
codesign -s - -f "$APP" >/dev/null 2>&1 || echo "clickr: codesign failed (ad-hoc), continuing" >&2

# Already-running MCP servers spawn bin/clickr-helper; keep that path valid. A symlink does not
# carry the bundle identity (measured), so exec the bundle's binary by its real path instead.
rm -f "$ROOT/bin/clickr-helper"
printf '%s\n' '#!/bin/sh' 'exec "$(dirname "$0")/ClickrHelper.app/Contents/MacOS/clickr-helper" "$@"' > "$ROOT/bin/clickr-helper"
chmod +x "$ROOT/bin/clickr-helper"
echo "clickr: built $OUT"
