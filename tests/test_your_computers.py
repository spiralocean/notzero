#!/usr/bin/env python3
"""_merge_yours() — does each of the user's own computers show as one peer, however it reached us?

The case this exists for: two Macs that list each other (mac-m4.local, stephens-macbook-pro.local) each dial
the other, so Core keeps two connections per pair. Ours dialled the Intel by name and landed on its IPv4; the
Intel dialled us by name and landed on our IPv6 link-local address, so its inbound connection shows up as
[fe80::…%7]:53881. Matching on the dialled IP alone left that as a second "your computer". The name's lookup
returns both addresses, so both connections are one computer.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import node_bridge as nb  # noqa: E402

INTEL_V4, INTEL_V6 = "192.168.10.121", "fe80::db:84f3:1f34:7485"
STRANGER = {"addr": "8.8.8.8:8333", "connection_type": "outbound-full-relay", "bytesrecv": 5}
MANUAL = {"addr": "stephens-macbook-pro.local:8433", "connection_type": "manual", "bytesrecv": 100}
ADDED = [{"addednode": "stephens-macbook-pro.local:8433", "addresses": [{"address": INTEL_V4 + ":8433", "connected": "outbound"}]}]
BY_NAME = {"stephens-macbook-pro.local": {INTEL_V4, INTEL_V6}}


def inbound(addr):
    return {"addr": addr, "connection_type": "inbound", "inbound": True, "bytesrecv": 7}


def yours(peers):
    return [p for p in peers if p.get("_yours")]


CASES = [
    # (name, peers, added, listed, by_name, expected number of your computers, expect "both")
    ("dialled on IPv4, it dialled back on IPv6 link-local", [MANUAL, inbound(f"[{INTEL_V6}%7]:53881"), STRANGER],
     ADDED, {INTEL_V4, INTEL_V6}, BY_NAME, 1, True),
    ("both connections on IPv4", [MANUAL, inbound(INTEL_V4 + ":50122"), STRANGER], ADDED, {INTEL_V4}, BY_NAME, 1, True),
    ("name not looked up yet: the IPv6 one still counts as yours, just separately",
     [MANUAL, inbound(f"[{INTEL_V6}%7]:53881")], ADDED, set(), {}, 2, False),
    ("only it dialled us (we don't list it)", [inbound(f"[{INTEL_V6}%7]:53881"), STRANGER], [], set(), {}, 1, False),
    ("two different computers stay two", [MANUAL, inbound("192.168.10.50:50000")], ADDED, {INTEL_V4, INTEL_V6}, BY_NAME, 2, False),
]


def main():
    fails = []
    for name, peers, added, listed, by_name, n, both in CASES:
        out = nb._merge_yours([dict(p) for p in peers], added, listed, by_name)
        mine = yours(out)
        ok = len(mine) == n and any(p.get("_both") for p in mine) == both
        ok = ok and sum(p.get("bytesrecv", 0) for p in out) == sum(p.get("bytesrecv", 0) for p in peers)
        print(("ok  " if ok else "FAIL"), name, [p["addr"] for p in mine])
        if not ok:
            fails.append(name)
    if nb._host("[fe80::1%7]:8333") != "fe80::1":
        fails.append("_host keeps the %interface suffix")
    print()
    if fails:
        return 1
    print("each of your computers shows once, whichever address it connected from.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
