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
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request

# PyInstaller-frozen builds ignore PYTHONUTF8, and Windows pipes/consoles default to cp1252 — so any
# non-Latin-1 char we print (the → below, ₿, …) crashes with UnicodeEncodeError. Force UTF-8 on our streams.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO = pathlib.Path(__file__).resolve().parent.parent

# Cross-platform process stats for the miner (CPU%/RAM). Bundled in the packaged app; if unavailable,
# miner_proc just reports null instead of failing. (Replaces the old Unix-only pgrep/ps, absent on Windows.)
try:
    import psutil
except Exception:  # noqa: BLE001
    psutil = None


def miner_proc_stats():
    """CPU% / RAM the lottery miner daemon is using — to show it's a lottery ticket, not a mining rig.
    Matches the packaged 'miner'/'miner.exe' binary or a dev 'python lottery_miner.py'. None if not found."""
    if psutil is None:
        return None
    me = os.getpid()
    try:
        for p in psutil.process_iter(["name", "cmdline"]):
            if p.pid == me:
                continue  # never count the bridge itself
            name = (p.info.get("name") or "").lower()
            cmd = " ".join(p.info.get("cmdline") or []).lower()
            if name in ("miner", "miner.exe") or "lottery_miner" in cmd:
                return {"cpu": round(p.cpu_percent(interval=0.2), 1), "mem_mb": round(p.memory_info().rss / (1024 * 1024), 1)}
    except Exception:  # noqa: BLE001 — process vanished mid-scan / access denied
        return None
    return None
sys.path.insert(0, str(REPO))  # import the miner's real bech32 validator (single source of truth)
try:
    from lottery_miner import validate_payout_address as _validate_payout
except Exception:  # noqa: BLE001 — fall back to the format check below if it can't be imported
    _validate_payout = None
# where to publish node.json — overridable so the desktop app can write to a writable dir it serves
OUT = pathlib.Path(os.environ["NODE_BRIDGE_OUT"]) if os.environ.get("NODE_BRIDGE_OUT") else REPO / "web" / "node.json"
# data dir (config + state) — overridable to match the miner's LOTTERY_DATA_DIR (isolated desktop instance)
_DATA_DIR = pathlib.Path(os.environ["LOTTERY_DATA_DIR"]) if os.environ.get("LOTTERY_DATA_DIR") else pathlib.Path.home() / "Library/Application Support/BitcoinLottery"
CONFIG = _DATA_DIR / "config.json"
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
    return (c.get("rpc_url", "http://127.0.0.1:8332"), c.get("rpc_user", ""), c.get("rpc_pass", ""), c.get("rpc_cookie", ""))


def rpc(url, user, pw, method, params=None):
    payload = json.dumps({"jsonrpc": "1.0", "id": "bridge", "method": method, "params": params or []}).encode()
    auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", "Authorization": auth})
    with urllib.request.urlopen(req, timeout=10) as resp:  # short: a busy node (IBD flush) must not freeze node.json
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


WIN_CONFIRMATIONS = 6  # a found block is only CELEBRATED once it's buried this deep — safe from reorgs
_win_resolved = {}     # (height, hash) -> "confirmed" | "lost"  (terminal states cached; "pending" re-checked)


