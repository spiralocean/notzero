#!/usr/bin/env bash
# Run the mainnet block-validity gate on a schedule, because CI cannot.
#
# scripts/verify-block.py asks a REAL node, via getblocktemplate proposal mode, whether the exact block this
# miner would assemble is one bitcoind would accept. It is the closest thing to proof that a found block would
# land, and it is the one gate CI can't run: GitHub runners have no synced Bitcoin node, so every release since
# 0.1.69 has been built with SKIP_BLOCK_VERIFY=1. That leaves it running only when somebody remembers to type
# the command — which is exactly how a check rots without anyone noticing it stopped.
#
#   bash scripts/verify-block-scheduled.sh          # run once, print the result
#   bash scripts/verify-block-scheduled.sh --install  # load the weekly launchd agent
#   bash scripts/verify-block-scheduled.sh --remove   # unload it again
#
# Writes every run to a log and keeps the last verdict in a status file the dashboard could read later. On
# FAILURE it also posts a macOS notification, because a silent failure is the same as not running at all.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$HOME/Library/Application Support/bitcoin-lottery-desktop"
LOG="$STATE/verify-block.log"
STATUS="$STATE/verify-block-status.json"
LABEL="com.notzero.verifyblock"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

install_agent() {
  mkdir -p "$HOME/Library/LaunchAgents"
  # Weekly (Sunday 09:00 local). StartCalendarInterval rather than StartInterval so it doesn't fire in a burst
  # after the laptop has been shut for a week; launchd runs a missed calendar job once on the next wake.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/verify-block-scheduled.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" && echo "loaded $LABEL — runs Sundays 09:00, logging to $LOG"
}

remove_agent() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" && echo "removed $LABEL"
}

case "${1:-}" in
  --install) install_agent; exit $? ;;
  --remove)  remove_agent;  exit $? ;;
esac

mkdir -p "$STATE"
export LOTTERY_DATA_DIR="$STATE"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
out="$(cd "$ROOT" && python3 scripts/verify-block.py 2>&1)"
rc=$?
{ echo "── $started  (exit $rc)"; echo "$out"; echo; } >> "$LOG"

# The node being unreachable is NOT a failure of the block builder — the app's node may simply be down or
# syncing. Record it distinctly so a week of "couldn't check" never reads as a week of "verified".
verdict="pass"
if [ $rc -ne 0 ]; then
  if printf '%s' "$out" | grep -qiE "could not find rpc|connection refused|no node|unreachable"; then verdict="skipped"; else verdict="fail"; fi
fi
printf '{"checked":"%s","verdict":"%s","exit":%d}\n' "$started" "$verdict" "$rc" > "$STATUS"

echo "$out"
echo "verdict: $verdict  (log: $LOG)"
if [ "$verdict" = "fail" ]; then
  osascript -e 'display notification "A found block may not be accepted — see verify-block.log" with title "notzero: block validity FAILED"' 2>/dev/null || true
  exit 1
fi
exit 0
