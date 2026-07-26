#!/usr/bin/env python3
"""The payout address must become the RIGHT script. Runs offline — no node, no network.

address_to_script_pubkey is hand-rolled bech32 and base58. If it derives the wrong scriptPubKey, you win a
block, the network accepts it, and the reward is paid to a script you don't control — silently, irreversibly,
and discoverable only by winning. Nothing compared it against an independent implementation.

A regtest node cannot be that implementation: it only issues regtest addresses (bcrt1…, 2…, m…), which this
code correctly refuses. The authority that IS network-independent is the published test vectors from BIP-173
(bech32 / segwit v0), BIP-350 (bech32m / taproot) and the long-standing base58 encoding — addresses paired
with the exact scriptPubKey they must produce. Every expected value below was taken from Bitcoin Core's own
`validateaddress` on MAINNET — Core is the authority, and two vectors recalled from memory were wrong here
before that check was run.

    python3 tests/test_payout_script.py
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from lottery_miner import address_to_script_pubkey  # noqa: E402

# (label, address, expected scriptPubKey hex, source)
VECTORS = [
    ("P2WPKH  (segwit v0)", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
     "0014751e76e8199196d454941c45d1b3a323f1433bd6", "BIP-173"),
    ("P2WPKH  (lowercase)", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
     "0014751e76e8199196d454941c45d1b3a323f1433bd6", "BIP-173, case-insensitive"),
    ("P2WSH   (segwit v0)", "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
     "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262", "BIP-173"),
    ("P2TR    (taproot v1)", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
     "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "Core validateaddress, mainnet"),
    ("P2PKH   (legacy)", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
     "76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac", "Core validateaddress, mainnet"),
    ("P2SH    (legacy)", "3EktnHQD7RiAE6uzMj2ZifT9YgRrkSgzQX",
     "a9148f55563b9a19f321c211e9b9f38cdf686ea0784587", "Core validateaddress, mainnet"),
]

# Addresses that must be REFUSED. Paying a coinbase to any of these would be paying the wrong network, or a
# corrupted address the user mistyped — both silently unspendable by them.
REJECT = [
    ("regtest bech32", "bcrt1qe3cqvvr4nfwpykedhd5gc876fc8xsrtxvfw39k"),
    ("testnet base58", "mmuoEDFcSJPXatxe91DgGfT6KFkXVssrAg"),
    ("testnet p2sh", "2MvLy97vm6dH8UGRpSXEEJipQFGv3C4wz45"),
    ("mixed case", "Bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"),   # BIP-173 forbids it
    ("bad checksum", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"),
    ("truncated", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7"),
    ("empty", ""),
]


def main():
    fails = []

    for label, addr, expected, src in VECTORS:
        try:
            got = address_to_script_pubkey(addr).hex()
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {label}: raised {type(e).__name__}: {e}")
            fails.append(f"{label} raised instead of deriving a script")
            continue
        ok = got == expected
        print(f"  {'✓' if ok else '✗'} {label} → {got[:26]}…  [{src}]")
        if not ok:
            fails.append(f"{label}: got {got}, expected {expected}")
            print(f"      expected {expected}")

    print()
    for label, addr in REJECT:
        try:
            got = address_to_script_pubkey(addr).hex()
            print(f"  ✗ {label}: ACCEPTED {addr!r} → {got}")
            fails.append(f"{label} was accepted; a coinbase would pay an address the user can't spend")
        except Exception:
            print(f"  ✓ {label}: refused, as it must be")

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("every payout address derives the script the spec says it must.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
