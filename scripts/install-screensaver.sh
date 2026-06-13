#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Screen Savers/BitcoinLotterySaver.saver"

bash "$ROOT/BitcoinLotterySaver/build.sh"
rm -rf "$DEST"
cp -R "$ROOT/BitcoinLotterySaver/build/BitcoinLotterySaver.saver" "$DEST"
xattr -cr "$DEST"

echo "Installed: $DEST"
echo ""
echo "Open System Settings → Screen Saver"
echo "Look for '₿itcoin Lottery' in the list (scroll down — custom savers appear near the bottom)"
echo ""
open "x-apple.systempreferences:com.apple.ScreenSaver-Settings.extension"