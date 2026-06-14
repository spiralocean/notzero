#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SAVER="$ROOT/../BitcoinLotterySaver"
BUILD="$ROOT/build"
APP="$BUILD/Bitcoin Lottery Preview.app"

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS"

VERSION="$(grep 'static let string' "$ROOT/../shared/LotteryVersion.swift" | sed 's/.*"\(.*\)".*/\1/')"

swiftc -parse-as-library -o "$APP/Contents/MacOS/Bitcoin Lottery Preview" -framework AppKit -framework CryptoKit \
  "$ROOT/../shared/LotteryVersion.swift" \
  "$ROOT/../shared/BitcoinBrand.swift" \
  "$ROOT/../shared/NonceTicket.swift" \
  "$ROOT/../shared/ScreensaverView.swift" \
  "$ROOT/../shared/Viz/"*.swift \
  "$ROOT/../shared/LotteryWindowController.swift" \
  "$SAVER/LotteryModels.swift" \
  "$SAVER/LotteryCanvasView.swift" \
  "$ROOT/PreviewApp.swift"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Bitcoin Lottery Preview</string>
    <key>CFBundleIdentifier</key>
    <string>com.bitcoinlottery.preview</string>
    <key>CFBundleName</key>
    <string>₿itcoin Lottery Preview</string>
    <key>CFBundleDisplayName</key>
    <string>₿itcoin Lottery Preview</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
</dict>
</plist>
PLIST

echo "Built: $APP"