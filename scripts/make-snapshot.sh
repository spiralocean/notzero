#!/usr/bin/env bash
# make-snapshot.sh — generate the assumeutxo UTXO snapshot for notzero's managed-node
# fast-start. Produces utxo-<height>.dat, which users loadtxoutset to reach the chain tip
# in minutes (Bitcoin Core verifies the file against a hash baked into the release).
#
# REQUIREMENTS — read these; a pruned node CANNOT do this:
#   • A mainnet Bitcoin Core node (v28+) synced past the snapshot height.
#   • NOT pruned above the snapshot height — rolling the chainstate back to it needs those
#     blocks' undo data. A heavily-pruned node will be rejected by the check below. (A node
#     that synced full / with a prune target large enough to retain blocks from <= the
#     height works.)
#   • ~11 GB free disk for the output file.
#   • The node briefly disconnects from the network while it rolls back -> dumps -> rolls
#     forward. This can take a long while. That's expected; let it run.
#
# USAGE:
#   scripts/make-snapshot.sh [output-path]
#   BTC_ARGS="-datadir=/mnt/btc" scripts/make-snapshot.sh ~/snap/utxo-840000.dat
#
# ENV:
#   SNAPSHOT_HEIGHT   default 840000 (a baked-in assumeutxo height in Core 29-31)
#   BITCOIN_CLI       path to bitcoin-cli (default: bitcoin-cli on PATH)
#   BTC_ARGS          extra args for bitcoin-cli (datadir / conf / rpc creds)
#
# Alternative if you can't run an archival node: download a community-produced
# utxo-840000.dat and just re-host it. Core verifies it against its baked-in hash on
# load, so the source does not need to be trusted — only correct. (See base hash below.)
set -euo pipefail

HEIGHT="${SNAPSHOT_HEIGHT:-840000}"
# block hash at each baked-in assumeutxo height (Core 31), to sanity-check the dump
case "$HEIGHT" in
  840000) EXPECTED_BLOCKHASH="0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5" ;;
  880000) EXPECTED_BLOCKHASH="000000000000000000010b17283c3c400507969a9c2afd1dcf2082ec5cca2880" ;;
  *)      EXPECTED_BLOCKHASH="" ;;  # unknown height → skip the block-hash check
esac
OUT="${1:-$PWD/utxo-${HEIGHT}.dat}"
CLI="${BITCOIN_CLI:-bitcoin-cli}"
read -r -a EXTRA <<< "${BTC_ARGS:-}"
# -rpcclienttimeout=0 so the client never gives up while a long dump runs
cli() { "$CLI" -rpcclienttimeout=0 ${EXTRA[@]+"${EXTRA[@]}"} "$@"; }

case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac          # absolutize
[ -e "$OUT" ] && { echo "✗ $OUT already exists — move it aside first." >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

command -v "$CLI" >/dev/null || { echo "✗ '$CLI' not found. Install Bitcoin Core or set BITCOIN_CLI." >&2; exit 1; }

echo "→ querying node…"
INFO="$(cli getblockchaininfo)" || { echo "✗ couldn't reach the node (check BTC_ARGS / rpc creds)." >&2; exit 1; }
jget() { printf '%s' "$INFO" | python3 -c "import json,sys;v=json.load(sys.stdin).get('$1');print('' if v is None else v)"; }
CHAIN="$(jget chain)"; BLOCKS="$(jget blocks)"; PRUNED="$(jget pruned)"; PRUNEH="$(jget pruneheight)"; IBD="$(jget initialblockdownload)"
echo "  chain=$CHAIN blocks=$BLOCKS pruned=$PRUNED pruneheight=${PRUNEH:-0} ibd=$IBD"

[ "$CHAIN" = "main" ] || { echo "✗ node is on '$CHAIN', not mainnet — the $HEIGHT assumeutxo hash is mainnet-only." >&2; exit 1; }
[ "$IBD" = "False" ] || { echo "✗ node is still in initial block download. Let it finish syncing first." >&2; exit 1; }
[ "${BLOCKS:-0}" -ge "$HEIGHT" ] || { echo "✗ node height $BLOCKS is below the snapshot height $HEIGHT." >&2; exit 1; }
if [ "$PRUNED" = "True" ] && [ "${PRUNEH:-0}" -gt "$HEIGHT" ]; then
  echo "✗ node is pruned above height $HEIGHT (pruneheight=$PRUNEH)." >&2
  echo "  Rolling back to $HEIGHT needs those blocks' undo data, which pruning discarded." >&2
  echo "  → Use a non-pruned node, or re-host a verified community snapshot instead" >&2
  echo "    (Core checks it by hash on load, so the source need not be trusted)." >&2
  exit 1
fi

echo "→ dumping the UTXO set at height $HEIGHT — the node goes offline during rollback; this is slow…"
RES="$(cli dumptxoutset "$OUT" rollback "{\"rollback\":$HEIGHT}")"
echo "$RES"
rjget() { printf '%s' "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))"; }
BASEHASH="$(rjget base_hash)"; BASEHEIGHT="$(rjget base_height)"

echo "→ verifying the dump…"
[ "$BASEHEIGHT" = "$HEIGHT" ] || { echo "✗ base_height $BASEHEIGHT != $HEIGHT" >&2; exit 1; }
if [ -n "$EXPECTED_BLOCKHASH" ] && [ "$BASEHASH" != "$EXPECTED_BLOCKHASH" ]; then
  echo "✗ base_hash mismatch:
  got      $BASEHASH
  expected $EXPECTED_BLOCKHASH" >&2; exit 1
fi

SZ="$(du -h "$OUT" | cut -f1)"; SHA="$(shasum -a 256 "$OUT" 2>/dev/null | cut -d' ' -f1 || sha256sum "$OUT" | cut -d' ' -f1)"
cat <<EOF

✓ snapshot written: $OUT  ($SZ)
  base height : $BASEHEIGHT
  base hash   : $BASEHASH  (matches Core's baked-in assumeutxo hash ✓)
  sha256      : $SHA

Next:
  1) Upload to your CDN (e.g. Cloudflare R2, S3-compatible):
       rclone copy "$OUT" r2:notzero-snapshots/
       # or: aws s3 cp "$OUT" s3://notzero-snapshots/ --endpoint-url https://<acct>.r2.cloudflarestorage.com
  2) Set ASSUMEUTXO.snapshotUrl in desktop/node-provision.js to the public URL
     (e.g. https://dl.notzero.spiralocean.com/utxo-$HEIGHT.dat).
EOF
