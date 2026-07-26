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

def main():
    fails = []

    # 1. The decisive case: a genuine block, verified end to end from its own header fields.
    v, prev, merkle, t, bits, nonce = (
        1, "000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55",
        "7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff", 1231731025, 0x1d00ffff, 1889418792)
    digest = hash_block_header(version=v, prev_hash_hex=prev, merkle_root_hex=merkle, timestamp=t, bits=bits, nonce=nonce)
    shown = digest[::-1].hex()
    expected = "00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee"
    ok = shown == expected
    print(f"  {'✓' if ok else '✗'} rebuilt block 170's header → {shown[:24]}…")
    if not ok:
        fails.append(f"header hash mismatch: got {shown}, expected {expected}")

    target = bits_to_target(bits)
    ok = check_win(digest, target)
    print(f"  {'✓' if ok else '✗'} check_win accepts it — the network did, so we must too")
    if not ok:
        fails.append("check_win REJECTED a real accepted block (wrong byte order)")

    # 2. And it must not accept a hash that misses. Flip the nonce: overwhelmingly likely to fail at this target.
    other = hash_block_header(version=v, prev_hash_hex=prev, merkle_root_hex=merkle, timestamp=t, bits=bits, nonce=nonce + 1)
    ok = not check_win(other, target)
    print(f"  {'✓' if ok else '✗'} check_win rejects the same header with a different nonce")
    if not ok:
        fails.append("check_win accepted a hash that does not meet target")

    # 3. Guard the specific inversion that caused this: big-endian must NOT be what we use.
    big = int.from_bytes(digest, "big") <= target
    ok = not big
    print(f"  {'✓' if ok else '✗'} the old big-endian reading would have rejected it (the bug, kept as a witness)")
    if not ok:
        fails.append("big-endian happens to agree here — this test no longer discriminates, pick another block")

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("check_win agrees with consensus.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
