#!/usr/bin/env python3
"""Under the desktop app, the background miner asks mempool.space for nothing it doesn't need.

The miner runs whether or not there is a window. Its poll loop fetched DECORATION every pass — the tip block's
age and difficulty, the week's hashrate, the price, the block that beat our ticket — for a terminal view and a
retired screensaver. The desktop dashboard reads none of it. Measured on a real install 2026-09-21: five
requests per 30-second pass, ~14,400 a day, against ~650 for the dashboard itself. One of the five looked up
the block being MINED — a height that doesn't exist yet — and so 404'd on every pass until it was found.

Three things are pinned here:
  1. NOTZERO_DESKTOP=1 (set by the app on the engines it spawns): the display + price steps make ZERO requests.
  2. Without it (a terminal user) the decoration still arrives — but the winner lookup waits for the height
     to be mined instead of hammering a 404.
  3. The loop's own public-tip call happens only when our node is NOT serving the tip, and every doubtful
     case resolves to "ask" — being wrong that way costs a request, the other way could cost a ticket.
"""
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import lottery_miner as m  # noqa: E402

fails = []


def check(ok, label):
    print(f"  {'✓' if ok else '✗'} {label}")
    if not ok:
        fails.append(label)


TIP = 967967
calls = []


def fake_http_get(url, *a, **k):
    path = url.replace(m.MEMPOOL_API, "")
    calls.append(path)
    if path == "/blocks/tip/height":
        return TIP
    if path.startswith("/block-height/"):
        h = int(path.rsplit("/", 1)[1])
        if h > TIP:
            raise RuntimeError("404 — not mined yet")
        return f"{h:064x}"
    if path.startswith("/block/"):
        return {"id": path.rsplit("/", 1)[1], "timestamp": 1_789_000_000, "difficulty": 1.3e14}
    if path.startswith("/v1/mining/hashrate"):
        return {"currentHashrate": 9e20, "hashrates": []}
    if path == "/v1/prices":
        return {"USD": 100000}
    raise RuntimeError("unexpected " + path)


m.http_get = fake_http_get


def state(attempt_height):
    return {"last_attempt": {"height": attempt_height, "hash_hex": "ab" * 32, "target_hex": "00" * 8 + "ff" * 24, "won": False},
            "display": {}}


print("under the desktop app (NOTZERO_DESKTOP=1):")
os.environ["NOTZERO_DESKTOP"] = "1"
calls.clear()
st = m.update_display_stats(state(TIP + 1))
st = m.update_price_state(st, {"price_poll_interval_min": 15})
check(calls == [], f"display + price steps make no requests (made {len(calls)}: {calls})")
check("hash_proximity" in st["display"], "the closeness of our own ticket is still computed — that needs no network")

print("from a terminal (no NOTZERO_DESKTOP):")
del os.environ["NOTZERO_DESKTOP"]
calls.clear()
m.update_display_stats(state(TIP + 1))
check("/blocks/tip/height" in calls, "the tip decoration is still fetched")
check(f"/block-height/{TIP + 1}" not in calls, "the block being mined is NOT looked up — it doesn't exist yet")
calls.clear()
st = m.update_display_stats(state(TIP))
check(f"/block-height/{TIP}" in calls and st["display"].get("network_winner", {}).get("hash_hex"),
      "once that height is mined, the winner is fetched")

print("the loop's public tip:")
READY = {"ready": True, "blocks": TIP}
check(m.public_tip_needed("live", READY) is False, "live + our node serving the tip → not needed")
for label, mode, node in [("symbolic mode", "symbolic", READY), ("node still syncing", "live", {"ready": False, "blocks": 5}),
                          ("node ready but no height", "live", {"ready": True, "blocks": 0}),
                          ("no node state at all", "live", None), ("empty node state", "live", {})]:
    check(m.public_tip_needed(mode, node) is True, f"{label} → needed")

if fails:
    print(f"\n{len(fails)} failed")
    sys.exit(1)
print("\nquiet under the desktop app; unchanged from a terminal.")
