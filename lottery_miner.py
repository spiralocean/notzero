#!/usr/bin/env python3
"""
Bitcoin Lottery Miner — 1 hash per block cycle.

Watches for new Bitcoin blocks and performs exactly one SHA-256d hash
attempt per block, like buying one lottery ticket per drawing.

Modes:
  symbolic  — uses public APIs only; demonstrates the lottery (no submission)
  live      — uses Bitcoin Core RPC for real getblocktemplate + submitblock
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import p2p_broadcast  # local: direct P2P block broadcast — last-resort submission gateway when node RPC is down

# PyInstaller-frozen builds ignore PYTHONUTF8, and Windows pipes/consoles default to cp1252 — so any
# non-Latin-1 char we print (₿, →, …) crashes with UnicodeEncodeError. Force UTF-8 on our streams.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

MEMPOOL_API = "https://mempool.space/api"


def brand(text: str) -> str:
    import re

    text = text.replace("BITCOIN", "₿ITCOIN")
    return re.sub(r"(?<![/.-])Bitcoin(?![-]|Lottery|lottery)", "₿itcoin", text)
DIFFICULTY_1_TARGET = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
# data dir (config + state + logs) — overridable so the desktop app runs an isolated instance
APP_SUPPORT = Path(os.environ["LOTTERY_DATA_DIR"]) if os.environ.get("LOTTERY_DATA_DIR") else Path.home() / "Library" / "Application Support" / "BitcoinLottery"
STATE_FILE = APP_SUPPORT / "state.json"
CONFIG_FILE = APP_SUPPORT / "config.json"
LOG_FILE = APP_SUPPORT / "daemon.log"
DEFAULT_CONFIG_FILE = Path(__file__).resolve().parent / "config.default.json"
HISTORY_LIMIT = 1000  # long on-disk record: seeds the odds-map cloud (zhist) richly + retained for future use
# (was 50, then 200; dashboard graph still shows ~100, bridge sends ~120 — this only affects the stored record)
BEST_HISTORY_LIMIT = 64  # every time the record improves, one entry — records get exponentially rarer, so 64
# covers a lifetime of mining. Kept apart from `history` deliberately: that window rolls over, and a record
# that scrolled off it is still the record.
PRICE_HISTORY_LIMIT = 96
POLL_INTERVAL_SEC = 30
# How long to wait on mempool.space for the chain tip. Two numbers, because the call has two jobs.
# When we have no node of our own — symbolic mode, or a node that is not ready yet — the public tip IS the
# thing that triggers an attempt, and waiting for it is the right call. When our own node is serving the tip,
# this call is display only, and a slow route to a third party has no business holding up the loop that
# exists to attempt blocks. Measured on a real install 2026-08-12: two stalls of 11s and 13s reported as
# "BLOCKED in 'mempool.space tip'", each eating a third of a 30s cycle for a number nothing was waiting on.
TIP_TIMEOUT_SEC = 15          # it is the trigger — be patient
TIP_DISPLAY_TIMEOUT_SEC = 4   # it is decoration — give up early and get on with the poll
# Backoff (seconds) between submitblock retries for a WON block. Aggressive early — a transient RPC blip
# (node restarting) usually clears in a few seconds and the ~10-min window is unforgiving — then eased and
# capped at 30s so we never hammer the node. We keep retrying until it lands or the height is taken.
RESUBMIT_DELAYS = (1, 2, 4, 8, 16, 30)
RESUBMIT_DEADLINE_SEC = 20 * 60  # give up after ~2 block windows if we simply can't reach the node
P2P_REBROADCAST_SEC = 45   # while the node RPC keeps failing, re-push the block to fresh peers this often
CONFIRM_INTERVAL_SEC = 20  # how often to ask the public network whether our block has landed (via any gateway)
DEFAULT_PRICE_POLL_MIN = 15
AVG_BLOCK_SEC = 600
# fallback payout when the operator hasn't set their own wallet — rewards go to the project owner.
# Keep in sync with DEFAULT_PAYOUT in scripts/node_bridge.py (the dashboard reads that one).
DEFAULT_PAYOUT_ADDRESS = "bc1qxs6dnz2tnnzv8m5nrsw76a53jh25svjsfph2fn"
CEREMONY_SEC = 3
HALVING_INTERVAL = 210_000
INITIAL_SUBSIDY_BTC = 50.0
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


@dataclass
class BlockAttempt:
    height: int
    prev_hash: str
    bits: int
    nonce: int
    hash_hex: str
    target_hex: str
    won: bool
    mode: str
    attempted_at: str = ""
    merkle_root_hex: str = ""
    tx_count: int = 0
    version: int = 0       # full header field, so the dashboard can rebuild the exact header we hashed
    timestamp: int = 0
    submitted: bool = False  # for a won block: did submitblock accept it (vs duplicate / error)?

    def to_dict(self) -> dict:
        return asdict(self)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_app_support() -> None:
    APP_SUPPORT.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    ensure_app_support()
    if CONFIG_FILE.exists():
        with CONFIG_FILE.open() as f:
            config = json.load(f)
    elif DEFAULT_CONFIG_FILE.exists():
        with DEFAULT_CONFIG_FILE.open() as f:
            config = json.load(f)
    else:
        config = {
            "version": 1,
            "mode": "symbolic",
            "payout_address": "",
            "rpc_url": "http://127.0.0.1:8332",
            "rpc_user": "",
            "rpc_pass": "",
            "machine_seed": "",
        }
    config.setdefault("version", 1)
    config.setdefault("mode", "symbolic")
    config.setdefault("payout_address", "")
    config.setdefault("rpc_url", "http://127.0.0.1:8332")
    config.setdefault("rpc_user", "")
    config.setdefault("rpc_pass", "")
    config.setdefault("rpc_cookie", "")  # path to bitcoind's .cookie — used when user/pass are blank
    config.setdefault("coinbase_tag", "")  # operator's vanity message stamped into the coinbase scriptSig
    config.setdefault("machine_seed", "")
    config.setdefault("price_poll_interval_min", DEFAULT_PRICE_POLL_MIN)
    config.setdefault("menu_bar_display", "block")
    config.setdefault("notifications_enabled", True)
    config.setdefault("notify_closeness_above_zero", True)
    config.setdefault("notify_block_won", True)
    config.setdefault("p2p_fallback", True)  # on a win, also push the block straight to the P2P network
    config.setdefault("notify_node_synced", True)
    config.setdefault("notify_node_out_of_sync", True)
    return config


def price_poll_interval_sec(config: dict) -> int:
    minutes = int(config.get("price_poll_interval_min", DEFAULT_PRICE_POLL_MIN))
    return max(60, min(86400, minutes * 60))


def save_config(config: dict) -> None:
    ensure_app_support()
    tmp = CONFIG_FILE.with_suffix(".tmp")
    with tmp.open("w") as f:
        json.dump(config, f, indent=2)
    tmp.replace(CONFIG_FILE)
    os.chmod(CONFIG_FILE, 0o600)  # holds rpc_pass — owner-only, not world-readable


def mask_address(address: str) -> str:
    address = address.strip()
    if len(address) <= 12:
        return address
    return f"{address[:6]}…{address[-6:]}"


def validate_payout_address(address: str) -> str:
    address = address.strip()
    if not address:
        raise ValueError("Payout address is required for live mode")
    address_to_script_pubkey(address)
    return address


def normalize_stats(state: dict) -> dict:
    stats = state.get("stats", {"total_attempts": 0, "wins": 0})
    if "live_attempts" not in stats:
        history = state.get("history", [])
        stats["live_attempts"] = sum(1 for h in history if h.get("mode") == "live")
        stats["live_wins"] = sum(1 for h in history if h.get("mode") == "live" and h.get("won"))
    stats.setdefault("live_attempts", 0)
    stats.setdefault("live_wins", 0)
    state["stats"] = stats
    if "best" not in state:  # seed the best-ever (most leading zero bits) from recent history
        best = None
        for h in state.get("history", []):
            hh = h.get("hash_hex")
            if h.get("mode") == "live" and hh:
                z = 256 - int(hh, 16).bit_length()
                if best is None or z > best["zero_bits"]:
                    best = {"zero_bits": z, "height": h.get("height"), "hash": hh, "nonce": h.get("nonce"), "at": h.get("attempted_at")}
        if best:
            state["best"] = best
    if "best_history" not in state:  # seed the record-by-record ladder (WHEN each best was set) from stored history
        ladder: list[dict] = []
        for h in reversed(state.get("history", [])):  # history is newest-first; records are read oldest-first
            hh = h.get("hash_hex")
            if h.get("mode") != "live" or not hh:
                continue
            z = 256 - int(hh, 16).bit_length()
            if ladder and z <= ladder[-1]["zero_bits"]:
                continue
            # seeded=True: reconstructed from the stored ticket window, not observed live. The FIRST entry is
            # especially soft — it is only a "record" because nothing older is on disk to beat it.
            ladder.append({"zero_bits": z, "height": h.get("height"), "hash": hh, "nonce": h.get("nonce"), "at": h.get("attempted_at"), "seeded": True})
        best = state.get("best")  # a record set before the stored window still belongs on the ladder
        if best and best.get("hash") and (not ladder or ladder[-1].get("hash") != best.get("hash")) and best.get("zero_bits", -1) > (ladder[-1]["zero_bits"] if ladder else -1):
            ladder.append(dict(best))
        state["best_history"] = ladder[-BEST_HISTORY_LIMIT:]
    if "zhist" not in state:  # seed the leading-zero-bits histogram (heat map) from recent history
        zh: dict[str, int] = {}
        for h in state.get("history", []):
            hh = h.get("hash_hex")
            if h.get("mode") == "live" and hh:
                z = 256 - int(hh, 16).bit_length()
                zh[str(z)] = zh.get(str(z), 0) + 1
        state["zhist"] = zh
    return state


def load_state() -> dict:
    ensure_app_support()
    if STATE_FILE.exists():
        with STATE_FILE.open() as f:
            state = json.load(f)
            return normalize_stats(state)
    return {
        "version": 1,
        "history": [],
        "stats": {"total_attempts": 0, "wins": 0, "live_attempts": 0, "live_wins": 0},
    }


# ---- single-writer lock: only one miner per data directory -------------------------------------------------
#
# Two miners sharing a data dir both write state.json, and last-writer-wins turns the ticket history into a
# mix of two machines' work. Seen for real: the app aborted on 2026-08-09, macOS reparented its miner to pid 1
# instead of killing it, and the relaunched app started a second one. They ran side by side for a day, both
# ticketing the same blocks with different nonces.
#
# The bridge has solved this since the "blinking tickets after an update" bug (node_bridge.py, bridge.lock) and
# the miner was simply never given the same treatment. Same design, deliberately:
#
#   - the NEWEST instance wins. It writes its pid and carries on.
#   - the older one notices on its next pass and exits ITSELF. Nothing hunts processes, nothing sends signals,
#     so there is no way to misidentify a miner somebody set up themselves and kill it.
#   - the lock is a file in THIS data directory. A separate miner with its own data dir never reads or writes
#     it and is completely invisible to this. Anyone deliberately running two against one data dir gets the
#     newer one, which is the only sane reading of that request anyway.
#
# A stale lock from a crash needs no cleanup: it holds a dead pid, the next miner overwrites it, and nobody
# ever asks whether that pid is alive — which is what makes this safe without process inspection.
LOCK_FILE = APP_SUPPORT / "miner.lock"


def claim_miner_lock() -> None:
    ensure_app_support()
    try:
        LOCK_FILE.write_text(str(os.getpid()))
    except OSError:
        pass  # unwritable data dir -> run without the guard rather than refuse to mine


def superseded_by_newer_miner() -> bool:
    """True once a newer miner has claimed this data dir. Unreadable/missing lock -> assume not."""
    try:
        held = LOCK_FILE.read_text().strip()
    except OSError:
        return False
    return held not in ("", str(os.getpid()))


def save_state(state: dict) -> None:
    ensure_app_support()
    tmp = STATE_FILE.with_suffix(".tmp")
    with tmp.open("w") as f:
        json.dump(state, f, indent=2)
    tmp.replace(STATE_FILE)
    os.chmod(STATE_FILE, 0o600)


def save_winning_block(height: int, block_hex: str) -> Path:
    """Persist a found block to disk BEFORE submitting, so a transient RPC/network error can never lose
    the one event the whole program exists for. The hex can be re-submitted manually."""
    ensure_app_support()
    path = APP_SUPPORT / f"won_block_{height}.hex"
    path.write_text(block_hex)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def pending_won_files() -> list[tuple[int, Path]]:
    """Saved won blocks still awaiting confirmation. A resolved block is renamed (won_block_<h>.accepted /
    .duplicate / .superseded / .expired) so it stays on disk as a record but is no longer retried."""
    out = []
    for p in APP_SUPPORT.glob("won_block_*.hex"):
        tail = p.stem.rsplit("_", 1)[-1]  # won_block_<h> → <h>
        if tail.isdigit():
            out.append((int(tail), p))
    return out


def _mark_won_resolved(path: Path, outcome: str) -> None:
    """A pending won block reached a terminal state — rename so it's kept for the record but not retried."""
    try:
        path.rename(path.with_suffix("." + outcome))
    except OSError:
        pass


