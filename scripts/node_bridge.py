#!/usr/bin/env python3
"""Publish local bitcoind status to web/node.json for the browser dashboard.

Polls your node's getblockchaininfo + getpeerinfo (using the RPC creds the app
already stored) and writes web/node.json next to the dashboard, so the page can
read real peers / sync progress / disk usage same-origin. No external services.

Run alongside the dev server:  python3 scripts/node_bridge.py
"""
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent


def miner_proc_stats():
    """CPU% / RAM the lottery miner daemon is using — to show it's a lottery ticket, not a mining rig."""
    try:
        pid = subprocess.check_output(["pgrep", "-f", "lottery_miner.py"], text=True).split()[0]
        cpu, rss = subprocess.check_output(["ps", "-o", "%cpu=,rss=", "-p", pid], text=True).split()
        return {"cpu": round(float(cpu), 1), "mem_mb": round(int(rss) / 1024, 1)}
    except Exception:  # noqa: BLE001 — daemon not running / not found
        return None
sys.path.insert(0, str(REPO))  # import the miner's real bech32 validator (single source of truth)
try:
    from lottery_miner import validate_payout_address as _validate_payout
except Exception:  # noqa: BLE001 — fall back to the format check below if it can't be imported
    _validate_payout = None
OUT = REPO / "web" / "node.json"
CONFIG = pathlib.Path.home() / "Library/Application Support/BitcoinLottery/config.json"
POLL_SEC = 4
# fallback payout when the operator hasn't set their own wallet — must match
# DEFAULT_PAYOUT_ADDRESS in lottery_miner.py (rewards go to the project owner until a wallet is set).
DEFAULT_PAYOUT = "bc1qxs6dnz2tnnzv8m5nrsw76a53jh25svjsfph2fn"
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_B58_CHARSET = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

_prev_recv = {}  # addr -> bytesrecv, to detect active download per peer


def mask_addr(a):
    a = (a or "").strip()
    return a if len(a) <= 12 else f"{a[:6]}…{a[-6:]}"


def valid_btc_address(a):
    """True if the miner could actually pay this address. Uses the miner's real bech32/base58 checksum
    validator (catches single-char typos); falls back to a format check only if it can't be imported."""
    a = (a or "").strip()
    if not a:
        return False
    if _validate_payout is not None:
        try:
            _validate_payout(a)
            return True
        except Exception:  # noqa: BLE001 — invalid checksum, unsupported type, etc.
            return False
    if a.startswith("bc1"):
        body = a[3:].lower()
        return 39 <= len(a) <= 62 and bool(body) and all(c in _BECH32_CHARSET for c in body)
    if a[:1] in ("1", "3"):
        return 26 <= len(a) <= 35 and all(c in _B58_CHARSET for c in a)
    return False


def load_rpc():
    c = json.load(CONFIG.open()) if CONFIG.exists() else {}
    return (c.get("rpc_url", "http://127.0.0.1:8332"), c.get("rpc_user", ""), c.get("rpc_pass", ""))


def rpc(url, user, pw, method, params=None):
    payload = json.dumps({"jsonrpc": "1.0", "id": "bridge", "method": method, "params": params or []}).encode()
    auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", "Authorization": auth})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode())
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


LOTTERY_TAG = b"/BitcoinLottery/"  # the marker the miner writes into its coinbase scriptSig
_lottery_seen = {}      # height -> {"height", "hash"} for tagged blocks (the on-chain "someone won" signal)
_lottery_scanned = set()  # block hashes already checked, so we only do work when a new block arrives


def scan_lottery_blocks(url, user, pw, depth=12):
    """Read recent blocks' coinbase scriptSig for the lottery tag — purely from the local chain, no
    server, no phone-home. The win announces itself on-chain; we just read it."""
    try:
        h = rpc(url, user, pw, "getbestblockhash")
    except Exception:  # noqa: BLE001
        return sorted(_lottery_seen.values(), key=lambda x: x.get("height") or 0, reverse=True)[:10]
    for _ in range(depth):
        if not h or h in _lottery_scanned:
            break
        try:
            blk = rpc(url, user, pw, "getblock", [h, 1])  # txids only (light payload)
            cbtx = rpc(url, user, pw, "getrawtransaction", [blk["tx"][0], True, h])
            cb = bytes.fromhex(cbtx["vin"][0].get("coinbase", ""))
        except Exception:  # noqa: BLE001 — pruned past this block / RPC hiccup; stop walking back
            break
        _lottery_scanned.add(h)
        if LOTTERY_TAG in cb:
            _lottery_seen[blk.get("height")] = {"height": blk.get("height"), "hash": h}
        h = blk.get("previousblockhash")
    return sorted(_lottery_seen.values(), key=lambda x: x.get("height") or 0, reverse=True)[:10]


