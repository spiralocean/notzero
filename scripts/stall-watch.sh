#!/usr/bin/env bash
# Watch for the miner hang, and say something the first time it happens.
#
# The miner has gone silent for 20-40 minutes and skipped a block, roughly twice a day, for as long as anyone
# has looked. Nothing recorded where it stopped, so 0.1.79 added reporting that speaks WHILE it is stuck:
#
#   BLOCKED in '<step>'          the poll loop is parked inside one call (a socket read, a DNS lookup)
#   IDLE — …tip has caught up    the loop is cycling fine but is not moving to the new block
#   terminated while in '<step>' the app's watchdog killed it, and this is where it was
#
# Those lines land in daemon.log whether or not anyone is watching, and the answer decides the fix — BLOCKED
# means mempool.space sitting in the ticket's critical path, IDLE means the bug is in tip detection instead.
# The catch is patience: the hang is intermittent, so somebody has to still be looking hours later. Two
# in-session watchers were killed before one ever fired. launchd is not.
#
#   bash scripts/stall-watch.sh            # check now, print anything new
#   bash scripts/stall-watch.sh --install  # load the hourly launchd agent
#   bash scripts/stall-watch.sh --remove   # unload it again
#
# OPT-IN ONLY, and it must stay that way. Nothing installs this: the app never writes a LaunchAgent (its
# auto-start login item goes through Electron's own API), scripts/ is not in build.files or extraResources so
# it is not inside the shipped bundle at all, and there is no npm lifecycle hook that could reach it. The
# agent exists only where somebody has typed --install. Anyone wiring this into an automatic path is changing
# that promise deliberately, not by accident. Note that once installed it also runs at each login, which is
# what launchd agents do — --remove is the off switch.
#
# Reports each finding ONCE: the byte offset already scanned is kept in a status file, so an hourly agent does
# not re-notify about the same stall every hour until somebody reads it. Notifies only on a real finding —
# a check that finds nothing is silent, which is the normal case and should stay quiet.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$HOME/Library/Application Support/bitcoin-lottery-desktop"
DAEMON_LOG="$STATE/daemon.log"
APP_LOG="$STATE/app.log"
LOG="$STATE/stall-watch.log"            # the curated record: one entry per finding, written by this script
AGENT_LOG="$STATE/stall-watch-agent.log"  # raw launchd stdout/stderr, so a crash IN this script is visible too
STATUS="$STATE/stall-watch-status.json"
LABEL="com.notzero.stallwatch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SIGNALS="BLOCKED in |IDLE — |terminated while in "

install_agent() {
  mkdir -p "$HOME/Library/LaunchAgents"
  # launchd's stdout goes to a SEPARATE file from the curated log. Pointing both at $LOG double-wrote every
  # finding — once from the block below, once from launchd capturing this script's own stdout — which showed up
  # immediately as two known incidents appearing four times. A log you cannot count incidents in is worthless.
  # StartInterval, not StartCalendarInterval: this is a poll for something that could appear at any hour, and
  # a missed run costs nothing — the lines stay in daemon.log and the next run picks them up from the offset.
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/stall-watch.sh</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$AGENT_LOG</string>
  <key>StandardErrorPath</key><string>$AGENT_LOG</string>
</dict>
</plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" && echo "loaded $LABEL — checks hourly, logging to $LOG"
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
[ -f "$DAEMON_LOG" ] || { echo "no daemon.log yet at $DAEMON_LOG — nothing to watch"; exit 0; }

# Resume where the last run stopped. A log that SHRANK was rotated or replaced, so start over rather than
# reading from an offset that now points into the middle of different content.
offset=0
[ -f "$STATUS" ] && offset=$(sed -n 's/.*"offset":[[:space:]]*\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null || echo 0)
[ -n "$offset" ] || offset=0
size=$(wc -c < "$DAEMON_LOG" | tr -d ' ')
[ "$size" -lt "$offset" ] && offset=0

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
found="$(tail -c +$((offset + 1)) "$DAEMON_LOG" 2>/dev/null | grep -E "$SIGNALS" || true)"
count=$(printf '%s' "$found" | grep -c . || true)
printf '{"checked":"%s","offset":%d,"new_findings":%d}\n' "$started" "$size" "${count:-0}" > "$STATUS"

if [ "${count:-0}" -eq 0 ]; then
  echo "$started  nothing new (scanned to byte $size)"
  exit 0
fi

# A stall the app's watchdog also saw is worth pairing up: its line names the heights, the miner's names the
# step. Together they are the whole picture, and neither alone has been enough so far.
recent_kills="$(grep "miner stalled" "$APP_LOG" 2>/dev/null | tail -3 || true)"
{
  echo "── $started  $count new stall signal(s)"
  echo "$found"
  [ -n "$recent_kills" ] && { echo "  recent watchdog restarts:"; printf '%s\n' "$recent_kills" | sed 's/^/    /'; }
  echo
} >> "$LOG"

echo "$found"
[ -n "$recent_kills" ] && { echo; echo "recent watchdog restarts:"; printf '%s\n' "$recent_kills"; }
echo
echo "logged to $LOG"

first="$(printf '%s' "$found" | head -1 | cut -c1-120)"
osascript -e "display notification \"$(printf '%s' "$first" | sed 's/"/\\"/g')\" with title \"notzero: miner stall signal\"" 2>/dev/null || true
exit 0