def _node_tip_height(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str) -> Optional[int]:
    try:
        return int(rpc_call(rpc_url, rpc_user, rpc_pass, "getblockcount", [], cookie=rpc_cookie))
    except Exception:  # noqa: BLE001 — best-effort tip check
        return None


def _block_hash_from_hex(block_hex: str) -> str:
    """The block's display hash (big-endian) = reversed double-SHA256 of its 80-byte header."""
    try:
        header = bytes.fromhex(block_hex.strip())[:80]
    except ValueError:
        return ""
    if len(header) < 80:
        return ""
    return hashlib.sha256(hashlib.sha256(header).digest()).digest()[::-1].hex()


def _block_on_network(block_hash: str) -> bool:
    """Independently confirm a block reached the network via a public explorer — works even if our node is down,
    and regardless of which gateway (RPC or P2P) actually delivered it."""
    if not block_hash:
        return False
    try:
        blk = http_get(f"{MEMPOOL_API}/block/{block_hash}", timeout=15)
        return isinstance(blk, dict) and str(blk.get("id", "")).lower() == block_hash.lower()
    except Exception:  # noqa: BLE001 — 404/timeout → not (yet) seen
        return False


def _network_tip_height() -> Optional[int]:
    try:
        return int(http_get(f"{MEMPOOL_API}/blocks/tip/height", timeout=15))
    except Exception:  # noqa: BLE001
        return None


def _node_peer_addrs(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str, limit: int = 40) -> list:
    """IPv4 peers our node is connected to (getpeerinfo) or knows (getnodeaddresses) — reachable, well-connected
    broadcast targets. Best-effort; empty if the node RPC is unavailable, in which case the DNS-seed peers carry
    the block on their own."""
    peers: list = []
    seen: set = set()

    def _add(ip: str, port) -> None:
        if ip and "." in ip and ":" not in ip and not ip.endswith(".onion") and ip not in seen:
            seen.add(ip)
            try:
                peers.append((ip, int(port) if port else p2p_broadcast.DEFAULT_PORT))
            except (TypeError, ValueError):
                peers.append((ip, p2p_broadcast.DEFAULT_PORT))

    try:
        for pi in rpc_call(rpc_url, rpc_user, rpc_pass, "getpeerinfo", [], cookie=rpc_cookie):
            addr = str(pi.get("addr", ""))
            if addr.startswith("[") or ".onion" in addr:  # skip IPv6 / Tor
                continue
            host, _, port = addr.rpartition(":")
            _add(host, port)
    except Exception:  # noqa: BLE001
        pass
    try:
        for a in rpc_call(rpc_url, rpc_user, rpc_pass, "getnodeaddresses", [limit], cookie=rpc_cookie):
            if a.get("network") == "ipv4":
                _add(str(a.get("address", "")), a.get("port"))
    except Exception:  # noqa: BLE001
        pass
    return peers[:limit]


def _broadcast_with_node_peers(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str, block_hex: str) -> None:
    """Broadcast a won block over P2P, seeding the peer list with our node's own reachable peers (when RPC is up)
    so it hits well-connected nodes first, then the DNS-seed peers. Meant to run in its own thread."""
    extra = _node_peer_addrs(rpc_url, rpc_user, rpc_pass, rpc_cookie)
    p2p_broadcast.broadcast_block(block_hex, log=log_daemon, extra_peers=extra)


def _resubmit_worker(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str, height: int, path: Path, p2p_enabled: bool = True) -> None:
    """Do WHATEVER IT TAKES to land a saved won block: keep calling submitblock on the node AND — while the node
    keeps failing — push the raw block straight to the P2P network, until an explorer confirms our block is on
    the chain, the node accepts it, or another block fills the height. Own thread, timing independent of the 30s
    mining poll: a win is once in a lifetime and the window before a competing block lands is ~10 min, so we
    retry hard early. Gives up only after RESUBMIT_DEADLINE_SEC of a fully unreachable world (block is stale by
    then; the hex is kept for manual recovery)."""
    try:
        block_hex = path.read_text().strip()
    except OSError:
        return
    block_hash = _block_hash_from_hex(block_hex)
    deadline = time.monotonic() + RESUBMIT_DEADLINE_SEC
    attempt = 0
    last_p2p = 0.0
    last_confirm = 0.0
    while time.monotonic() < deadline:
        now = time.monotonic()
        # primary gateway — submit through our own node
        try:
            result = rpc_call(rpc_url, rpc_user, rpc_pass, "submitblock", [block_hex], cookie=rpc_cookie)
        except Exception as exc:  # noqa: BLE001
            result = f"error: {exc}"
        if not result:
            log_daemon(f"✅ Won block #{height} ACCEPTED via node RPC — it's on the network.")
            _mark_won_resolved(path, "accepted")
            return
        if result == "duplicate":
            log_daemon(f"✅ Won block #{height} already in the chain (duplicate) — done.")
            _mark_won_resolved(path, "duplicate")
            return
        # independent confirmation — did our block land, via ANY gateway? (throttled)
        if block_hash and now - last_confirm >= CONFIRM_INTERVAL_SEC:
            last_confirm = now
            if _block_on_network(block_hash):
                log_daemon(f"✅ Won block #{height} CONFIRMED on the network ({block_hash[:12]}…) — done.")
                _mark_won_resolved(path, "accepted")
                return
        # node isn't taking it → push straight to the P2P network, re-pushing to fresh peers periodically
        if p2p_enabled and now - last_p2p >= P2P_REBROADCAST_SEC:
            last_p2p = now
            log_daemon(f"Node RPC failing ('{result}') — pushing won block #{height} to the P2P network directly.")
            threading.Thread(target=_broadcast_with_node_peers, args=(rpc_url, rpc_user, rpc_pass, rpc_cookie, block_hex), daemon=True).start()
        # has another block already filled this height? (node tip, else the public tip) — ours would be caught above
        tip = _node_tip_height(rpc_url, rpc_user, rpc_pass, rpc_cookie)
        if tip is None:
            tip = _network_tip_height()
        if tip is not None and tip >= height:
            log_daemon(f"⚠ Won block #{height} lost the race — height filled at tip {tip}. Hex kept for the record.")
            _mark_won_resolved(path, "superseded")
            return
        delay = RESUBMIT_DELAYS[min(attempt, len(RESUBMIT_DELAYS) - 1)]
        attempt += 1
        log_daemon(f"⚠ Resubmit #{attempt} of won block #{height} via RPC failed ('{result}') — retry in {delay}s.")
        time.sleep(delay)
    log_daemon(f"⚠ Won block #{height}: gave up after {RESUBMIT_DEADLINE_SEC // 60} min (network/node unreachable?). Hex kept: {path}")
    _mark_won_resolved(path, "expired")


