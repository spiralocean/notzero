#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/Applications/Bitcoin Lottery Preview.app}"

bash "$ROOT/preview-app/build.sh"
rm -rf "$DEST"
cp -R "$ROOT/preview-app/build/Bitcoin Lottery Preview.app" "$DEST"
xattr -cr "$DEST"

# Rebuild screen saver with shared canvas fixes
bash "$ROOT/scripts/install-screensaver.sh" 2>/dev/null || bash "$ROOT/BitcoinLotterySaver/build.sh"

echo "Installed preview: $DEST"
open "$DEST"