def win_status(url, user, pw, st, tip_height):
    """Resolve our most recent found-and-submitted block against the actual chain. A found block is NOT a
    win until it is buried WIN_CONFIRMATIONS deep. Returns {height, hash, status, confirmations, needs}:
      pending   — not in the chain yet, or in it but with < WIN_CONFIRMATIONS confirmations (still settling)
      confirmed — our hash IS the block at that height, buried deep enough — a real, settled win
      lost      — a DIFFERENT block won that height (duplicate / orphaned / beaten by seconds)
    or None if we have never found a block. confirmations lets the dashboard show settling progress."""
    wins = [(h["height"], h["hash_hex"]) for h in [st.get("last_attempt") or {}, *(st.get("history") or [])]
            if h.get("won") and h.get("mode") == "live" and h.get("height") and h.get("hash_hex")]
    if not wins:
        return None
    height, our_hash = max(wins)  # the most recent found block (highest height) is the one that matters
    key = (height, our_hash)
    if key in _win_resolved:
        return {"height": height, "hash": our_hash, "status": _win_resolved[key], "confirmations": WIN_CONFIRMATIONS, "needs": WIN_CONFIRMATIONS}
    try:
        chain_hash = rpc(url, user, pw, "getblockhash", [height])
    except Exception:  # noqa: BLE001 — not at that height yet → submitted, awaiting first confirmation
        return {"height": height, "hash": our_hash, "status": "pending", "confirmations": 0, "needs": WIN_CONFIRMATIONS}
    if chain_hash != our_hash:
        _win_resolved[key] = "lost"  # a different block holds this height — ours didn't make it
        return {"height": height, "hash": our_hash, "status": "lost", "confirmations": 0, "needs": WIN_CONFIRMATIONS}
    confs = max(0, tip_height - height + 1)
    if confs >= WIN_CONFIRMATIONS:
        _win_resolved[key] = "confirmed"  # settled — cache so we don't RPC every poll
        return {"height": height, "hash": our_hash, "status": "confirmed", "confirmations": confs, "needs": WIN_CONFIRMATIONS}
    return {"height": height, "hash": our_hash, "status": "pending", "confirmations": confs, "needs": WIN_CONFIRMATIONS}  # in the chain, still settling


def build(url, user, pw, cookie=""):
    # cookie auth: resolve to user:pass once here so every inner rpc() call uses it (read fresh each
    # poll, since the cookie rotates on each bitcoind restart).
    if not user and cookie:
        try:
            user, pw = pathlib.Path(cookie).read_text().strip().split(":", 1)
        except (OSError, ValueError):
            pass
    # the node may be unreachable (not set up yet / starting / down) — still publish the miner + payout
    # so the dashboard works during setup/sync, just with reachable=False.
    node_ok = True
    node_busy = False
    chain, peers_raw, mempool = {}, [], None
    try:
        chain = rpc(url, user, pw, "getblockchaininfo")  # the ONLY call that decides reachability — keep it cheap
    except Exception as e:  # noqa: BLE001
        node_ok = False
        # a TIMEOUT means the node is ALIVE but busy (e.g. a chainstate flush right after sync — slow on an
        # Intel Mac / spinning disk), NOT down. Flag it so publish() holds the last-good "synced" state instead
        # of flapping to "not connected" the way a real connection refusal should.
        reason = getattr(e, "reason", e)
        if isinstance(e, (TimeoutError, socket.timeout)) or isinstance(reason, (TimeoutError, socket.timeout)):
            node_busy = True
    if node_ok:
        try:
            peers_raw = rpc(url, user, pw, "getpeerinfo")
        except Exception:  # noqa: BLE001 — peers are best-effort; a hiccup here must not flip the node to "unreachable"
            peers_raw = []
    if node_ok and not chain.get("initialblockdownload", False):  # mempool isn't shown during sync — skip its 2 RPC calls so a busy node doesn't stall the poll
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
    nettotals = None
    if node_ok:
        try:  # cumulative bytes in/out since the node started — the dashboard graphs the rate from successive samples
            nt = rpc(url, user, pw, "getnettotals")
            nettotals = {"recv": int(nt.get("totalbytesrecv", 0)), "sent": int(nt.get("totalbytessent", 0)), "ms": int(nt.get("timemillis", 0))}
        except Exception:  # noqa: BLE001
            nettotals = None
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
                    "attempted_at": la.get("attempted_at"),  # ISO ts of the last ticket → dashboard "submitting?" status
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
                "history": [  # recent tickets (newest-first) for the YOUR TICKETS timeline; gaps in height = downtime
                    {"h": e.get("height"), "z": 256 - int(e["hash_hex"], 16).bit_length(), "w": bool(e.get("won")), "s": bool(e.get("submitted")), "at": e.get("attempted_at")}
                    for e in (st.get("history") or []) if e.get("mode") == "live" and e.get("hash_hex")
                ][:120],  # enough to fill the dashboard's ~100-block window (with margin); the miner keeps more on disk
                "win_status": win_status(url, user, pw, st, int(chain.get("blocks", 0))),  # {height, hash, status, confirmations, needs}
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
        "reachable": node_ok,
        "busy": node_busy,  # node alive but RPC timed out (post-sync flush) → publish() holds last-good instead of flapping
        "blocks": chain.get("blocks", 0),
        "headers": chain.get("headers", 0),
        "tip_time": chain.get("time", 0),  # tip block timestamp (epoch s) — lets the UI flag "behind" after sleep BEFORE headers refresh, when headers==blocks==stale tip
        "verificationprogress": chain.get("verificationprogress", 0.0),
        "initialblockdownload": chain.get("initialblockdownload", False),
        "size_on_disk": chain.get("size_on_disk", 0),
        "pruned": chain.get("pruned", False),
        "mempool": mempool,
        "nettotals": nettotals,
        "miner": miner,
        "miner_proc": miner_proc_stats(),  # CPU%/RAM the miner daemon uses — calms 'is this a mining rig?' fears
        # recent blocks carrying the /BitcoinLottery/ coinbase tag. Skipped during IBD: it's ~24 RPC calls that
        # stall on a busy syncing node (freezing node.json → "waiting for node"), and there's nothing to find yet.
        "lottery_blocks": (scan_lottery_blocks(url, user, pw) if node_ok and not chain.get("initialblockdownload", False) else []),
        "payout": payout,
        "peers": peers,
    }


