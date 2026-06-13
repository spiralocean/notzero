#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
APP="$BUILD/Bitcoin Lottery.app"

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/../bitcoind/bitcoin.conf.template" "$APP/Contents/Resources/bitcoin.conf.template"

VERSION="$(grep 'static let string' "$ROOT/../shared/LotteryVersion.swift" | sed 's/.*"\(.*\)".*/\1/')"

swiftc -parse-as-library -o "$APP/Contents/MacOS/Bitcoin Lottery" -framework AppKit -framework UserNotifications -framework CryptoKit \
  "$ROOT/../shared/LotteryVersion.swift" \
  "$ROOT/../shared/BitcoinBrand.swift" \
  "$ROOT/../shared/NonceTicket.swift" \
  "$ROOT/../shared/ScreensaverView.swift" \
  "$ROOT/../shared/LotteryWindowController.swift" \
  "$ROOT/../BitcoinLotterySaver/LotteryModels.swift" \
  "$ROOT/../BitcoinLotterySaver/LotteryCanvasView.swift" \
  "$ROOT/BitcoinLotteryApp.swift" \
  "$ROOT/SharedState.swift" \
  "$ROOT/Formatters.swift" \
  "$ROOT/NotificationManager.swift" \
  "$ROOT/DaemonManager.swift" \
  "$ROOT/NodeSetupManager.swift" \
  "$ROOT/DashboardWindow.swift"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Bitcoin Lottery</string>
    <key>CFBundleIdentifier</key>
    <string>com.bitcoinlottery.app</string>
    <key>CFBundleName</key>
    <string>₿itcoin Lottery</string>
    <key>CFBundleDisplayName</key>
    <string>₿itcoin Lottery</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
</dict>
</plist>
PLIST

echo "Built: $APP"
echo "Open: open '$APP'"