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

# Gate: the win check must agree with consensus. Runs ALWAYS — no node, no network, no opt-out. check_win
# compared the header digest big-endian while consensus reads it little-endian, so a genuine winning hash
# scored as a loss; `won` gates submitblock, meaning a real block would have been found and silently never
# submitted. At mainnet difficulty that is ~1 in 10^23, so it would never have surfaced until it cost someone
# a block. Nothing about this needs a node, so nothing may skip it.
echo "── gate: check_win agrees with consensus…"
if ! python3 "$ROOT/tests/test_check_win.py"; then
  echo "" >&2
  echo "✋ the win check disagrees with consensus — refusing to build." >&2
  echo "   A miner that cannot recognise a winning hash would throw away a real block." >&2
  exit 1
fi
echo ""

# Gate: the BIP34 coinbase height must be a valid CScriptNum. Runs ALWAYS. A missing sign byte builds a
# coinbase Core rejects with "bad-cb-height", and the resubmit loop then retries forever a block that can
# never land. Mainnet is outside the affected range until height 8,388,608; regtest is inside it.
echo "── gate: coinbase height encoding…"
if ! python3 "$ROOT/tests/test_coinbase_height.py"; then
  echo "" >&2
  echo "✋ a coinbase height encodes wrong — refusing to build. A won block would be rejected." >&2
  exit 1
fi
echo ""

# Gate: the payout address must become the right script. Runs ALWAYS — no node, no opt-out. This is
# hand-rolled bech32 and base58; derive the wrong scriptPubKey and a won block pays a script the user does
# not control, silently and irreversibly. Vectors are Core's own validateaddress output on mainnet.
echo "── gate: payout addresses derive the right script…"
if ! python3 "$ROOT/tests/test_payout_script.py"; then
  echo "" >&2
  echo "✋ a payout address derives the wrong script — refusing to build." >&2
  echo "   A won block would pay someone else." >&2
  exit 1
fi
echo ""

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
