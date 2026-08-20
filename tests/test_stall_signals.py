#!/usr/bin/env python3
"""The stall monitor must not report a working miner as idle.

On 2026-08-20T02:50:28Z a healthy install logged:

    IDLE — polls completing (last 0s ago), no ticket for 18m, and the tip (#963245) has caught up with
    what the miner is building (#963245): not stuck in a call, not seeing the new block

Nothing was wrong. bitcoind's own log shows block 963245 was MINED at 02:50:04Z and connected here at
02:50:25Z — 21 seconds later, an ordinary 18m13s inter-block gap — and the ticket for 963246 was recorded at
02:50:28.137Z, three seconds after that. The line described a miner that was at that moment building the
ticket the line said it was not seeing.

The cause is an ordering race the monitor cannot see through:

    note_poll_done(height)  advances `tip`        <- runs BEFORE the attempt is built
    live_attempt(...)                             <- the slowest call in the loop
    record_attempt() -> note_ticket(attempt_h)    <- advances `attempt_h` only AFTER it returns

so `tip >= attempt_h` — the whole test for "the miner is behind" — holds for the entire duration of every
attempt. It stays quiet only because the other clause needs `now - ticket_at >= IDLE_REPORT_SEC`; after a
block interval longer than that, one monitor tick inside the attempt is all it takes.

`live_attempt` was also the ONLY step in the poll loop not wrapped in _timed, which is what let the IDLE
branch's `not step` guard wave it through — and which meant a genuine wedge inside getblocktemplate would be
reported as "not stuck in a call" when being stuck in a call was precisely what had happened.

These tests drive the REAL monitor thread. Nothing here re-implements its condition; a copy of the logic
would have passed against the bug.
"""
import pathlib
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import lottery_miner as m  # noqa: E402

# Scaled-down clocks. The RATIOS are what matter and they are kept faithful to the shipped values: the
# poll-freshness window (STALL_CHECK_SEC * 4) comfortably outlasts an attempt, exactly as 60s outlasts a real
# one — otherwise a test could pass because freshness expired rather than because the fix works.
m.STALL_CHECK_SEC = 0.25    # monitor tick   (ships 15s)
m.IDLE_REPORT_SEC = 0.5     # idle threshold (ships 900s)
m.SLOW_STEP_SEC = 5.0       # blocked threshold, high enough to stay out of the way until scenario 4

TIP, NEXT = 963245, 963246
lines = []
fails = []
threading.Thread(target=m._stall_monitor, args=(lines.append,), daemon=True, name="stall-monitor").start()


def reset(attempt_h, tip):
    """A miner that has just ticketed `attempt_h`, with the chain tip at `tip`."""
    lines.clear()
    m.note_ticket(attempt_h)
    m.note_poll_done(tip)
    with m._stall_lock:
        m._stall["said_idle"] = False
        m._stall["said_blocked"] = False
        m._stall["step"] = None


def poll_for(seconds, tip):
    """Cycle the loop the way a healthy miner does: polls completing, no new block."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        m.note_poll_done(tip)
        time.sleep(m.STALL_CHECK_SEC / 2)


def said(kind):
    return [ln for ln in lines if ln.startswith(kind) or f"BLOCKED in '{kind}'" in ln]


def check(ok, label, detail=""):
    print(f"  {'✓' if ok else '✗'} {label}{(' — ' + detail) if detail and not ok else ''}")
    if not ok:
        fails.append(label + (f" ({detail})" if detail else ""))


# ---------------------------------------------------------------------------------------------------------
print("the regression: a tip that advances while an attempt is in flight")
# The miner ticketed NEXT-1's successor and the chain then sat still for longer than the idle threshold —
# an ordinary long block, and the monitor must stay quiet through it because the tip is still behind us.
reset(attempt_h=TIP, tip=TIP - 1)
poll_for(m.IDLE_REPORT_SEC * 1.6, TIP - 1)
check(not said("IDLE"), "a long block alone is not idle — the tip is still behind what we are building")

# …now the block arrives. note_poll_done() advances the tip BEFORE the attempt is built, which is the window.
lines.clear()
m.note_poll_done(TIP)
m._timed("live attempt", time.sleep, m.STALL_CHECK_SEC * 2)   # the fix: the attempt names itself
m.note_ticket(NEXT)
check(not said("IDLE"), "no IDLE while the attempt that answers the new tip is being built",
      f"logged {lines}")

# ---------------------------------------------------------------------------------------------------------
print("\ncounter-check: the same window WITHOUT _timed is exactly what shipped, and must be caught")
reset(attempt_h=TIP, tip=TIP - 1)
poll_for(m.IDLE_REPORT_SEC * 1.6, TIP - 1)
lines.clear()
m.note_poll_done(TIP)
time.sleep(m.STALL_CHECK_SEC * 2)                              # the unwrapped call, as it was
m.note_ticket(NEXT)
check(bool(said("IDLE")), "an unnamed attempt DOES trip it — so the test above is testing the fix",
      "the harness cannot reproduce the bug, so it proves nothing")

# ---------------------------------------------------------------------------------------------------------
print("\nthe detector's real job still works")
# A loop that is genuinely cycling without moving to a tip that has passed it must still be reported.
reset(attempt_h=TIP, tip=TIP)
poll_for(m.IDLE_REPORT_SEC * 1.6, TIP)
check(bool(said("IDLE")), "a loop polling fine with the tip caught up is still reported idle")

# …and time alone must never be enough, which is the distinction the height test exists to make.
reset(attempt_h=NEXT, tip=TIP)
poll_for(m.IDLE_REPORT_SEC * 1.6, TIP)
check(not said("IDLE"), "a quiet chain with the tip behind us stays silent no matter how long")

# ---------------------------------------------------------------------------------------------------------
print("\na wedged attempt is named, not mislabelled")
m.SLOW_STEP_SEC = m.STALL_CHECK_SEC          # anything in flight this long is stuck
reset(attempt_h=TIP, tip=TIP)
lines.clear()
m._timed("live attempt", time.sleep, m.STALL_CHECK_SEC * 4)
blocked = [ln for ln in lines if "BLOCKED in 'live attempt'" in ln]
check(bool(blocked), "a hung attempt reports BLOCKED naming 'live attempt'", f"logged {lines}")
check(not said("IDLE"), "…and is never reported as 'not stuck in a call'")

print()
if fails:
    for f in fails:
        print("FAIL:", f)
    sys.exit(1)
print("stall signals: an attempt in flight is named, so a working miner is never called idle.")
