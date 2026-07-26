#!/usr/bin/env bash
# Look at the dashboard you're editing, with the data your real node is producing.
#
# Serves web/ from a scratch copy whose node.json is SYMLINKED to the installed app's live one — so the page
# shows your actual node (sync state, catch-up progress, CPU/RAM, peers) against the working-tree dashboard
# code, with no build, no release, and nothing written back into the repo.
#
#   bash scripts/preview-dashboard.sh          # http://localhost:8899
#   bash scripts/preview-dashboard.sh 9000     # pick the port
#
# Why this exists: web/node.json is a stale fixture, so `npm run preview` can't show states it predates, and
# the packaged app only ever runs the LAST RELEASE — which meant the only way to see a dashboard change was
# to cut a version. Several times over one day that led to reviewing work that wasn't on screen yet.
set -euo pipefail

PORT="${1:-8899}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="$HOME/Library/Application Support/bitcoin-lottery-desktop/node.json"   # macOS; see below for others
[ -f "$LIVE" ] || LIVE="$HOME/.config/bitcoin-lottery-desktop/node.json"      # Linux
DEST="$(mktemp -d)/dash"

mkdir -p "$DEST"
# SYMLINK each entry rather than copy it. A copy is a snapshot: the server would keep serving whatever the
# working tree looked like the moment it started, so an edit made afterwards appears to do nothing no matter
# how hard you refresh. Symlinks mean a reload always reads the file you just saved.
for f in "$ROOT/web/"* "$ROOT/web/".*; do
  b="$(basename "$f")"
  [ "$b" = "." ] || [ "$b" = ".." ] || [ ! -e "$f" ] || ln -sfn "$f" "$DEST/$b"
done

if [ -f "$LIVE" ]; then
  ln -sf "$LIVE" "$DEST/node.json"   # symlink, not copy: the page keeps seeing fresh polls
  echo "→ live node data: $LIVE"
else
  echo "→ no installed app found; using the checked-in fixture (older states won't render)" >&2
fi

echo "→ dashboard code: $ROOT/web  (your working tree, including uncommitted edits)"
echo "→ open http://localhost:$PORT"
echo "   ctrl-c to stop; the scratch copy is thrown away with it"
trap 'rm -rf "$(dirname "$DEST")"' EXIT
cd "$DEST" && python3 -m http.server "$PORT" --bind 127.0.0.1