def build(url, user, pw):
    chain = rpc(url, user, pw, "getblockchaininfo")
    peers_raw = rpc(url, user, pw, "getpeerinfo")
    # mempool: transactions flowing in while the next block is mined (the "data coming in")
    try:
        mp = rpc(url, user, pw, "getmempoolinfo")
        mp_count = int(mp.get("size", 0))
        mp_prev = _prev_recv.get("__mp", mp_count)
        _prev_recv["__mp"] = mp_count
        # localrelay=False means blocksonly: the node receives whole blocks but no loose transactions
        try:
            relay = bool(rpc(url, user, pw, "getnetworkinfo").get("localrelay", True))
        except Exception:  # noqa: BLE001
            relay = True
        mempool = {"count": mp_count, "bytes": int(mp.get("bytes", 0)), "rate": round((mp_count - mp_prev) / POLL_SEC, 2), "relay": relay}
    except Exception:  # noqa: BLE001
        mempool = None
    peers = []
    for p in peers_raw:
        addr = p.get("addr", "?")
        recv = p.get("bytesrecv", 0)
        prev = _prev_recv.get(addr, recv)
        _prev_recv[addr] = recv
        rate = max(0, (recv - prev) / POLL_SEC)  # bytes/sec received from this peer
        downloading = bool(p.get("inflight")) or rate > 8_000
        peers.append({
            # opaque, stable per-peer id — the dashboard only needs a key, never the real IP. Publishing
            # raw peer IPs in a web-served file is a privacy/topology leak (deanonymization / eclipse aid).
            "addr": "peer-" + hashlib.sha256(addr.encode()).hexdigest()[:10],
            "inbound": bool(p.get("inbound", False)),
            "downloading": downloading,
            "rate": round(rate),
            "subver": p.get("subver", ""),
        })
    peers.sort(key=lambda x: x["addr"])  # stable order so the web doesn't shuffle peer positions
    # miner status from the lottery daemon's state.json, so the dashboard can show whether it's really live
    miner = None
    try:
        state_path = CONFIG.parent / "state.json"
        if state_path.exists():
            st = json.load(state_path.open())
            stats = st.get("stats", {})
            la = st.get("last_attempt") or {}
            disp = st.get("display") or {}
            win = disp.get("network_winner") or {}
            prox = disp.get("hash_proximity") or {}
            miner = {
                "mode": st.get("mode", "symbolic"),
                "seed": st.get("machine_seed", ""),  # so the dashboard derives the SAME nonce the daemon does
                "live_attempts": stats.get("live_attempts", 0),
                "total_attempts": stats.get("total_attempts", 0),
                "live_wins": stats.get("live_wins", 0),
                "payout": st.get("payout_address", ""),
                "attempt": {
                    "height": la.get("height"),
                    "hash": la.get("hash_hex"),
                    "target": la.get("target_hex"),
                    "nonce": la.get("nonce"),
                    "won": la.get("won"),
                    "leading_zero_bits": prox.get("leading_zero_bits"),
                    # full header fields → the dashboard can rebuild the exact 80-byte header we hashed
                    "version": la.get("version"),
                    "prev_hash": la.get("prev_hash"),
                    "merkle_root": la.get("merkle_root_hex"),
                    "timestamp": la.get("timestamp"),
                    "bits": la.get("bits"),
                    "tx_count": la.get("tx_count"),
                } if la else None,
                "winner": {
                    "hash": win.get("hash_hex"),
                    "prefix_match": win.get("prefix_match_chars"),
                } if win.get("hash_hex") else None,
                "best": st.get("best"),  # best-ever attempt: {zero_bits, height, hash, nonce, at}
                "zhist": st.get("zhist"),  # leading-zero-bits histogram {bits: count} for the heat map
            }
    except Exception:  # noqa: BLE001
        miner = None
    # payout for the dashboard footer: the operator's configured wallet, or the owner's default with a flag
    try:
        cfg_payout = (json.load(CONFIG.open()).get("payout_address") if CONFIG.exists() else "") or ""
    except Exception:  # noqa: BLE001
        cfg_payout = ""
    cfg_payout = cfg_payout.strip()
    effective = cfg_payout or DEFAULT_PAYOUT
    status = "ok" if valid_btc_address(effective) else "invalid"  # bc1q, legacy, and bc1p (taproot) all valid now
    payout = {"masked": mask_addr(effective), "is_default": not cfg_payout, "valid": status == "ok", "status": status}
    return {
        "ts": int(time.time()),
        "reachable": True,
        "blocks": chain.get("blocks", 0),
        "headers": chain.get("headers", 0),
        "verificationprogress": chain.get("verificationprogress", 0.0),
        "initialblockdownload": chain.get("initialblockdownload", False),
        "size_on_disk": chain.get("size_on_disk", 0),
        "pruned": chain.get("pruned", False),
        "mempool": mempool,
        "miner": miner,
        "miner_proc": miner_proc_stats(),  # CPU%/RAM the miner daemon uses — calms 'is this a mining rig?' fears
        "lottery_blocks": scan_lottery_blocks(url, user, pw),  # recent blocks carrying the /BitcoinLottery/ coinbase tag
        "payout": payout,
        "peers": peers,
    }


def write(obj):
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(OUT)


def main():
    url, user, pw = load_rpc()
    print(f"node bridge → {OUT}  (rpc {url}, every {POLL_SEC}s)")
    while True:
        try:
            write(build(url, user, pw))
        except Exception as e:  # noqa: BLE001 — keep running through transient RPC errors
            # generic message in the web-served file; the detail (which can carry the RPC host/port) goes to stderr only
            print(f"bridge: node unreachable — {str(e)[:200]}", file=sys.stderr)
            write({"ts": int(time.time()), "reachable": False, "error": "node unreachable", "peers": []})
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
