#!/usr/bin/env bash
# verify-snapshot.sh <path-to-utxo-840000.dat>
# Confirms a downloaded assumeutxo snapshot is genuine and uncorrupted by loading it
# into a throwaway Bitcoin Core node. Core only accepts a snapshot whose UTXO hash
# matches the value baked into the release — so a PASS means the file is safe to
# re-host. Run this once before pointing ASSUMEUTXO.snapshotUrl at your CDN copy.
#
# Needs:
#   • bitcoind / bitcoin-cli v28+ (Core must have the snapshot height baked in).
#   • Network access (to sync block headers — fast, ~minutes).
#   • ~12 GB free temp disk for the UTXO chainstate it builds.
#   Takes several minutes to tens of minutes; reads the whole file.
#
# Env: BITCOIND, BITCOIN_CLI (paths), SNAPSHOT_HEIGHT (default 840000), TMPDIR.
set -euo pipefail

SNAP="${1:-}"
{ [ -n "$SNAP" ] && [ -f "$SNAP" ]; } || { echo "usage: verify-snapshot.sh /path/to/utxo-840000.dat" >&2; exit 1; }
case "$SNAP" in /*) ;; *) SNAP="$PWD/$SNAP" ;; esac
HEIGHT="${SNAPSHOT_HEIGHT:-840000}"
BITCOIND="${BITCOIND:-bitcoind}"; CLI="${BITCOIN_CLI:-bitcoin-cli}"
RPCPORT=18999  # off the default 8332 so this can't touch a real node
command -v "$BITCOIND" >/dev/null || { echo "✗ '$BITCOIND' not found (set BITCOIND)." >&2; exit 1; }

DATADIR="$(mktemp -d "${TMPDIR:-/tmp}/notzero-verify.XXXXXX")"
rc() { "$CLI" -datadir="$DATADIR" -rpcport=$RPCPORT -rpcclienttimeout=0 "$@"; }
cleanup() { rc stop >/dev/null 2>&1 || true; sleep 3; rm -rf "$DATADIR"; }
trap cleanup EXIT

echo "→ starting a throwaway node in $DATADIR (rpc :$RPCPORT)…"
"$BITCOIND" -datadir="$DATADIR" -rpcport=$RPCPORT -server=1 -listen=0 -blocksonly=1 -prune=550 -daemon >/dev/null

echo "→ waiting for it to come up…"
for _ in $(seq 1 90); do rc getblockchaininfo >/dev/null 2>&1 && break; sleep 1; done
rc getblockchaininfo >/dev/null 2>&1 || { echo "✗ node didn't start." >&2; exit 1; }

echo "→ syncing block headers to >= $HEIGHT (needed to validate the snapshot)…"
H=0
for _ in $(seq 1 900); do
  H="$(rc getblockchaininfo | python3 -c "import json,sys;print(json.load(sys.stdin)['headers'])" 2>/dev/null || echo 0)"
  printf "   headers: %s\r" "$H"
  [ "${H:-0}" -ge "$HEIGHT" ] && { echo; break; }
  sleep 2
done
[ "${H:-0}" -ge "$HEIGHT" ] || { echo; echo "✗ headers didn't reach $HEIGHT in time (network?)." >&2; exit 1; }

echo "→ loading the snapshot — Core verifies it against its baked-in hash (reads the whole file)…"
if rc loadtxoutset "$SNAP"; then
  echo
  echo "✓ VERIFIED — Core accepted it: the genuine UTXO set at height $HEIGHT, uncorrupted."
  echo "  Safe to re-host. Then set ASSUMEUTXO.snapshotUrl to its public URL."
else
  echo
  echo "✗ REJECTED — Core would not load this file (corrupted, wrong height, or not a real snapshot)." >&2
  echo "  Do NOT host it." >&2
  exit 1
fi
