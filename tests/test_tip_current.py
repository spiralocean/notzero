#!/usr/bin/env python3
"""tip_is_current() — does the node's own tip get published as the chain tip, or not?

The case this exists for: a laptop sleeps overnight. bitcoind keeps running, so Core's
`initialblockdownload` stays latched false, while the node is hours of blocks behind. Gating on that flag
alone published a stale block as the current tip, and the dashboard drew "+146 min since last block" and then
counted DOWN as the node caught up, because every poll landed on a newer block that was still in the past.

The distinction that matters, and the one this file pins down: BEHIND (headers ahead of blocks — the network
has blocks we have not processed) must be suppressed, while a genuinely LONG BLOCK INTERVAL (caught up, tip
simply old) must NOT be, because that is exactly what the NEXT BLOCK panel exists to display.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import node_bridge as nb  # noqa: E402

CASES = [
    # (name, chain, expected)
    ("caught up, fresh tip", {"blocks": 960063, "headers": 960063, "initialblockdownload": False}, True),
    ("headers lead by one — a block arriving right now, not a backlog",
     {"blocks": 960063, "headers": 960064, "initialblockdownload": False}, True),
    ("woke from an overnight sleep: not in IBD, but 62 blocks behind",
     {"blocks": 960001, "headers": 960063, "initialblockdownload": False}, False),
    ("two behind — small, but still a backlog we have not processed",
     {"blocks": 960061, "headers": 960063, "initialblockdownload": False}, False),
    ("initial sync", {"blocks": 800000, "headers": 960063, "initialblockdownload": True}, False),
    ("IBD wins even when the counts agree", {"blocks": 960063, "headers": 960063, "initialblockdownload": True}, False),
    ("fields missing → do not claim the tip is current", {"initialblockdownload": False}, False),
    ("nulls from a node that answered oddly", {"blocks": None, "headers": None, "initialblockdownload": False}, False),
    ("empty", {}, False),
]


def main():
    fails = []
    for name, chain, expected in CASES:
        got = nb.tip_is_current(chain)
        ok = got is expected
        print(f"  {'✓' if ok else '✗'} {name} → {'publish' if got else 'suppress'}")
        if not ok:
            fails.append(f"{name}: got {got}, expected {expected}")

    # The property behind the table: being behind by more than the tolerance must ALWAYS suppress, whatever
    # the heights are. A tip-age rule would fail this while passing every row above.
    for blocks in (100, 500000, 960063):
        for gap in range(0, 8):
            chain = {"blocks": blocks, "headers": blocks + gap, "initialblockdownload": False}
            want = gap <= nb.CATCHUP_TOLERANCE
            if nb.tip_is_current(chain) is not want:
                fails.append(f"blocks={blocks} gap={gap}: expected {'publish' if want else 'suppress'}")

    print()
    if fails:
        for f in fails[:8]:
            print("FAIL:", f)
        return 1
    print("the node's tip is published only when it IS the network's tip.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
