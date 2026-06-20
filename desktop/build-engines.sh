#!/usr/bin/env bash
# Rebuild the standalone engine binaries the packaged desktop app ships.
#
# electron-builder copies desktop/resources/{miner,bridge} into the .app as Resources/engine/*
# (see package.json extraResources). They're PyInstaller --onefile bundles so the shipped app needs
# no Python. Run this after changing lottery_miner.py or scripts/node_bridge.py, before `npm run dist`.
#
# Output: desktop/resources/{miner,bridge}  (gitignored — built artifacts, not source)
set -euo pipefail

# repo root = parent of this script's dir, so the script works from anywhere
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="$ROOT/desktop/resources"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! python3 -c "import PyInstaller" 2>/dev/null; then
  echo "PyInstaller not found. Install it with:  python3 -m pip install pyinstaller" >&2
  exit 1
fi
echo "PyInstaller $(python3 -c 'import PyInstaller; print(PyInstaller.__version__)')  →  $OUT"
mkdir -p "$OUT"

build() {                      # build <name> <entry.py> [extra pyinstaller args...]
  local name="$1" entry="$2"; shift 2
  echo "── building $name from $entry"
  python3 -m PyInstaller \
    --onefile --clean --noconfirm \
    --name "$name" \
    --distpath "$OUT" \
    --workpath "$WORK/build" \
    --specpath "$WORK" \
    "$@" \
    "$entry"
}

# miner: pure stdlib, single file.
build miner "lottery_miner.py"

# bridge: imports `from lottery_miner import validate_payout_address` inside a try/except, so
# PyInstaller's static scan misses it — pull it in explicitly and add the repo root to the path.
build bridge "scripts/node_bridge.py" --paths "$ROOT" --hidden-import lottery_miner

echo
echo "done:"
ls -lh "$OUT"/miner "$OUT"/bridge