def write(obj):
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(OUT)


# A busy syncing node periodically blocks RPC (cache flushes), so an occasional poll fails. Don't flap the
# dashboard to "disconnected" on a single miss — hold the last-known-good state for a few polls, and only
# declare the node unreachable after a sustained outage. Eliminates the connect/disconnect cycling during IBD.
_last_good = None
_consec_fail = 0
FAIL_GRACE = 5  # tolerate this many consecutive failed/unreachable polls before showing "disconnected" (~50s; covers long end-of-IBD chainstate flushes)


def publish(obj):
    """obj = a build() result, or None if build() raised. Debounces transient unreachability."""
    global _last_good, _consec_fail
    if obj is not None and obj.get("reachable"):
        _last_good, _consec_fail = obj, 0
        write(obj)
        return
    # a BUSY node (RPC timed out but it's alive — e.g. a long post-sync flush) is NOT down: hold the last-good
    # synced state without counting toward the disconnect threshold, so a flush never flaps to "not connected".
    if obj is not None and obj.get("busy") and _last_good is not None:
        held = dict(_last_good); held["ts"] = int(time.time()); held["stale"] = True
        write(held)
        return
    _consec_fail += 1
    if _last_good is not None and _consec_fail <= FAIL_GRACE:
        held = dict(_last_good)           # re-publish the last good state so the dashboard stays connected
        held["ts"] = int(time.time())
        held["stale"] = True             # flag it (dashboard ignores; useful for debugging)
        write(held)
    else:
        write(obj if obj is not None else {"ts": int(time.time()), "reachable": False, "error": "node unreachable", "peers": []})


def main():
    global _consec_fail
    lock = OUT.with_name("bridge.lock")
    try:
        lock.write_text(str(os.getpid()))  # claim single-writer ownership; a newer bridge overwrites this
    except OSError:
        pass
    url0, _, _, _ = load_rpc()
    print(f"node bridge → {OUT}  (rpc {url0}, every {POLL_SEC}s)")
    last_tick = time.time()
    while True:
        # if a newer bridge has started (e.g. after an in-place update) it has claimed the lock — exit so two
        # bridges never fight over node.json (the cause of the dashboard's "blinking" tickets after an update).
        try:
            if lock.read_text().strip() not in ("", str(os.getpid())):
                print("bridge: superseded by a newer instance — exiting", file=sys.stderr)
                return
        except OSError:
            pass
        now = time.time()
        # a wall-clock jump far larger than POLL_SEC means the machine just woke from sleep: bitcoind's peers
        # dropped and RPC may be briefly unready. Reset the failure counter so we keep showing last-good state
        # (which the UI now renders as "catching up" via the stale tip_time) instead of flashing "disconnected".
        if now - last_tick > max(60, POLL_SEC * 4):
            _consec_fail = 0
        last_tick = now
        try:
            url, user, pw, cookie = load_rpc()  # re-read each poll so wizard edits + cookie rotation are picked up live
            publish(build(url, user, pw, cookie))
        except Exception as e:  # noqa: BLE001 — keep running through transient RPC errors
            print(f"bridge: poll failed — {str(e)[:200]}", file=sys.stderr)  # detail (may carry RPC host/port) → stderr only
            publish(None)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
