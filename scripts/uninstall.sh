#!/bin/bash
set -euo pipefail

PLIST_DEST="$HOME/Library/LaunchAgents/com.bitcoinlottery.miner.plist"

launchctl bootout "gui/$(id -u)/com.bitcoinlottery.miner" 2>/dev/null || true
rm -f "$PLIST_DEST"

echo "₿itcoin Lottery daemon removed."
echo "State and history kept at ~/Library/Application Support/BitcoinLottery/"