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

# Gate: don't ship a miner whose found block would be rejected. verify-block.py asks the local node to
# validate the exact block this miner would submit (getblocktemplate proposal mode). It needs a reachable
# node; in an environment without one (e.g. CI), set SKIP_BLOCK_VERIFY=1 to build UNVERIFIED binaries.
if [ "${SKIP_BLOCK_VERIFY:-}" = "1" ]; then
  echo "⚠ SKIP_BLOCK_VERIFY=1 — skipping the block-validity gate; binaries will be UNVERIFIED." >&2
else
  echo "── gate: verifying block validity against the local node…"
  if ! python3 scripts/verify-block.py; then
    echo "" >&2
    echo "✋ block-validity check FAILED — refusing to build the engine binaries." >&2
    echo "   A found block could be rejected by the network. Fix it (see scripts/verify-block.py)," >&2
    echo "   or, if no node is reachable here, re-run with:  SKIP_BLOCK_VERIFY=1 bash desktop/build-engines.sh" >&2
    exit 1
  fi
fi

# Build a universal2 (x86_64 + arm64) binary by default so one app runs on both Intel and Apple
# Silicon — an arm64-only engine simply can't launch on an Intel Mac. Requires a universal2 Python
# (Xcode's is); override with ENGINE_TARGET_ARCH=arm64 for a faster native-only dev build.
TARGET_ARCH="${ENGINE_TARGET_ARCH:-universal2}"

build() {                      # build <name> <entry.py> [extra pyinstaller args...]
  local name="$1" entry="$2"; shift 2
  echo "── building $name from $entry  (target-arch: $TARGET_ARCH)"
  python3 -m PyInstaller \
    --onefile --clean --noconfirm \
    --name "$name" \
    --target-arch "$TARGET_ARCH" \
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
