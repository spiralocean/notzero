#!/usr/bin/env python3
"""Publish local bitcoind status to web/node.json for the browser dashboard.

Polls your node's getblockchaininfo + getpeerinfo (using the RPC creds the app
already stored) and writes web/node.json next to the dashboard, so the page can
read real peers / sync progress / disk usage same-origin. No external services.

Run alongside the dev server:  python3 scripts/node_bridge.py
"""
import base64
import json
import pathlib
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "web" / "node.json"
CONFIG = pathlib.Path.home() / "Library/Application Support/BitcoinLottery/config.json"
POLL_SEC = 4

_prev_recv = {}  # addr -> bytesrecv, to detect active download per peer


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
            "addr": addr,
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
            miner = {
                "mode": st.get("mode", "symbolic"),
                "live_attempts": stats.get("live_attempts", 0),
                "total_attempts": stats.get("total_attempts", 0),
                "live_wins": stats.get("live_wins", 0),
                "payout": st.get("payout_address", ""),
            }
    except Exception:  # noqa: BLE001
        miner = None
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
            write({"ts": int(time.time()), "reachable": False, "error": str(e)[:200], "peers": []})
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
