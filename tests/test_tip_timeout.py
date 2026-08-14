#!/usr/bin/env python3
"""tip_timeout_sec() — how long the poll loop is allowed to wait on mempool.space.

The call has two jobs and they want opposite timeouts. When the miner has no node of its own — symbolic
mode, or a node still coming up — the public tip is what TRIGGERS the next attempt, and cutting it short
loses tickets. When our own node is serving the tip, the same call is decoration, and a slow route to a
third party has no business holding up the loop.

Observed on a real install 2026-08-12, with the node healthy and serving the tip the whole time:
    BLOCKED in 'mempool.space tip' for 13s and still waiting
    BLOCKED in 'mempool.space tip' for 11s and still waiting
Each stall ate roughly a third of a 30-second cycle waiting for a number nothing was waiting on.

The asymmetry that matters: being wrong toward the SHORT timeout can cost a real ticket, being wrong toward
the LONG one costs a display number for one pass. So every uncertain case must resolve long, and that is what
most of this file pins down.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import lottery_miner as m  # noqa: E402

READY = {"ready": True, "blocks": 962000}
fails = []


def check(got, want, label):
    ok = got == want
    print(f"  {'✓' if ok else '✗'} {label}: {got}s")
    if not ok:
        fails.append(f"{label}: got {got}, expected {want}")


print("our own node is serving the tip → the public tip is decoration")
check(m.tip_timeout_sec("live", READY), m.TIP_DISPLAY_TIMEOUT_SEC, "live + node ready with a height")

print("\nthe public tip is the TRIGGER → wait for it")
check(m.tip_timeout_sec("symbolic", None), m.TIP_TIMEOUT_SEC, "symbolic mode has no node at all")
check(m.tip_timeout_sec("symbolic", READY), m.TIP_TIMEOUT_SEC, "symbolic mode, even if node state lingers")
check(m.tip_timeout_sec("live", None), m.TIP_TIMEOUT_SEC, "live, no node state yet (first pass)")
check(m.tip_timeout_sec("live", {}), m.TIP_TIMEOUT_SEC, "live, empty node state")
check(m.tip_timeout_sec("live", {"ready": False, "blocks": 962000}), m.TIP_TIMEOUT_SEC, "live, node not ready (syncing)")
check(m.tip_timeout_sec("live", {"ready": True}), m.TIP_TIMEOUT_SEC, "live, node ready but no height yet")
check(m.tip_timeout_sec("live", {"ready": True, "blocks": 0}), m.TIP_TIMEOUT_SEC, "live, node ready at height 0")

print("\nthe two timeouts are sane relative to the loop")
ok = m.TIP_DISPLAY_TIMEOUT_SEC < m.TIP_TIMEOUT_SEC
print(f"  {'✓' if ok else '✗'} display ({m.TIP_DISPLAY_TIMEOUT_SEC}s) is shorter than trigger ({m.TIP_TIMEOUT_SEC}s)")
if not ok:
    fails.append("the display timeout is not shorter than the trigger timeout")

# The whole point is that a stalled third-party call cannot dominate the cycle. 13s of a 30s loop did.
ok = m.TIP_DISPLAY_TIMEOUT_SEC <= m.POLL_INTERVAL_SEC / 5
print(f"  {'✓' if ok else '✗'} display timeout is at most a fifth of the {m.POLL_INTERVAL_SEC}s poll interval")
if not ok:
    fails.append(f"display timeout {m.TIP_DISPLAY_TIMEOUT_SEC}s is too large a share of a {m.POLL_INTERVAL_SEC}s loop")

# And it must still be long enough for an ordinary round trip to a healthy API.
ok = m.TIP_DISPLAY_TIMEOUT_SEC >= 2
print(f"  {'✓' if ok else '✗'} display timeout leaves room for a normal round trip (>= 2s)")
if not ok:
    fails.append("display timeout is so short it would fail on a healthy connection")

# The watchdog restarts the miner if a pass takes ~4 intervals. Every timeout in one pass must fit well
# inside that, or tightening one call could still let the loop trip the watchdog.
ok = m.TIP_TIMEOUT_SEC < m.POLL_INTERVAL_SEC * 4
print(f"  {'✓' if ok else '✗'} even the patient timeout stays under the watchdog's ~{m.POLL_INTERVAL_SEC * 4}s")
if not ok:
    fails.append("the trigger timeout alone could trip the miner watchdog")

print()
if fails:
    for f in fails:
        print("FAIL:", f)
    sys.exit(1)
print("tip timeouts: short only when our own node serves the tip; every uncertain case waits.")
