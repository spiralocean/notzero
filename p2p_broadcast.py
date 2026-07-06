"""Direct P2P block broadcast — a last-resort gateway for getting a WON block onto the Bitcoin network without
depending on the local node's RPC. We connect straight to public nodes discovered via the DNS seeds, do the
`version`/`verack` handshake, announce the block (`inv`), and push the full `block` message.

This is belt-and-suspenders for a once-in-a-lifetime event: on a real win we use it ALONGSIDE the node RPC, and
the resubmit worker keeps re-pushing it if the node stays unreachable. Best-effort and self-contained — it
never raises into the caller; the return value is how many peers we successfully sent the block to.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import random
import socket
import struct
import time

MAGIC = b"\xf9\xbe\xb4\xd9"  # mainnet message-start bytes
DEFAULT_PORT = 8333
PROTOCOL_VERSION = 70016
MSG_BLOCK = 2

# Bitcoin Core's mainnet DNS seeds — each resolves to a rotating set of reachable full nodes.
DNS_SEEDS = (
    "seed.bitcoin.sipa.be",
    "dnsseed.bluematt.me",
    "seed.bitcoinstats.com",
    "seed.bitcoin.jonasschnelli.ch",
    "seed.btc.petertodd.net",
    "seed.bitcoin.sprovoost.nl",
    "dnsseed.emzy.de",
    "seed.bitcoin.wiz.biz",
    "seed.mainnet.achownodes.xyz",
)


def _dsha(b: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()


def _frame(command: str, payload: bytes) -> bytes:
    return MAGIC + command.encode().ljust(12, b"\x00") + struct.pack("<I", len(payload)) + _dsha(payload)[:4] + payload


def _varint(n: int) -> bytes:
    if n < 0xFD:
        return struct.pack("<B", n)
    if n <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", n)
    if n <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", n)
    return b"\xff" + struct.pack("<Q", n)


def _netaddr(ip: str, port: int) -> bytes:
    try:
        raw = socket.inet_aton(ip)
    except OSError:
        raw = b"\x00\x00\x00\x00"
    return struct.pack("<Q", 0) + b"\x00" * 10 + b"\xff\xff" + raw + struct.pack(">H", port)  # services + IPv4-mapped IP + port(BE)


def _version_payload(peer_ip: str, peer_port: int) -> bytes:
    ua = b"/notzero:1/"
    return (
        struct.pack("<iQq", PROTOCOL_VERSION, 0, int(time.time()))  # version, services=0 (we don't serve), timestamp
        + _netaddr(peer_ip, peer_port)  # addr_recv
        + _netaddr("0.0.0.0", 0)  # addr_from
        + struct.pack("<Q", random.getrandbits(64))  # nonce
        + _varint(len(ua)) + ua
        + struct.pack("<i", 0)  # start_height
        + b"\x00"  # relay = false
    )


def _recv_exact(sock: socket.socket, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def _recv_msg(sock: socket.socket):
    hdr = _recv_exact(sock, 24)
    if not hdr or hdr[:4] != MAGIC:
        return None, None
    command = hdr[4:16].rstrip(b"\x00").decode("ascii", "ignore")
    length = struct.unpack("<I", hdr[16:20])[0]
    if length > 4_000_000:  # sanity cap — a peer message payload is never this large
        return None, None
    payload = _recv_exact(sock, length) if length else b""
    if payload is None:
        return None, None
    return command, payload


def _handshake_and_send(ip: str, port: int, block_bytes: bytes, block_hash_internal: bytes, timeout: int) -> bool:
    sock = socket.create_connection((ip, port), timeout=timeout)
    try:
        sock.settimeout(timeout)
        sock.sendall(_frame("version", _version_payload(ip, port)))
        verack = False
        deadline = time.time() + timeout
        while time.time() < deadline and not verack:
            cmd, payload = _recv_msg(sock)
            if cmd is None:
                break
            if cmd == "version":
                sock.sendall(_frame("verack", b""))
            elif cmd == "verack":
                verack = True
            elif cmd == "ping":
                sock.sendall(_frame("pong", payload))
        if not verack:
            return False
        # announce, then push the block; also answer a getdata by (re)sending it
        sock.sendall(_frame("inv", _varint(1) + struct.pack("<I", MSG_BLOCK) + block_hash_internal))
        sock.sendall(_frame("block", block_bytes))
        sock.settimeout(3)
        end = time.time() + 4
        while time.time() < end:
            cmd, payload = _recv_msg(sock)
            if cmd is None:
                break
            if cmd == "getdata":
                sock.sendall(_frame("block", block_bytes))
            elif cmd == "ping":
                sock.sendall(_frame("pong", payload))
        return True
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _discover_peers(want: int) -> list[tuple[str, int]]:
    peers: list[tuple[str, int]] = []
    seen: set[str] = set()
    seeds = list(DNS_SEEDS)
    random.shuffle(seeds)
    for seed in seeds:
        try:
            for res in socket.getaddrinfo(seed, DEFAULT_PORT, socket.AF_INET, socket.SOCK_STREAM):
                ip = res[4][0]
                if ip not in seen:
                    seen.add(ip)
                    peers.append((ip, DEFAULT_PORT))
        except (socket.gaierror, OSError):
            continue
        if len(peers) >= want:
            break
    random.shuffle(peers)
    return peers


def broadcast_block(block_hex: str, log=None, max_peers: int = 25, timeout: int = 8, extra_peers=None) -> int:
    """Push a raw block onto the network over P2P, to many peers IN PARALLEL so it reaches the best-connected
    nodes (pools included) in ~1–2s. `extra_peers` (e.g. our node's own getpeerinfo peers) are tried first,
    then peers discovered via the DNS seeds. Returns how many peers accepted the block. Never raises."""
    say = log or (lambda _m: None)
    try:
        block_bytes = bytes.fromhex(block_hex.strip())
    except ValueError:
        return 0
    if len(block_bytes) < 80:
        return 0
    block_hash_internal = _dsha(block_bytes[:80])  # inv wants the hash in internal (little-endian) order
    disp = block_hash_internal[::-1].hex()

    candidates: list[tuple[str, int]] = []
    seen: set[str] = set()
    for ip, port in list(extra_peers or []) + _discover_peers(max_peers * 3):  # our node's peers first, then DNS-seed peers
        if ip and ip not in seen:
            seen.add(ip)
            candidates.append((ip, port))
    candidates = candidates[:max_peers]
    if not candidates:
        say("P2P: no peers to broadcast to (DNS seeds unreachable?).")
        return 0

    def _one(peer):
        ip, port = peer
        try:
            return ip if _handshake_and_send(ip, port, block_bytes, block_hash_internal, timeout) else None
        except (OSError, socket.timeout, struct.error, ValueError):
            return None

    sent = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(candidates), 32)) as ex:
        futures = [ex.submit(_one, peer) for peer in candidates]
        try:
            for fut in concurrent.futures.as_completed(futures, timeout=timeout + 10):
                ip = fut.result()
                if ip:
                    sent += 1
                    say(f"P2P: pushed block {disp[:16]}… to {ip}")
        except concurrent.futures.TimeoutError:
            say("P2P: some peers timed out (proceeding with those that answered).")
    say(f"P2P: block sent directly to {sent}/{len(candidates)} peer(s) in parallel.")
    return sent
