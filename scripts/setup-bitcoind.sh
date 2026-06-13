#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DEFAULT_BITCOIN_DIR="$HOME/Library/Application Support/Bitcoin"
else
  DEFAULT_BITCOIN_DIR="$HOME/.bitcoin"
fi
BITCOIN_DIR="${BITCOIN_DIR:-$DEFAULT_BITCOIN_DIR}"
CONF="$BITCOIN_DIR/bitcoin.conf"
LOTTERY_CONFIG="$HOME/Library/Application Support/BitcoinLottery/config.json"

mkdir -p "$BITCOIN_DIR"

if [[ -f "$CONF" ]] && grep -q "Bitcoin Lottery" "$CONF" 2>/dev/null; then
  echo "₿itcoin Lottery section already present in $CONF"
elif [[ -f "$CONF" ]]; then
  echo "WARNING: $CONF already exists — appending lottery settings to avoid overwriting."
  echo "         Review the file manually if you use a custom setup."
  cat >> "$CONF" <<'EOF'

# --- Added by Bitcoin Lottery setup ---
server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
prune=2048
disablewallet=1
blocksonly=1
dbcache=450
maxconnections=8
EOF
else
  cp "$ROOT/bitcoind/bitcoin.conf.template" "$CONF"
fi

if ! grep -q '^rpcuser=' "$CONF"; then
  RPC_USER="lottery"
  RPC_PASS="$(openssl rand -hex 24)"
  {
    echo ""
    echo "# Bitcoin Lottery credentials ($(date -u +%Y-%m-%d))"
    echo "rpcuser=$RPC_USER"
    echo "rpcpassword=$RPC_PASS"
  } >> "$CONF"
  echo "Generated RPC credentials in $CONF"
else
  RPC_USER="$(grep '^rpcuser=' "$CONF" | tail -1 | cut -d= -f2-)"
  RPC_PASS="$(grep '^rpcpassword=' "$CONF" | tail -1 | cut -d= -f2-)"
  echo "Using existing RPC credentials from $CONF"
fi

python3 "$ROOT/lottery_miner.py" --init-config
python3 "$ROOT/lottery_miner.py" --set rpc_url "http://127.0.0.1:8332"
python3 "$ROOT/lottery_miner.py" --set rpc_user "$RPC_USER"
python3 "$ROOT/lottery_miner.py" --set rpc_pass "$RPC_PASS"

echo ""
echo "Optional Live mode setup — pruned ₿itcoin Core config ready."
echo "  Config file: $CONF"
echo "  Disk use:    ~15–18 GB total (pruned blocks + UTXO set — not 600 GB)"
echo "  Network:     still downloads the chain once; sync usually takes days"
echo "  Lottery RPC credentials saved to:"
echo "    $LOTTERY_CONFIG"
echo ""
echo "You can keep using Practice mode without doing any of this."
echo ""
echo "Next steps for Live mode:"
echo "  1. Install ₿itcoin Core: https://bitcoin.org/en/download"
echo "  2. Open ₿itcoin Core once — it reads $CONF automatically"
echo "  3. Wait for initial sync (old blocks are pruned as it validates)"
echo "  4. Check readiness:  $ROOT/scripts/check-node.sh"
echo "  5. Open ₿itcoin Lottery → payout wallet → Live mode → Save"
echo ""
echo "Faster sync (advanced): ₿itcoin Core AssumeUTXO snapshots — see doc/assumeutxo.md in ₿itcoin Core"