#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
PRODUCT="$BUILD/BitcoinLotterySaver.saver"

rm -rf "$BUILD"
mkdir -p "$BUILD/BitcoinLotterySaver.saver/Contents/MacOS"

OBJDIR="$BUILD/obj"
mkdir -p "$OBJDIR"
(
  cd "$OBJDIR"
  swiftc -c -module-name BitcoinLotterySaver \
    "$ROOT/../shared/LotteryVersion.swift" \
    "$ROOT/../shared/BitcoinBrand.swift" \
    "$ROOT/../shared/NonceTicket.swift" \
    "$ROOT/../shared/ScreensaverView.swift" \
    "$ROOT/LotteryModels.swift" \
    "$ROOT/LotteryCanvasView.swift" \
    "$ROOT/BitcoinLotterySaverView.swift"
)
clang -bundle "$OBJDIR"/*.o \
  -framework ScreenSaver -framework AppKit -framework CryptoKit \
  -o "$BUILD/BitcoinLotterySaver.saver/Contents/MacOS/BitcoinLotterySaver"

cp "$ROOT/Info.plist" "$BUILD/BitcoinLotterySaver.saver/Contents/Info.plist"

echo "Built: $PRODUCT"
echo "Install: cp -R '$PRODUCT' ~/Library/Screen\\ Savers/"