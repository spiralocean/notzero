#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SUPPORT="$HOME/Library/Application Support/BitcoinLottery"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS/com.bitcoinlottery.miner.plist"
PYTHON="$(command -v python3)"

mkdir -p "$APP_SUPPORT" "$LAUNCH_AGENTS"

python3 "$ROOT/lottery_miner.py" --init-config

sed \
  -e "s|__PYTHON__|$PYTHON|g" \
  -e "s|__MINER_SCRIPT__|$ROOT/lottery_miner.py|g" \
  -e "s|__APP_SUPPORT__|$APP_SUPPORT|g" \
  "$ROOT/launchd/com.bitcoinlottery.miner.plist" > "$PLIST_DEST"

launchctl bootout "gui/$(id -u)/com.bitcoinlottery.miner" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
launchctl enable "gui/$(id -u)/com.bitcoinlottery.miner"
launchctl kickstart -k "gui/$(id -u)/com.bitcoinlottery.miner"

echo "₿itcoin Lottery installed and running in Practice mode."
echo "  No blockchain download required — works immediately."
echo ""
echo "  Config: $APP_SUPPORT/config.json"
echo "  State:  $APP_SUPPORT/state.json"
echo "  Logs:   $APP_SUPPORT/daemon.log"
echo "  Status: python3 $ROOT/lottery_miner.py --status"
echo ""
echo "Optional — Live mode (advanced, for real block submission):"
echo "  Requires a pruned ₿itcoin Core node: ~15–18 GB disk, not 600 GB."
echo "  Network sync still takes days, but old blocks are discarded as it goes."
echo ""
echo "  1. $ROOT/scripts/setup-bitcoind.sh"
echo "  2. Install ₿itcoin Core and wait for sync"
echo "  3. $ROOT/scripts/check-node.sh"
echo "  4. Open ₿itcoin Lottery → set payout wallet → switch to Live → Save"
echo ""
echo "Apps (optional):"
echo "  $ROOT/scripts/install-app.sh"