def spawn_resubmit(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str, height: int, path: Path, p2p_enabled: bool = True) -> None:
    """Start a background resubmit worker for a won block (daemon thread — the .hex on disk is the durable state,
    so if the process exits mid-retry, rescue_pending_won_blocks() picks it back up on the next launch)."""
    threading.Thread(
        target=_resubmit_worker,
        args=(rpc_url, rpc_user, rpc_pass, rpc_cookie, height, path, p2p_enabled),
        daemon=True,
    ).start()


def rescue_pending_won_blocks(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str, p2p_enabled: bool = True) -> None:
    """On startup, resume auto-resubmit (node RPC + direct P2P) for any won block left unconfirmed by a crash/quit."""
    for height, path in pending_won_files():
        log_daemon(f"Found unsubmitted won block #{height} on disk — resuming auto-resubmit (RPC + P2P).")
        spawn_resubmit(rpc_url, rpc_user, rpc_pass, rpc_cookie, height, path, p2p_enabled)


def log_daemon(message: str) -> None:
    ensure_app_support()
    line = f"[{utc_now()}] {message}\n"
    with LOG_FILE.open("a", encoding="utf-8") as f:  # messages can carry ₿/—; default cp1252 on Windows would crash
        f.write(line)
    if not getattr(log_daemon, "_quiet", False):
        print(line, end="")


def record_attempt(state: dict, attempt: BlockAttempt, machine_seed: str, mode: str) -> dict:
    attempt.attempted_at = utc_now()
    note_ticket(attempt.height)  # the one point every ticket passes through — the monitor's "still working" signal
    state.update(
        {
            "version": 1,
            "machine_seed": machine_seed,
            "mode": mode,
            "last_poll_at": utc_now(),
            "last_attempt": attempt.to_dict(),
        }
    )
    history = state.get("history", [])
    history.insert(0, attempt.to_dict())
    state["history"] = history[:HISTORY_LIMIT]
    stats = state.get("stats", {"total_attempts": 0, "wins": 0, "live_attempts": 0, "live_wins": 0})
    stats["total_attempts"] = stats.get("total_attempts", 0) + 1
    if attempt.won:
        stats["wins"] = stats.get("wins", 0) + 1
    if mode == "live":
        stats["live_attempts"] = stats.get("live_attempts", 0) + 1
        if attempt.won:
            stats["live_wins"] = stats.get("live_wins", 0) + 1
    state["stats"] = stats
    if mode == "live" and attempt.hash_hex:  # track the best-ever attempt + the leading-zero-bits histogram
        z = 256 - int(attempt.hash_hex, 16).bit_length()
        best = state.get("best")
        if best is None or z > best.get("zero_bits", -1):
            record = {"zero_bits": z, "height": attempt.height, "hash": attempt.hash_hex, "nonce": attempt.nonce, "at": attempt.attempted_at}
            state["best"] = record
            ladder = state.setdefault("best_history", [])
            ladder.append(dict(record))  # the ladder is the record's history: one entry per improvement, oldest-first
            state["best_history"] = ladder[-BEST_HISTORY_LIMIT:]
        zh = state.setdefault("zhist", {})
        zh[str(z)] = zh.get(str(z), 0) + 1
    state = update_display_stats(state, new_block=True)
    winner = fetch_network_winner(attempt.height, attempt.hash_hex)
    if winner:
        display = state.get("display", {})
        display["network_winner"] = winner
        state["display"] = display
    save_state(state)
    return state


# HTTPS trust store. A PyInstaller build only ships CA certs if `certifi` was in the build env — the first CI
# build wasn't, so mempool.space calls failed SSL verification ("unable to get local issuer certificate") and
# the miner stalled. Use certifi's bundle when present (PyInstaller collects its cacert.pem via this import),
# else fall back to the system trust store.
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()


# Prefer IPv4. Some home/VPS networks have silently broken IPv6 routes to the public APIs (seen live:
# several of mempool.space's AAAA addresses SYN-blackhole from a Hetzner box while IPv4 answers in ms).
# urllib tries getaddrinfo results in order and burns the full connect timeout on every dead address, so
# one http_get could stall for minutes and drag the whole poll loop with it — tickets went out 10-20 min
# after blocks arrived. IPv6-only networks still work: v6 addresses stay in the list, just after v4.
_real_getaddrinfo = socket.getaddrinfo


def _ipv4_first_getaddrinfo(*args, **kwargs):
    infos = _real_getaddrinfo(*args, **kwargs)
    return sorted(infos, key=lambda info: 0 if info[0] == socket.AF_INET else 1)  # stable: keeps order within each family


socket.getaddrinfo = _ipv4_first_getaddrinfo


# ---- stall reporting: say what is wrong WHILE it is wrong ------------------------------------------------
#
# The first version of this timed each step and logged after the loop body finished. That cannot fire for the
# case it was built for. The app restarts a hung miner with SIGTERM at about 20 minutes, and a killed process
# never reaches the end of its loop — Python does not run finally blocks on a default SIGTERM either. On
# 2026-08-07 a 20-minute hang under that build produced no line at all, which is how the flaw surfaced.
#
# So report from OUTSIDE the loop. A monitor thread watches the step currently in flight and speaks up while
# it is still stuck, and a SIGTERM handler gets the last word if the watchdog reaches it first.
#
# It also has to separate two failures that look identical from the outside — total silence:
#   BLOCKED    the loop is parked inside one call (a network read, a DNS lookup that ignores its timeout)
#   IDLE       the loop is cycling perfectly well but never sees a new height, so never makes a ticket
# Those want opposite fixes, and nothing in the logs today distinguishes them.
SLOW_STEP_SEC = 10.0        # a step in flight this long is stuck, not slow; a healthy one is well under a second
STALL_CHECK_SEC = 15.0      # how often the monitor looks
IDLE_REPORT_SEC = 900.0     # polls completing but no ticket for this long -> report IDLE, not BLOCKED

_stall_lock = threading.Lock()
_stall = {"step": None, "at": 0.0, "said_blocked": False, "said_idle": False,
          "poll_done": 0.0, "ticket_at": 0.0, "tip": 0, "attempt_h": 0}


def _timed(label: str, fn, *args, **kwargs):
    """Run fn while recording that it is in flight, so the monitor can name it if it never returns."""
    with _stall_lock:
        _stall["step"] = label
        _stall["at"] = time.monotonic()
        _stall["said_blocked"] = False
    try:
        return fn(*args, **kwargs)
    finally:
        with _stall_lock:
            _stall["step"] = None


def note_poll_done(tip_height: Optional[int] = None) -> None:
    # Records that the loop got all the way round, and the tip it saw. Deliberately does NOT clear said_idle:
    # an idle episode is defined by polls completing, so re-arming on every poll made it re-report every check.
    # Only a ticket — an actual recovery — ends the episode.
    with _stall_lock:
        _stall["poll_done"] = time.monotonic()
        if tip_height:
            _stall["tip"] = int(tip_height)


def note_ticket(height: Optional[int] = None) -> None:
    with _stall_lock:
        _stall["ticket_at"] = time.monotonic()
        _stall["said_idle"] = False
        if height:
            _stall["attempt_h"] = int(height)


