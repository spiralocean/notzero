#!/bin/bash
# Kill running apps, rebuild everything, reinstall, and relaunch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="/Applications/Bitcoin Lottery.app"

echo "==> Stopping running apps…"
osascript -e 'quit app "Bitcoin Lottery"' 2>/dev/null || true
pkill -f "/Applications/Bitcoin Lottery.app/Contents/MacOS/Bitcoin Lottery" 2>/dev/null || true
sleep 0.5

echo "==> Restarting mining daemon…"
launchctl kickstart -k "gui/$(id -u)/com.bitcoinlottery.miner" 2>/dev/null \
  || bash "$ROOT/scripts/install.sh" >/dev/null

echo "==> Building…"
bash "$ROOT/app/build.sh"

echo "==> Installing…"
rm -rf "$APP" && cp -R "$ROOT/app/build/Bitcoin Lottery.app" "$APP"

echo "==> Launching…"
open "$APP"

echo ""
echo "Done — v$(grep 'static let string' "$ROOT/shared/LotteryVersion.swift" | sed 's/.*"\(.*\)".*/\1/')"
echo "  App:     $APP"