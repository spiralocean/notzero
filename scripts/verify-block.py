#!/usr/bin/env python3
"""Prove the miner builds a consensus-valid block — without needing to win one.

This is the truest "will the network accept what we'd submit" check there is: it asks the local
Bitcoin Core node to validate the exact block our miner would assemble, using getblocktemplate's
proposal mode (BIP23), which runs full block validation with proof-of-work skipped. A `null` verdict
means the block would be accepted; any string is the precise rejection reason.

It also cross-checks the merkle-tree math and the block serialization against real mainnet blocks, so
all the moving parts (header, merkle root over txids, segwit coinbase witness, tx serialization) are
exercised even when the local mempool is empty (e.g. a blocksonly node yields coinbase-only templates).

Run:  python3 scripts/verify-block.py [--blocks N]
RPC credentials are taken from the app's config.json (incl. cookie auth) if present, otherwise from the
node's bitcoin.conf / .cookie in the default data directory. Exits non-zero if any check fails.
"""
import argparse
import os
import re
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lottery_miner as m  # noqa: E402


def default_datadir() -> Path:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Bitcoin"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Bitcoin"
    return home / ".bitcoin"


def resolve_rpc():
    """(url, user, pass, cookie_path) — prefer the app config, fall back to the node's own conf/cookie."""
    cfg = m.load_config()
    url = cfg.get("rpc_url") or "http://127.0.0.1:8332"
    user, pw, cookie = cfg.get("rpc_user", ""), cfg.get("rpc_pass", ""), cfg.get("rpc_cookie", "")
    if (user and pw) or cookie:
        return url, user, pw, cookie
    datadir = default_datadir()
    conf = datadir / "bitcoin.conf"
    if conf.exists():
        text = conf.read_text()
        val = lambda k: (re.search(rf"^\s*{k}\s*=\s*(.+?)\s*$", text, re.M) or [None, None])[1]
        if val("rpcport"):
            url = f"http://127.0.0.1:{val('rpcport')}"
        if val("rpcuser") and val("rpcpassword"):
            return url, val("rpcuser"), val("rpcpassword"), ""
    cookief = datadir / ".cookie"
    if cookief.exists():
        return url, "", "", str(cookief)
    raise SystemExit("Could not find RPC credentials (checked the app config, bitcoin.conf, and .cookie).")


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate the miner's block against the local node.")
    ap.add_argument("--blocks", type=int, default=4, help="how many recent blocks to cross-check the merkle math against")
    args = ap.parse_args()

    url, user, pw, cookie = resolve_rpc()
    rpc = lambda method, params=None: m.rpc_call(url, user, pw, method, params or [], cookie=cookie)
    print(f"node: {url}  (auth: {'cookie' if (not user and cookie) else 'user/pass'})")

    ok = True

    # 1) THE definitive check — bitcoind validates the exact block we'd submit (PoW aside)
    tmpl = rpc("getblocktemplate", [{"rules": ["segwit"], "capabilities": ["coinbasevalue", "workid", "longpoll", "proposal"]}])
    payout = m.load_config().get("payout_address") or m.DEFAULT_PAYOUT_ADDRESS
    script = m.address_to_script_pubkey(m.validate_payout_address(payout))
    nonce = m.pick_nonce(tmpl["height"], "verify-block")
    cb = m.build_coinbase_transaction(tmpl["height"], tmpl["coinbasevalue"], script, tmpl.get("default_witness_commitment")).hex()
    block_hex = m._assemble_block_hex(tmpl, cb, nonce)
    verdict = rpc("getblocktemplate", [{"mode": "proposal", "data": block_hex, "rules": ["segwit"]}])
    n_tx = len(tmpl.get("transactions", []))
    print(f"\n[1] block proposal  — height {tmpl['height']}, {n_tx} mempool tx(s), {len(block_hex)//2} bytes, payout {m.mask_address(payout)}")
    if verdict is None:
        print("    VALID ✅  — bitcoind would accept this block (proof-of-work aside)")
    else:
        ok = False
        print(f"    REJECTED ❌ — {verdict!r}")
    if n_tx == 0:
        print("    note: 0 transactions in the template (a blocksonly node yields coinbase-only blocks).")

    # 2) merkle-tree math vs real blocks (covers multi-tx trees the empty template can't)
    print(f"\n[2] merkle reconstruction — last {args.blocks} block(s)")
    tip = rpc("getblockcount")
    for h in range(tip, tip - args.blocks, -1):
        blk = rpc("getblock", [rpc("getblockhash", [h]), 1])
        hashes = [bytes.fromhex(t)[::-1] for t in blk["tx"]]
        root = m._compute_merkle_root(hashes)[::-1].hex()
        match = root == blk["merkleroot"]
        ok = ok and match
        print(f"    block {h}: {len(blk['tx']):>5} txs  {'MATCH ✅' if match else 'MISMATCH ❌'}")

    # 3) full block serialization vs a real block's raw bytes
    h = tip - 1
    raw = rpc("getblock", [rpc("getblockhash", [h]), 0])
    b = rpc("getblock", [rpc("getblockhash", [h]), 2])
    header = struct.pack("<I", b["version"]) + bytes.fromhex(b["previousblockhash"])[::-1] + bytes.fromhex(b["merkleroot"])[::-1] + struct.pack("<III", b["time"], int(b["bits"], 16), b["nonce"])
    body = m._serialize_varint(len(b["tx"])) + b"".join(bytes.fromhex(tx["hex"]) for tx in b["tx"])
    rebuilt = (header + body).hex() == raw
    ok = ok and rebuilt
    print(f"\n[3] full serialization — block {h}: {len(b['tx'])} txs, {len(raw)//2} bytes  {'BYTE-FOR-BYTE ✅' if rebuilt else 'MISMATCH ❌'}")

    print("\n" + ("ALL CHECKS PASSED ✅ — a found block would be valid and accepted." if ok else "SOME CHECKS FAILED ❌"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
