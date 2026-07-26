#!/usr/bin/env python3
"""BIP34 coinbase height must be a valid CScriptNum. Offline — no node, no network.

CScriptNum is SIGNED little-endian: if the most significant byte has its high bit set, a 0x00 byte must
follow, or the value reads as negative. That byte was missing, so any height whose top byte is >= 0x80 built
a coinbase Core rejects with "bad-cb-height" — and the resubmit loop would then retry forever a block that
can never land. Mainnet is outside the affected range today and until height 8,388,608; regtest runs inside
it, which is how this surfaced.

    python3 tests/test_coinbase_height.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from lottery_miner import _encode_height  # noqa: E402

# height -> expected push (length byte + minimally-encoded signed little-endian value)
CASES = [
    (0, "0100"), (1, "0101"), (111, "016f"), (127, "017f"),
    (128, "028000"),          # first height needing the sign byte
    (227, "02e300"),          # the regtest height that exposed it
    (255, "02ff00"),
    (256, "020001"),          # back to no sign byte
    (32767, "02ff7f"), (32768, "03008000"), (65535, "03ffff00"), (65536, "03000001"),
    (959666, "03b2a40e"),     # mainnet, mid-2026 — top byte 0x0E, no sign byte needed
    (8388607, "03ffff7f"),    # last height before 3-byte heights need the sign byte
    (8388608, "0400008000"),
]


def main():
    fails = []
    for h, expected in CASES:
        got = _encode_height(h).hex()
        ok = got == expected
        note = "" if not (len(got) > 2 and got.endswith("00") and int(got[-4:-2], 16) >= 0x80) else "  (sign byte)"
        print(f"  {'✓' if ok else '✗'} height {h:>9} → {got}{note}")
        if not ok:
            fails.append(f"height {h}: got {got}, expected {expected}")
    # the property, not just the table: a top byte >= 0x80 must always be followed by 0x00
    for h in list(range(120, 300)) + [70000, 8388600, 8388610]:
        raw = _encode_height(h)[1:]
        if raw[-1] & 0x80:
            fails.append(f"height {h} encodes to {raw.hex()} — top byte has its high bit set, reads as negative")
    print()
    if fails:
        for f in fails[:8]:
            print("FAIL:", f)
        return 1
    print("every coinbase height encodes as a valid CScriptNum.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