def _stall_monitor(log) -> None:
    while True:
        time.sleep(STALL_CHECK_SEC)
        try:
            now = time.monotonic()
            with _stall_lock:
                step, at, said_blocked = _stall["step"], _stall["at"], _stall["said_blocked"]
                poll_done, ticket_at, said_idle = _stall["poll_done"], _stall["ticket_at"], _stall["said_idle"]
                if step and not said_blocked and now - at >= SLOW_STEP_SEC:
                    _stall["said_blocked"] = True
                    msg = f"BLOCKED in '{step}' for {now - at:.0f}s and still waiting — the poll loop is stuck here"
                elif (not step and not said_idle and poll_done and ticket_at
                      and now - poll_done < STALL_CHECK_SEC * 4 and now - ticket_at >= IDLE_REPORT_SEC
                      and _stall["tip"] and _stall["attempt_h"] and _stall["tip"] >= _stall["attempt_h"]):
                    # Polls are finishing, so nothing is blocked. But "no ticket for a while" is NOT itself
                    # wrong — blocks are ~10 min apart and a 25-minute gap is ordinary, so time alone says
                    # nothing. The miner builds tip+1, so it is only behind once the tip has REACHED what it is
                    # working on. Height is the test; the clock just decides how long to wait before saying so.
                    _stall["said_idle"] = True
                    msg = (f"IDLE — polls completing (last {now - poll_done:.0f}s ago), no ticket for "
                           f"{(now - ticket_at) / 60:.0f}m, and the tip (#{_stall['tip']}) has caught up with "
                           f"what the miner is building (#{_stall['attempt_h']}): not stuck in a call, not seeing the new block")
                else:
                    msg = None
            if msg:
                log(msg)
        except Exception:  # noqa: BLE001 — a reporting thread must never be the thing that kills the miner
            pass


def install_stall_reporting(log) -> None:
    """Start the monitor, and make SIGTERM say what was in flight on the way out.

    The watchdog kill is the single most reliable moment we know something is wrong, and until now it was the
    one moment that recorded nothing. The handler logs, then restores the default and re-raises, so the exit
    is byte-for-byte what it was before — this adds a line, it does not change how the miner dies.
    """
    import signal

    def _on_term(signum, _frame):
        try:
            with _stall_lock:
                step, at = _stall["step"], _stall["at"]
            if step:
                log(f"terminated while in '{step}' after {time.monotonic() - at:.0f}s")
            else:
                log("terminated between steps — the poll loop was not blocked on a call")
        except Exception:  # noqa: BLE001
            pass
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    try:
        signal.signal(signal.SIGTERM, _on_term)
    except (ValueError, OSError):
        pass  # not the main thread, or a platform without it — the monitor still runs
    threading.Thread(target=_stall_monitor, args=(log,), daemon=True, name="stall-monitor").start()


def http_get(url: str, timeout: int = 30) -> dict | list | str:
    req = urllib.request.Request(url, headers={"User-Agent": "bitcoin-lottery-miner/0.1"})
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
        body = resp.read().decode()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return body.strip()


def rpc_call(url: str, user: str, password: str, method: str, params: list | None = None, cookie: str = "") -> dict:
    payload = json.dumps({"jsonrpc": "1.0", "id": "lottery", "method": method, "params": params or []}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": _auth_header(user, password, cookie)},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    if body.get("error"):
        raise RuntimeError(body["error"])
    return body["result"]


def _auth_header(user: str, password: str, cookie: str = "") -> str:
    import base64

    # No user/pass set → use bitcoind's auto-generated cookie. It rotates every restart, so read it
    # fresh on each call. The file holds "__cookie__:<random>" — already the user:pass we need.
    if not user and cookie:
        try:
            creds = Path(cookie).read_text().strip()
        except OSError:
            creds = f"{user}:{password}"
    else:
        creds = f"{user}:{password}"
    return "Basic " + base64.b64encode(creds.encode()).decode()


def _base58_decode(value: str) -> bytes:
    num = 0
    for char in value:
        num = num * 58 + BASE58_ALPHABET.index(char)
    combined = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    pad = 0
    for char in value:
        if char == "1":
            pad += 1
        else:
            break
    return b"\x00" * pad + combined


def _bech32_polymod(values: list[int]) -> int:
    generator = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= generator[i]
    return chk


def _bech32_hrp_expand(hrp: str) -> list[int]:
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _convertbits(data: list[int], frombits: int, tobits: int, pad: bool = True) -> list[int]:
    acc = 0
    bits = 0
    ret: list[int] = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad and bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret


def _bech32_decode(address: str) -> tuple[int, bytes]:
    address = address.lower()
    if not address.startswith("bc1"):
        raise ValueError("Only mainnet bech32 addresses (bc1...) are supported")
    pos = address.rfind("1")
    if pos < 1 or pos + 7 > len(address):
        raise ValueError("Invalid bech32 address")
    hrp = address[:pos]
    try:
        data = [BECH32_CHARSET.index(char) for char in address[pos + 1 :]]
    except ValueError as exc:
        raise ValueError("Invalid bech32 character") from exc
    witness_version = data[0]
    # witness v0 (bc1q...) uses bech32; v1+ (bc1p... taproot) uses bech32m — BIP-350
    expected = 1 if witness_version == 0 else 0x2BC830A3
    if hrp != "bc" or _bech32_polymod(_bech32_hrp_expand(hrp) + data) != expected:
        raise ValueError("Invalid bech32 checksum")
    program = _convertbits(data[1:-6], 5, 8, False)
    # BIP-141: witness v0 is 20 bytes (P2WPKH) or 32 (P2WSH). Only 20 was allowed, so a perfectly valid P2WSH
    # receive address was refused — verified against Core, which accepts both.
    if witness_version == 0 and len(program) not in (20, 32):
        raise ValueError("segwit v0 program must be 20 bytes (P2WPKH) or 32 (P2WSH)")
    if witness_version == 1 and len(program) != 32:
        raise ValueError("Taproot (bc1p...) program must be 32 bytes")
    if witness_version > 1:
        raise ValueError("Unsupported witness version (only bc1q and bc1p are supported)")
    return witness_version, bytes(program)


def address_to_script_pubkey(address: str) -> bytes:
    address = address.strip()
    # BIP-173 addresses are case-insensitive, but MIXED case is invalid — and QR codes encode bech32 in
    # UPPERCASE because it packs better, so "scan the QR, paste it in" produced an uppercase address that this
    # rejected (the prefix test ran before _bech32_decode's lower()). Core accepts it; so must we.
    low = address.lower()
    if low.startswith(("bc1", "tb1")):
        if address != low and address != address.upper():
            raise ValueError("Mixed-case bech32 address — copy it exactly as your wallet shows it")
        witness_version, program = _bech32_decode(address)
        # OP_0 for v0 (P2WPKH), OP_1 for v1 (P2TR / taproot); then push the program
        opcode = 0x00 if witness_version == 0 else 0x50 + witness_version
        return bytes([opcode, len(program)]) + program
    decoded = _base58_decode(address)
    if len(decoded) != 25:
        raise ValueError("Invalid legacy address length")
    version, h160, checksum = decoded[0], decoded[1:21], decoded[21:]
    payload = bytes([version]) + h160
    if hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] != checksum:
        raise ValueError("Invalid legacy address checksum")
    if version == 0x00:
        return bytes([0x76, 0xA9, 0x14]) + h160 + bytes([0x88, 0xAC])
    if version == 0x05:
        return bytes([0xA9, 0x14]) + h160 + bytes([0x87])
    raise ValueError("Unsupported legacy address type")


