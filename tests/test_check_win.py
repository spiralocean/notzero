#!/usr/bin/env python3
"""check_win must agree with consensus. Runs offline — no node, no network.

The premise is simple enough to be irrefutable: these are real Bitcoin blocks the network accepted, so their
header hashes DO beat their targets by definition. Any win check that says otherwise is wrong.

This existed because check_win compared the digest big-endian while consensus reads it little-endian — the
wrong end of the hash. It was wrong both ways: real wins scored as losses (and `won` gates submitblock, so
the block would have been found and silently never submitted) and losing hashes scored as wins (rejected with
"high-hash"). At mainnet difficulty either event is ~1 in 10^23, so nothing would ever have surfaced it until
it cost somebody a block.

    python3 tests/test_check_win.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from lottery_miner import bits_to_target, check_win, hash_block_header  # noqa: E402

# Real blocks the network accepted, so their header hashes beat their targets BY DEFINITION. Two entries, and
# the second is the point: block 170 has bits 0x1d00ffff — exponent 0x1d — while today's are exponent 0x17, a
# different path through bits_to_target's compact decoding. A test that only knows 2009 difficulty would stay
# green while modern targets broke, which is precisely when it would cost someone a block.
BLOCKS = [
    {
        "label": "block 170 (2009)",
        "version": 1,
        "prev": "000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55",
        "merkle": "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff",
        "time": 1231731025, "bits": 0x1D00FFFF, "nonce": 1889418792,
        "hash": "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee",
    },
    {
        "label": "block 960,358 (current difficulty)",
        "version": 948142080,
        "prev": "000000000000000000012a3cceb5f652e4a5461bcc705e8cbe4a4a08b647e0d8",
        "merkle": "c5f4363c82183337063f465a8aeba4f57cb147f1594a17dabc5e195cf7d9da95",
        "time": 1785478216, "bits": 0x17023AD4, "nonce": 3777267622,
        "hash": "00000000000000000002062db5d91768d6b65310ec2042e7cd1a148a1c4d3e8a",
    },
]


def main():
    fails = []

    for b in BLOCKS:
        digest = hash_block_header(version=b["version"], prev_hash_hex=b["prev"], merkle_root_hex=b["merkle"],
                                   timestamp=b["time"], bits=b["bits"], nonce=b["nonce"])
        shown = digest[::-1].hex()
        ok = shown == b["hash"]
        print(f"  {'✓' if ok else '✗'} {b['label']}: header rebuilds to {shown[:24]}…")
        if not ok:
            fails.append(f"{b['label']}: header hash mismatch — got {shown}, expected {b['hash']}")

        target = bits_to_target(b["bits"])
        ok = check_win(digest, target)
        print(f"  {'✓' if ok else '✗'} {b['label']}: check_win accepts it — the network did, so we must too (bits 0x{b['bits']:08x}, exp 0x{b['bits'] >> 24:02x})")
        if not ok:
            fails.append(f"{b['label']}: check_win REJECTED a real accepted block (wrong byte order)")

        # must not accept a hash that misses: flip the nonce, overwhelmingly likely to fail at this target
        other = hash_block_header(version=b["version"], prev_hash_hex=b["prev"], merkle_root_hex=b["merkle"],
                                  timestamp=b["time"], bits=b["bits"], nonce=b["nonce"] + 1)
        ok = not check_win(other, target)
        print(f"  {'✓' if ok else '✗'} {b['label']}: rejects the same header with a different nonce")
        if not ok:
            fails.append(f"{b['label']}: check_win accepted a hash that does not meet target")

        # guard the specific inversion that caused this — big-endian must NOT be what we use
        ok = not (int.from_bytes(digest, "big") <= target)
        print(f"  {'✓' if ok else '✗'} {b['label']}: the old big-endian reading would have rejected it")
        if not ok:
            fails.append(f"{b['label']}: big-endian agrees here — this vector no longer discriminates, pick another block")
        print()

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("check_win agrees with consensus.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
