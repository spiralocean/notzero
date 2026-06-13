#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/Applications/Bitcoin Lottery.app}"

bash "$ROOT/app/build.sh"
rm -rf "$DEST"
cp -R "$ROOT/app/build/Bitcoin Lottery.app" "$DEST"

echo "Installed: $DEST"
echo ""
echo "₿itcoin Lottery opens in Practice mode — no node or blockchain download needed."
echo "Use the dashboard to play immediately, or switch to Live mode later (advanced)."
open "$DEST"