def _encode_height(height: int) -> bytes:
    """BIP34 block height for the coinbase scriptSig, as a minimally-encoded CScriptNum.

    CScriptNum is SIGNED little-endian: if the most significant byte has its high bit set, a 0x00 sign byte
    must follow or the value reads as negative. That byte was missing, so any height whose top byte is >= 0x80
    produced a coinbase Core rejects with "bad-cb-height" — and the resubmit loop would then retry a block
    that can never land. Mainnet is unaffected at today's ~959k (0x0EA3F2, top byte 0x0E) and stays that way
    until height 8,388,608; regtest runs in exactly the affected range, which is how this surfaced.
    """
    if height == 0:
        return bytes([0x01, 0x00])
    raw = bytearray(height.to_bytes((height.bit_length() + 7) // 8, "little"))
    if raw[-1] & 0x80:
        raw.append(0x00)
    return bytes([len(raw)]) + bytes(raw)


def _serialize_varint(value: int) -> bytes:
    if value < 0xFD:
        return bytes([value])
    if value <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", value)
    if value <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", value)
    return b"\xff" + struct.pack("<Q", value)


def build_coinbase_transaction(
    height: int,
    coinbase_value: int,
    payout_script: bytes,
    witness_commitment_hex: Optional[str] = None,
    coinbase_tag: str = "",
) -> bytes:
    coinbase_value = int(coinbase_value)
    if not 0 <= coinbase_value < (1 << 64):  # guard struct.pack("<Q") — a bad template value must not crash us
        raise ValueError(f"coinbasevalue out of range: {coinbase_value}")
    # the operator's vanity tag (or the default). The BIP34 height push must come first; consensus caps the
    # whole scriptSig at 100 bytes, so trim the tag to whatever room is left after the height push.
    height_push = _encode_height(height)
    tag_bytes = (coinbase_tag or "").strip().encode("utf-8") or b"/BitcoinLottery/0.1/getnotzero.com/"
    tag_bytes = tag_bytes[: max(0, 100 - len(height_push))]
    script_sig = height_push + tag_bytes
    tx = struct.pack("<I", 2)
    tx += _serialize_varint(1)
    tx += b"\x00" * 32
    tx += struct.pack("<I", 0xFFFFFFFF)
    tx += _serialize_varint(len(script_sig)) + script_sig
    tx += struct.pack("<I", 0xFFFFFFFF)

    outputs: list[tuple[int, bytes]] = [(coinbase_value, payout_script)]
    if witness_commitment_hex:
        outputs.append((0, bytes.fromhex(witness_commitment_hex)))

    tx += _serialize_varint(len(outputs))
    for value, script in outputs:
        tx += struct.pack("<Q", value)
        tx += _serialize_varint(len(script)) + script
    tx += struct.pack("<I", 0)
    return tx


def bits_to_target(bits: int) -> int:
    exponent = bits >> 24
    mantissa = bits & 0xFFFFFF
    if exponent <= 3:
        return mantissa >> (8 * (3 - exponent))
    return mantissa << (8 * (exponent - 3))


def difficulty_to_target(difficulty: float) -> int:
    return int(DIFFICULTY_1_TARGET / difficulty)


def hash_block_header(
    version: int,
    prev_hash_hex: str,
    merkle_root_hex: str,
    timestamp: int,
    bits: int,
    nonce: int,
) -> bytes:
    prev = bytes.fromhex(prev_hash_hex)[::-1]
    merkle = bytes.fromhex(merkle_root_hex)[::-1]
    header = struct.pack("<I", version) + prev + merkle + struct.pack("<III", timestamp, bits, nonce)
    return hashlib.sha256(hashlib.sha256(header).digest()).digest()


def pick_nonce(block_height: int, machine_seed: str) -> int:
    """Deterministic 'lottery ticket' for this block on this machine."""
    seed = f"{machine_seed}:{block_height}".encode()
    digest = hashlib.sha256(seed).digest()
    return struct.unpack("<I", digest[:4])[0]


def check_win(hash_bytes: bytes, target: int) -> bool:
    """Does this header hash beat the target? Consensus reads the double-SHA256 digest LITTLE-endian.

    hash_block_header returns the raw digest, which is the internal byte order — the displayed block hash is
    that digest REVERSED. This compared it "big", i.e. the wrong end of the hash, and was wrong in both
    directions: a genuinely winning hash scored as a loss, and losing hashes scored as wins. The false wins
    are the visible half (submitblock answers "high-hash"); the silent half is the one that matters, because
    `won` is what gates the submit — a real block would have been found, displayed as JACKPOT by
    hash_proximity (which reverses correctly, and is why the two disagreed), and then never submitted.

    Verified against mainnet block 959,666: little-endian passes, big-endian does not. A block the network
    accepted must pass, so little-endian is the consensus rule. See tests/test_check_win.py.
    """
    return int.from_bytes(hash_bytes, "little") <= target


def get_tip_height(timeout: int = TIP_TIMEOUT_SEC) -> int:
    return int(http_get(f"{MEMPOOL_API}/blocks/tip/height", timeout=timeout))


def tip_timeout_sec(mode: str, node: Optional[dict]) -> int:
    """How long the poll loop should wait on mempool.space for the tip — see TIP_TIMEOUT_SEC.

    Short only when our own node is demonstrably serving the tip, because then the public number is
    decoration. Every other case — symbolic mode, a node still syncing, a node that just went away, no node
    state at all — keeps the patient timeout, since the public tip is what triggers the next attempt and
    cutting it short would cost real tickets. Wrong in the safe direction by construction.
    """
    node = node or {}
    if mode == "live" and node.get("ready") and node.get("blocks"):
        return TIP_DISPLAY_TIMEOUT_SEC
    return TIP_TIMEOUT_SEC


def get_block_hash(height: int) -> str:
    result = http_get(f"{MEMPOOL_API}/block-height/{height}")
    return result if isinstance(result, str) else str(result)


def fetch_btc_price() -> dict:
    data = http_get(f"{MEMPOOL_API}/v1/prices")
    if not isinstance(data, dict):
        raise RuntimeError("unexpected price response")
    return {
        "usd": float(data["USD"]),
        "updated_at": utc_now(),
        "source_time": int(data.get("time", 0)),
    }


def block_subsidy_btc(height: int) -> float:
    halvings = height // HALVING_INTERVAL
    if halvings >= 64:
        return 0.0
    return INITIAL_SUBSIDY_BTC / (2**halvings)


def halving_stats(height: int) -> dict:
    era = height // HALVING_INTERVAL
    next_height = (era + 1) * HALVING_INTERVAL
    blocks_until = max(0, next_height - height)
    progress = (height % HALVING_INTERVAL) / HALVING_INTERVAL
    return {
        "block_subsidy_btc": block_subsidy_btc(height),
        "next_halving_height": next_height,
        "blocks_until_halving": blocks_until,
        "halving_countdown_sec": blocks_until * AVG_BLOCK_SEC,
        "halving_epoch_progress": progress,
        "halving_era": era,
    }


def fetch_wallet_balance(address: str) -> dict:
    data = http_get(f"{MEMPOOL_API}/address/{address}")
    if not isinstance(data, dict):
        raise RuntimeError("unexpected address response")
    chain = data.get("chain_stats", {})
    mempool = data.get("mempool_stats", {})
    confirmed_sats = int(chain.get("funded_txo_sum", 0)) - int(chain.get("spent_txo_sum", 0))
    unconfirmed_sats = int(mempool.get("funded_txo_sum", 0)) - int(mempool.get("spent_txo_sum", 0))
    total_sats = confirmed_sats + unconfirmed_sats
    tx_count = int(chain.get("tx_count", 0)) + int(mempool.get("tx_count", 0))
    return {
        "btc": total_sats / 1e8,
        "confirmed_btc": confirmed_sats / 1e8,
        "tx_count": tx_count,
        "updated_at": utc_now(),
    }


def update_wallet_balance_state(state: dict, config: dict) -> dict:
    if not config.get("show_wallet_balance"):
        return state
    address = (config.get("payout_address") or "").strip()
    if not address:
        return state

    now = datetime.now(timezone.utc)
    balance_state = state.get("wallet_balance", {})
    last_poll = balance_state.get("updated_at")
    interval = price_poll_interval_sec(config)
    if last_poll:
        try:
            last_dt = datetime.fromisoformat(last_poll)
            if (now - last_dt).total_seconds() < interval:
                return state
        except ValueError:
            pass

    try:
        quote = fetch_wallet_balance(address)
    except (urllib.error.URLError, RuntimeError, KeyError, ValueError) as exc:
        balance_state["last_error"] = str(exc)
        state["wallet_balance"] = balance_state
        return state

    state["wallet_balance"] = quote
    return state


def update_price_state(state: dict, config: dict) -> dict:
    now = datetime.now(timezone.utc)
    price_state = state.get("price", {})
    last_poll = price_state.get("updated_at")
    interval = price_poll_interval_sec(config)
    if last_poll:
        try:
            last_dt = datetime.fromisoformat(last_poll)
            if (now - last_dt).total_seconds() < interval:
                return state
        except ValueError:
            pass
    try:
        quote = fetch_btc_price()
    except (urllib.error.URLError, RuntimeError, KeyError, ValueError) as exc:
        price_state["last_error"] = str(exc)
        state["price"] = price_state
        return state

    history = price_state.get("history", [])
    history.append({"t": quote["updated_at"], "usd": quote["usd"]})
    state["price"] = {
        "usd": quote["usd"],
        "updated_at": quote["updated_at"],
        "history": history[-PRICE_HISTORY_LIMIT:],
        "poll_interval_min": int(config.get("price_poll_interval_min", DEFAULT_PRICE_POLL_MIN)),
    }
    return state


def hash_proximity(hash_hex: str, target_hex: str, won: bool) -> dict:
    hash_int = int(hash_hex, 16)
    target_int = int(target_hex, 16)
    if won or hash_int <= target_int:
        return {
            "won": True,
            "percent": 100.0,
            "leading_zero_bits": 256,
            "label": "JACKPOT",
        }
    leading = 256 - hash_int.bit_length()
    ratio = target_int / hash_int
    percent = max(0.0, min(99.999999, ratio * 100))
    return {
        "won": False,
        "percent": percent,
        "leading_zero_bits": leading,
        "label": f"{percent:.8f}%",
    }


def get_tip_block_info() -> dict:
    height = get_tip_height()
    block = get_block(height)
    return {
        "height": height,
        "timestamp": int(block["timestamp"]),
        "difficulty": float(block.get("difficulty", 0)),
    }


def hash_prefix_match_chars(left: str, right: str) -> int:
    left = left.lower()
    right = right.lower()
    matched = 0
    for a, b in zip(left, right):
        if a != b:
            break
        matched += 1
    return matched


def fetch_network_winner(height: int, your_hash: str) -> Optional[dict]:
    """Fetch the real winning block hash for a height from mempool.space."""
    try:
        block = get_block(height)
        winner_hash = str(block.get("id", "")).lower()
        if not winner_hash:
            return None
        return {
            "height": height,
            "hash_hex": winner_hash,
            "prefix_match_chars": hash_prefix_match_chars(winner_hash, your_hash),
            "fetched_at": utc_now(),
        }
    except (urllib.error.URLError, RuntimeError, KeyError, ValueError, TypeError) as exc:
        return {"height": height, "error": str(exc), "fetched_at": utc_now()}


def fetch_network_hashrate_data() -> Optional[dict]:
    try:
        data = http_get(f"{MEMPOOL_API}/v1/mining/hashrate/1w")
        if not isinstance(data, dict):
            return None
        current = float(data.get("currentHashrate", 0)) / 1e18
        if current <= 0:
            return None
        history = []
        for point in data.get("hashrates", []):
            ts = int(point.get("timestamp", 0))
            eh = float(point.get("avgHashrate", 0)) / 1e18
            if eh > 0 and ts > 0:
                history.append(
                    {
                        "t": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
                        "eh": round(eh, 2),
                    }
                )
        return {"current_eh": round(current, 2), "history": history}
    except (urllib.error.URLError, RuntimeError, ValueError):
        return None


def update_display_stats(state: dict, new_block: bool = False) -> dict:
    now = time.time()
    display = state.get("display", {})
    try:
        tip = get_tip_block_info()
        elapsed = max(0, int(now - tip["timestamp"]))
        remaining = max(0, AVG_BLOCK_SEC - elapsed)
        display.update(
            {
                "tip_height": tip["height"],
                "last_block_timestamp": tip["timestamp"],
                "block_elapsed_sec": elapsed,
                "block_countdown_sec": remaining,
                "avg_block_sec": AVG_BLOCK_SEC,
                "difficulty": tip["difficulty"],
                **halving_stats(tip["height"]),
            }
        )
    except (urllib.error.URLError, RuntimeError, KeyError, ValueError) as exc:
        display["tip_error"] = str(exc)

    if attempt := state.get("last_attempt"):
        prox = hash_proximity(attempt["hash_hex"], attempt["target_hex"], attempt.get("won", False))
        display["hash_proximity"] = prox
        existing_winner = display.get("network_winner") or {}
        if existing_winner.get("height") != attempt["height"] or not existing_winner.get("hash_hex"):
            winner = fetch_network_winner(attempt["height"], attempt["hash_hex"])
            if winner:
                display["network_winner"] = winner

    if new_block:
        display["ceremony_until"] = (datetime.now(timezone.utc) + timedelta(seconds=CEREMONY_SEC)).isoformat()

    ceremony_until = display.get("ceremony_until")
    if ceremony_until:
        try:
            if datetime.now(timezone.utc) >= datetime.fromisoformat(ceremony_until):
                display.pop("ceremony_until", None)
        except ValueError:
            display.pop("ceremony_until", None)

    if display.get("tip_height") != state.get("_last_network_height") or not display.get(
        "network_hashrate_history"
    ):
        hashrate_data = fetch_network_hashrate_data()
        if hashrate_data is not None:
            display["network_hashrate_eh"] = hashrate_data["current_eh"]
            display["network_hashrate_history"] = hashrate_data["history"]
        state["_last_network_height"] = display.get("tip_height")

    display["updated_at"] = utc_now()
    state["display"] = display
    return state


def get_block(hash_or_height: str | int) -> dict:
    if isinstance(hash_or_height, int):
        block_hash = get_block_hash(hash_or_height)
    else:
        block_hash = hash_or_height
    return http_get(f"{MEMPOOL_API}/block/{block_hash}")


def symbolic_attempt(height: int, machine_seed: str) -> BlockAttempt:
    """
    Symbolic lottery: hash against real network difficulty using the chain tip
    as context. Not submittable (merkle root is from the already-found block).
    """
    block = get_block(height)
    bits = int(block["bits"], 16) if isinstance(block["bits"], str) else block["bits"]
    difficulty = float(block.get("difficulty", 1))
    target = difficulty_to_target(difficulty)
    nonce = pick_nonce(height, machine_seed)
    hash_bytes = hash_block_header(
        version=block["version"],
        prev_hash_hex=block["previousblockhash"],
        merkle_root_hex=block["merkle_root"],
        timestamp=block["timestamp"],
        bits=bits,
        nonce=nonce,
    )
    return BlockAttempt(
        height=height,
        prev_hash=block["previousblockhash"],
        bits=bits,
        nonce=nonce,
        hash_hex=hash_bytes[::-1].hex(),
        target_hex=f"{target:064x}",
        won=check_win(hash_bytes, target),
        mode="symbolic",
        attempted_at=utc_now(),
        merkle_root_hex=block.get("merkle_root", ""),
        tx_count=int(block.get("tx_count", 1) or 1),
        version=int(block["version"]),
        timestamp=int(block["timestamp"]),
    )


def live_attempt(
    rpc_url: str,
    rpc_user: str,
    rpc_pass: str,
    machine_seed: str,
    payout_address: str,
    rpc_cookie: str = "",
    coinbase_tag: str = "",
) -> BlockAttempt:
    """Real solo attempt via Bitcoin Core getblocktemplate + submitblock."""
    payout_address = validate_payout_address(payout_address)
    payout_script = address_to_script_pubkey(payout_address)
    template = rpc_call(
        rpc_url,
        rpc_user,
        rpc_pass,
        "getblocktemplate",
        [{"rules": ["segwit"], "capabilities": ["coinbasevalue", "workid", "longpoll", "proposal"]}],
        cookie=rpc_cookie,
    )
    height = template["height"]
    bits = int(template["bits"], 16)
    target = int(template["target"], 16)
    nonce = pick_nonce(height, machine_seed)

    coinbase_raw = build_coinbase_transaction(
        height=height,
        coinbase_value=template["coinbasevalue"],
        payout_script=payout_script,
        witness_commitment_hex=template.get("default_witness_commitment"),
        coinbase_tag=coinbase_tag,
    )
    coinbase_tx = coinbase_raw.hex()
    merkle_root = _merkle_root_from_coinbase(coinbase_tx, template.get("transactions", []))
    hash_bytes = hash_block_header(
        version=template["version"],
        prev_hash_hex=template["previousblockhash"],
        merkle_root_hex=merkle_root,
        timestamp=template["curtime"],
        bits=bits,
        nonce=nonce,
    )
    won = check_win(hash_bytes, target)
    submitted = False
    if won:
        block_hex = _assemble_block_hex(template, coinbase_tx, nonce)
        saved = save_winning_block(height, block_hex)  # persist FIRST — a found block must survive any submit error
        p2p_enabled = load_config().get("p2p_fallback", True)
        # do whatever it takes: push straight to the P2P network the FIRST time too, in parallel with the node RPC
        if p2p_enabled:
            threading.Thread(target=_broadcast_with_node_peers, args=(rpc_url, rpc_user, rpc_pass, rpc_cookie, block_hex), daemon=True).start()
        try:
            result = rpc_call(rpc_url, rpc_user, rpc_pass, "submitblock", [block_hex], cookie=rpc_cookie)
        except Exception as exc:  # noqa: BLE001 — never let a winning block vanish into a stack trace
            result = f"error: {exc}"
        submitted = not result  # submitblock returns null on accept, a reason string otherwise (e.g. "duplicate")
        if submitted:
            _mark_won_resolved(saved, "accepted")
            print(f"🎉 WON and submitted block #{height}! (also pushed to the P2P network)", file=sys.stderr)
        elif result == "duplicate":
            submitted = True  # already in the chain — count it as in
            _mark_won_resolved(saved, "duplicate")
            print(f"🎉 WON block #{height} — already in the chain (duplicate).", file=sys.stderr)
        else:
            # node didn't take it → a worker keeps hammering BOTH the node RPC and the P2P network until it lands
            spawn_resubmit(rpc_url, rpc_user, rpc_pass, rpc_cookie, height, saved, p2p_enabled)
            print(f"⚠ WON block #{height} but submitblock returned '{result}' — AUTO-RETRYING via node RPC + direct P2P until it lands or the block is taken (saved {saved}).", file=sys.stderr)

    mempool_txs = template.get("transactions", [])
    return BlockAttempt(
        height=height,
        prev_hash=template["previousblockhash"],
        bits=bits,
        nonce=nonce,
        hash_hex=hash_bytes[::-1].hex(),
        target_hex=f"{target:064x}",
        won=won,
        mode="live",
        attempted_at=utc_now(),
        merkle_root_hex=merkle_root,
        tx_count=1 + len(mempool_txs),
        version=int(template["version"]),
        timestamp=int(template["curtime"]),
        submitted=submitted,
    )


def _merkle_root_from_coinbase(coinbase_hex: str, transactions: list) -> str:
    # the block merkle tree is over TXIDs (non-witness). The coinbase txid is the double-SHA256 of its
    # non-witness serialization; for every other tx we use the template's txid — hashing tx["data"] would
    # give the WTXID for segwit txs, which is wrong. All hashes are internal (little-endian) order.
    hashes = [hashlib.sha256(hashlib.sha256(bytes.fromhex(coinbase_hex)).digest()).digest()]
    for tx in transactions:
        hashes.append(bytes.fromhex(tx["txid"])[::-1])
    return _compute_merkle_root(hashes)[::-1].hex()


def _compute_merkle_root(hashes: list[bytes]) -> bytes:
    layer = hashes[:]
    while len(layer) > 1:
        if len(layer) % 2 == 1:
            layer.append(layer[-1])
        layer = [
            hashlib.sha256(hashlib.sha256(layer[i] + layer[i + 1]).digest()).digest()
            for i in range(0, len(layer), 2)
        ]
    return layer[0]


def _coinbase_with_witness(cb: bytes) -> bytes:
    # a segwit block's coinbase must carry a witness: a single 32-byte reserved value (all zeros), which is
    # exactly what the template's default_witness_commitment assumes. Re-serialize the legacy coinbase into
    # segwit form: version | 00 01 (marker+flag) | inputs+outputs | witness(1 item ×32 zero bytes) | locktime
    version, middle, locktime = cb[:4], cb[4:-4], cb[-4:]
    witness = _serialize_varint(1) + _serialize_varint(32) + b"\x00" * 32
    return version + b"\x00\x01" + middle + witness + locktime


def _assemble_block_hex(template: dict, coinbase_hex: str, nonce: int) -> str:
    # a full, consensus-valid block: 80-byte header + tx count + the (witness-serialized) coinbase + EVERY
    # template transaction, in template order. The header carries the merkle root as bytes (internal order).
    header = struct.pack("<I", template["version"])
    header += bytes.fromhex(template["previousblockhash"])[::-1]
    merkle = _merkle_root_from_coinbase(coinbase_hex, template.get("transactions", []))
    header += bytes.fromhex(merkle)[::-1]
    header += struct.pack("<III", template["curtime"], int(template["bits"], 16), nonce)
    txs = template.get("transactions", [])
    cb = bytes.fromhex(coinbase_hex)
    cb_serialized = _coinbase_with_witness(cb) if template.get("default_witness_commitment") else cb
    block = header + _serialize_varint(1 + len(txs)) + cb_serialized
    for tx in txs:
        block += bytes.fromhex(tx["data"])
    return block.hex()


def _varint(n: int) -> str:
    if n < 0xFD:
        return f"{n:02x}"
    if n <= 0xFFFF:
        return "fd" + struct.pack("<H", n).hex()
    if n <= 0xFFFFFFFF:
        return "fe" + struct.pack("<I", n).hex()
    return "ff" + struct.pack("<Q", n).hex()


def format_attempt(a: BlockAttempt) -> str:
    status = "JACKPOT!!!" if a.won else "no match"
    return (
        f"\n{'=' * 60}\n"
        f"  Block {a.height}  |  mode: {a.mode}\n"
        f"  Ticket (nonce): {a.nonce}\n"
        f"  Hash:   {a.hash_hex}\n"
        f"  Target: {a.target_hex}\n"
        f"  Result: {status}\n"
        f"{'=' * 60}"
    )


def validate_live_config(config: dict) -> None:
    validate_payout_address(config.get("payout_address", ""))
    has_userpass = config.get("rpc_user") and config.get("rpc_pass")
    if not has_userpass and not config.get("rpc_cookie"):
        raise ValueError("Live mode needs either rpc_user + rpc_pass or an rpc_cookie path in config.json")


def get_node_status(rpc_url: str, rpc_user: str, rpc_pass: str, rpc_cookie: str = "") -> dict:
    info = rpc_call(rpc_url, rpc_user, rpc_pass, "getblockchaininfo", [], cookie=rpc_cookie)
    progress = float(info.get("verificationprogress", 0))
    syncing = bool(info.get("initialblockdownload", True))
    ready = (not syncing) and progress >= 0.99999 and info.get("blocks", 0) > 0
    return {
        "reachable": True,
        "ready": ready,
        "initialblockdownload": syncing,
        "verificationprogress": progress,
        "blocks": info.get("blocks"),
        "headers": info.get("headers"),
        "chain": info.get("chain"),
        "pruned": bool(info.get("pruned", False)),
        "pruneheight": info.get("pruneheight"),
        "warnings": info.get("warnings", []),
        "checked_at": utc_now(),
    }


def refresh_node_status(state: dict, settings: dict) -> dict:
    rpc_user = settings.get("rpc_user", "")
    rpc_pass = settings.get("rpc_pass", "")
    rpc_cookie = settings.get("rpc_cookie", "")
    if not ((rpc_user and rpc_pass) or rpc_cookie):
        state["node"] = {
            "reachable": False,
            "ready": False,
            "status": "rpc_not_configured",
            "checked_at": utc_now(),
        }
        return state
    try:
        state["node"] = get_node_status(
            settings["rpc_url"], rpc_user, rpc_pass, rpc_cookie
        )
    except (urllib.error.URLError, RuntimeError, KeyError) as exc:
        state["node"] = {
            "reachable": False,
            "ready": False,
            "status": "unreachable",
            "error": str(exc),
            "checked_at": utc_now(),
        }
    return state


def bitcoin_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Bitcoin"
    return Path.home() / ".bitcoin"


def estimate_bitcoin_dir_size() -> Optional[int]:
    bitcoin_dir = bitcoin_data_dir()
    if not bitcoin_dir.exists():
        return None
    total = 0
    for path in bitcoin_dir.rglob("*"):
        if path.is_file():
            try:
                total += path.stat().st_size
            except OSError:
                pass
    return total


def print_check_node() -> int:
    config = load_config()
    print(brand("Bitcoin Lottery — node readiness check\n"))

    if not ((config.get("rpc_user") and config.get("rpc_pass")) or config.get("rpc_cookie")):
        print("RPC not configured. Run: ./scripts/setup-bitcoind.sh")
        return 1

    try:
        node = get_node_status(config["rpc_url"], config["rpc_user"], config["rpc_pass"], config.get("rpc_cookie", ""))
    except (urllib.error.URLError, RuntimeError) as exc:
        print(brand(f"Cannot reach Bitcoin Core at {config['rpc_url']}"))
        print(f"  {exc}")
        print(brand("\nIs Bitcoin Core installed and running?"))
        return 1

    pct = node["verificationprogress"] * 100
    print(f"Chain:      {node.get('chain', 'unknown')}")
    print(f"Blocks:     {node.get('blocks')} / {node.get('headers')}")
    print(f"Sync:       {pct:.4f}% verified")
    print(f"Pruned:     {'yes' if node['pruned'] else 'no'}")
    if node.get("pruneheight") is not None:
        print(f"Prune from: block {node['pruneheight']}")

    size = estimate_bitcoin_dir_size()
    if size is not None:
        print(f"Disk used:  {size / (1024 ** 3):.1f} GB  ({bitcoin_data_dir()})")

    print()
    if node["ready"]:
        print("Status: READY for live lottery mining")
        if not config.get("payout_address"):
            print("Next: set payout_address in config")
            return 1
        if config.get("mode") != "live":
            print("Next: python3 lottery_miner.py --set mode live")
        else:
            print("Live mode can be enabled — run ./scripts/install.sh if needed")
        return 0

    if node["initialblockdownload"]:
        print("Status: SYNCING — live mining disabled until initial download completes")
        print("Note:   pruned nodes use ~15 GB disk (not 600 GB). The chain still downloads once over the network.")
    else:
        print("Status: NOT READY — verification still in progress")
    return 2


def resolve_runtime_settings(
    mode: Optional[str],
    rpc_url: Optional[str],
    rpc_user: Optional[str],
    rpc_pass: Optional[str],
    seed: Optional[str],
    payout_address: Optional[str],
) -> dict:
    config = load_config()
    resolved = {
        "mode": mode or config.get("mode", "symbolic"),
        "rpc_url": rpc_url or config.get("rpc_url", "http://127.0.0.1:8332"),
        "rpc_user": rpc_user or config.get("rpc_user", ""),
        "rpc_pass": rpc_pass or config.get("rpc_pass", ""),
        "rpc_cookie": config.get("rpc_cookie", ""),
        "coinbase_tag": config.get("coinbase_tag", ""),
        # default seed is a HASH of the hostname, not the hostname itself — it's published in node.json
        # (which is web-served) and shown in the nonce pane, so a raw hostname would leak the device name.
        # Deterministic (stable nonce per host) and identical on daemon + dashboard. A user-set seed wins.
        "machine_seed": seed or config.get("machine_seed") or hashlib.sha256((platform.node() or "bitcoin-lottery").encode()).hexdigest()[:16],  # platform.node() = hostname, cross-platform (os.uname() is Unix-only → crashed on Windows)
        "payout_address": payout_address if payout_address is not None else config.get("payout_address", ""),
    }
    # default to the owner's address when no wallet is set, so live mode mines to a valid address
    # instead of erroring; flag it so the dashboard can nudge the operator to set their own.
    resolved["payout_is_default"] = not (resolved["payout_address"] or "").strip()
    if resolved["payout_is_default"]:
        resolved["payout_address"] = DEFAULT_PAYOUT_ADDRESS
    if resolved["mode"] == "live":
        validate_live_config(resolved)
    return resolved


def watch_and_hash(settings: dict, once: bool, daemon: bool) -> None:
    last_height: Optional[int] = None
    mode = settings["mode"]
    config = load_config()
    state = load_state()
    state["daemon_started_at"] = utc_now()
    state["machine_seed"] = settings["machine_seed"]
    state["mode"] = mode
    state["payout_address"] = mask_address(settings["payout_address"]) if settings["payout_address"] else ""
    save_state(state)

    # Only the daemon claims the lock. A one-shot `--once` run is a deliberate manual action and must never
    # evict the running daemon, nor be evicted by it.
    if daemon:
        claim_miner_lock()
    install_stall_reporting(log_daemon if daemon else (lambda m: print(m, file=sys.stderr)))
    note_ticket()   # baseline: without this the monitor would call a just-started miner idle for 15 minutes

    if daemon:
        payout = state["payout_address"] or "not set"
        log_daemon(f"Daemon started ({mode} mode), payout {payout}, polling every {POLL_INTERVAL_SEC}s")
    else:
        print(brand(f"Bitcoin Lottery Miner — 1 hash per block ({mode} mode)"))
        print(f"Machine seed: {settings['machine_seed'][:16]}...")
        if settings["payout_address"]:
            print(f"Payout address: {mask_address(settings['payout_address'])}")
        print("Waiting for new blocks (~10 min each)...\n")

    if mode == "live":  # resume auto-resubmit for any won block left unconfirmed by a previous crash/quit
        rescue_pending_won_blocks(settings.get("rpc_url", ""), settings.get("rpc_user", ""), settings.get("rpc_pass", ""), settings.get("rpc_cookie", ""), config.get("p2p_fallback", True))

    while True:
        try:
            if daemon and superseded_by_newer_miner():
                log_daemon("superseded by a newer miner for this data dir — exiting")
                return
            if daemon:
                settings = resolve_runtime_settings(None, None, None, None, None, None)
                config = load_config()
                mode = settings["mode"]
                state["mode"] = mode
                state["payout_address"] = (
                    mask_address(settings["payout_address"]) if settings["payout_address"] else ""
                )

            # The network tip from mempool.space is display/fallback only — a public-API outage or a slow
            # route must never block the one thing this loop exists for (attempting the next block).
            # Which job is this call doing right now? Decided from the PREVIOUS pass's node state, because
            # refresh_node_status has not run yet this time round. If our node was serving the tip a moment
            # ago it is almost certainly still there, and being wrong for one 30s pass costs nothing: the
            # worst case is a display number we skip once, and the next pass corrects it.
            network_height: Optional[int] = None
            try:
                network_height = _timed("mempool.space tip", get_tip_height,
                                        tip_timeout_sec(mode, state.get("node")))
            except (urllib.error.URLError, RuntimeError, ValueError, OSError):
                pass
            state["last_poll_at"] = utc_now()
            state = _timed("node RPC", refresh_node_status, state, settings)

            # In live mode the ticket trigger is our own node's tip: it hears new blocks first and works
            # even with mempool.space down. Symbolic mode has no node, so the public tip stays the trigger.
            node = state.get("node") or {}
            if mode == "live" and node.get("ready") and node.get("blocks"):
                height = int(node["blocks"])
            else:
                height = network_height
            if height is not None:
                state["current_tip_height"] = height

            state = _timed("price", update_price_state, state, config)
            state = _timed("wallet balance", update_wallet_balance_state, state, config)
            state = update_display_stats(state, new_block=False)
            save_state(state)
            note_poll_done(height)   # the loop got all the way round: whatever is wrong, it is not a blocked call

            if height is None:
                msg = "Tip height unavailable (node and mempool.space both unreachable) — will retry"
                if daemon:
                    log_daemon(msg)
                else:
                    print(msg, file=sys.stderr)
                time.sleep(POLL_INTERVAL_SEC)
                continue

            if height != last_height:
                if mode == "live":
                    if not node.get("ready"):
                        progress = node.get("verificationprogress")
                        detail = f"{progress * 100:.2f}% synced" if progress is not None else node.get("status", "unreachable")
                        msg = f"Block {height} arrived but node not ready ({detail}) — will retry"
                        if daemon:
                            log_daemon(msg)
                        else:
                            print(msg, file=sys.stderr)
                        time.sleep(POLL_INTERVAL_SEC)
                        continue
                    attempt = live_attempt(
                        settings["rpc_url"],
                        settings["rpc_user"],
                        settings["rpc_pass"],
                        settings["machine_seed"],
                        settings["payout_address"],
                        settings.get("rpc_cookie", ""),
                        settings.get("coinbase_tag", ""),
                    )
                else:
                    attempt = symbolic_attempt(height, settings["machine_seed"])
                state = record_attempt(state, attempt, settings["machine_seed"], mode)
                output = format_attempt(attempt)
                if daemon:
                    log_daemon(output.strip())
                else:
                    print(output)
                last_height = height
                if once:
                    return
        except (urllib.error.URLError, RuntimeError, KeyError, ValueError, struct.error) as exc:
            msg = f"Error: {exc}"
            if daemon:
                log_daemon(msg)
            else:
                print(msg, file=sys.stderr)
        time.sleep(POLL_INTERVAL_SEC)


def print_status() -> None:
    state = load_state()
    config = load_config()
    payload = {"config": {**config, "rpc_pass": "***" if config.get("rpc_pass") else ""}, "state": state}
    if not state.get("last_attempt"):
        payload["state"]["note"] = "No attempts yet. Start the daemon with: python3 lottery_miner.py --daemon"
    print(json.dumps(payload, indent=2))


def print_config() -> None:
    config = load_config()
    if config.get("rpc_pass"):
        config = {**config, "rpc_pass": "***"}
    print(json.dumps(config, indent=2))


def set_config_value(key: str, value: str) -> None:
    allowed = {
        "mode",
        "payout_address",
        "rpc_url",
        "rpc_user",
        "rpc_pass",
        "machine_seed",
        "price_poll_interval_min",
    }
    if key not in allowed:
        raise ValueError(f"Unsupported config key: {key}")
    config = load_config()
    if key == "mode" and value not in {"symbolic", "live"}:
        raise ValueError("mode must be 'symbolic' or 'live'")
    if key == "price_poll_interval_min":
        minutes = int(value)
        if minutes < 1 or minutes > 1440:
            raise ValueError("price_poll_interval_min must be between 1 and 1440")
        value = str(minutes)
    if key == "payout_address" and value:
        value = validate_payout_address(value)
    if key == "price_poll_interval_min":
        config[key] = int(value)
    else:
        config[key] = value
    if config.get("mode") == "live":
        validate_live_config(config)
    save_config(config)
    print(f"Saved {key} to {CONFIG_FILE}")


def init_config() -> None:
    if CONFIG_FILE.exists():
        print(f"Config already exists: {CONFIG_FILE}")
        return
    save_config(load_config())
    print(f"Created config: {CONFIG_FILE}")


def main() -> None:
    parser = argparse.ArgumentParser(description=brand("1 hash per Bitcoin block — true lottery mining"))
    parser.add_argument("--mode", choices=["symbolic", "live"], default=None)
    parser.add_argument("--once", action="store_true", help="Hash once for current tip, then exit")
    parser.add_argument("--daemon", action="store_true", help="Run continuously, write shared state")
    parser.add_argument("--status", action="store_true", help="Print shared state JSON")
    parser.add_argument("--config", action="store_true", help="Print config JSON")
    parser.add_argument("--init-config", action="store_true", help="Create default config.json")
    parser.add_argument("--check-node", action="store_true", help=brand("Check Bitcoin Core sync status for live mode"))
    parser.add_argument("--set", nargs=2, metavar=("KEY", "VALUE"), help="Update a config value")
    parser.add_argument("--payout-address", default=None, help=brand("Bitcoin address for block rewards (live mode)"))
    parser.add_argument("--rpc-url", default=None)
    parser.add_argument("--rpc-user", default=None)
    parser.add_argument("--rpc-pass", default=None)
    parser.add_argument("--seed", default=None, help="Stable machine ID for deterministic nonce")
    args = parser.parse_args()

    if args.init_config:
        init_config()
        return

    if args.set:
        set_config_value(args.set[0], args.set[1])
        return

    if args.config:
        print_config()
        return

    if args.status:
        print_status()
        return

    if args.check_node:
        sys.exit(print_check_node())

    env_fallback = {
        "rpc_url": os.environ.get("BITCOIN_RPC_URL"),
        "rpc_user": os.environ.get("BITCOIN_RPC_USER"),
        "rpc_pass": os.environ.get("BITCOIN_RPC_PASS"),
        "seed": os.environ.get("LOTTERY_MACHINE_SEED"),
        "payout_address": os.environ.get("BITCOIN_PAYOUT_ADDRESS"),
    }
    settings = resolve_runtime_settings(
        args.mode,
        args.rpc_url or env_fallback["rpc_url"],
        args.rpc_user or env_fallback["rpc_user"],
        args.rpc_pass or env_fallback["rpc_pass"],
        args.seed or env_fallback["seed"],
        args.payout_address or env_fallback["payout_address"],
    )

    if args.once:
        height = get_tip_height()
        attempt = (
            live_attempt(
                settings["rpc_url"],
                settings["rpc_user"],
                settings["rpc_pass"],
                settings["machine_seed"],
                settings["payout_address"],
                settings.get("rpc_cookie", ""),
                settings.get("coinbase_tag", ""),
            )
            if settings["mode"] == "live"
            else symbolic_attempt(height, settings["machine_seed"])
        )
        print(format_attempt(attempt))
        return

    if args.daemon:
        log_daemon._quiet = False

    watch_and_hash(settings, once=False, daemon=args.daemon)


if __name__ == "__main__":
    main()