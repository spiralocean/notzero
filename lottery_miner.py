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
import struct
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

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
HISTORY_LIMIT = 50
PRICE_HISTORY_LIMIT = 96
POLL_INTERVAL_SEC = 30
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
    config.setdefault("machine_seed", "")
    config.setdefault("price_poll_interval_min", DEFAULT_PRICE_POLL_MIN)
    config.setdefault("menu_bar_display", "block")
    config.setdefault("notifications_enabled", True)
    config.setdefault("notify_closeness_above_zero", True)
    config.setdefault("notify_block_won", True)
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


def log_daemon(message: str) -> None:
    ensure_app_support()
    line = f"[{utc_now()}] {message}\n"
    with LOG_FILE.open("a") as f:
        f.write(line)
    if not getattr(log_daemon, "_quiet", False):
        print(line, end="")


def record_attempt(state: dict, attempt: BlockAttempt, machine_seed: str, mode: str) -> dict:
    attempt.attempted_at = utc_now()
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
            state["best"] = {"zero_bits": z, "height": attempt.height, "hash": attempt.hash_hex, "nonce": attempt.nonce, "at": attempt.attempted_at}
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


def http_get(url: str, timeout: int = 30) -> dict | list | str:
    req = urllib.request.Request(url, headers={"User-Agent": "bitcoin-lottery-miner/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
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
    if witness_version == 0 and len(program) != 20:
        raise ValueError("P2WPKH (bc1q...) program must be 20 bytes")
    if witness_version == 1 and len(program) != 32:
        raise ValueError("Taproot (bc1p...) program must be 32 bytes")
    if witness_version > 1:
        raise ValueError("Unsupported witness version (only bc1q and bc1p are supported)")
    return witness_version, bytes(program)


def address_to_script_pubkey(address: str) -> bytes:
    address = address.strip()
    if address.startswith(("bc1", "tb1")):
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
    if height == 0:
        return bytes([0x01, 0x00])
    raw = height.to_bytes((height.bit_length() + 7) // 8, "little")
    return bytes([len(raw)]) + raw


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
) -> bytes:
    coinbase_value = int(coinbase_value)
    if not 0 <= coinbase_value < (1 << 64):  # guard struct.pack("<Q") — a bad template value must not crash us
        raise ValueError(f"coinbasevalue out of range: {coinbase_value}")
    script_sig = _encode_height(height) + b"/BitcoinLottery/0.1/"
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
    return int.from_bytes(hash_bytes, "big") <= target


def get_tip_height() -> int:
    return int(http_get(f"{MEMPOOL_API}/blocks/tip/height"))


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
        try:
            result = rpc_call(rpc_url, rpc_user, rpc_pass, "submitblock", [block_hex], cookie=rpc_cookie)
        except Exception as exc:  # noqa: BLE001 — never let a winning block vanish into a stack trace
            result = f"error: {exc}"
        submitted = not result  # submitblock returns null on accept, a reason string otherwise (e.g. "duplicate")
        print(
            f"🎉 WON and submitted block #{height}!" if submitted
            else f"⚠ WON block #{height} but submitblock returned '{result}' — saved {saved} for manual resubmit.",
            file=sys.stderr,
        )

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
        # default seed is a HASH of the hostname, not the hostname itself — it's published in node.json
        # (which is web-served) and shown in the nonce pane, so a raw hostname would leak the device name.
        # Deterministic (stable nonce per host) and identical on daemon + dashboard. A user-set seed wins.
        "machine_seed": seed or config.get("machine_seed") or hashlib.sha256(os.uname().nodename.encode()).hexdigest()[:16],
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

    if daemon:
        payout = state["payout_address"] or "not set"
        log_daemon(f"Daemon started ({mode} mode), payout {payout}, polling every {POLL_INTERVAL_SEC}s")
    else:
        print(brand(f"Bitcoin Lottery Miner — 1 hash per block ({mode} mode)"))
        print(f"Machine seed: {settings['machine_seed'][:16]}...")
        if settings["payout_address"]:
            print(f"Payout address: {mask_address(settings['payout_address'])}")
        print("Waiting for new blocks (~10 min each)...\n")

    while True:
        try:
            if daemon:
                settings = resolve_runtime_settings(None, None, None, None, None, None)
                config = load_config()
                mode = settings["mode"]
                state["mode"] = mode
                state["payout_address"] = (
                    mask_address(settings["payout_address"]) if settings["payout_address"] else ""
                )

            height = get_tip_height()
            state["current_tip_height"] = height
            state["last_poll_at"] = utc_now()
            state = refresh_node_status(state, settings)
            state = update_price_state(state, config)
            state = update_wallet_balance_state(state, config)
            state = update_display_stats(state, new_block=False)
            save_state(state)

            if height != last_height:
                if mode == "live":
                    node = state.get("node") or {}
                    if not node.get("ready"):
                        msg = (
                            f"Block {height} arrived but node not ready "
                            f"({node['verificationprogress'] * 100:.2f}% synced) — will retry"
                        )
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