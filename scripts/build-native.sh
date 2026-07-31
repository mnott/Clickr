#!/bin/bash
# Compiles the native helper. Run automatically by `npm run build` and postinstall.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/clickr-helper.swift"
OUT="$ROOT/bin/clickr-helper"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "clickr: swiftc not found — install the Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

mkdir -p "$ROOT/bin"

swiftc -O -swift-version 5 \
  -framework AppKit \
  -framework CoreGraphics \
  -framework ApplicationServices \
  -framework ImageIO \
  -framework CoreText \
  -o "$OUT" "$SRC"

chmod +x "$OUT"
echo "clickr: built $OUT"
