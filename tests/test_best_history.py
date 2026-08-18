#!/usr/bin/env python3
"""The record ladder — best_history — must survive the ticket window rolling over.

`history` is a rolling window (HISTORY_LIMIT tickets). `best` is the standing record. Neither one can answer
"when did each record land?": derive the ladder from the window and it rewrites itself as old tickets fall off
the end. That is not hypothetical — it was watched happening while this was being written: two blocks arrived
between two runs of the same derivation and the oldest two "records" vanished, changing the earliest record
from 0 bits to 1 bit. A record that scrolled out of the window is still the record, so it gets its own list.

    python3 tests/test_best_history.py
"""
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import os  # noqa: E402

os.environ.setdefault("LOTTERY_DATA_DIR", tempfile.mkdtemp(prefix="best-history-test-"))
import lottery_miner as lm  # noqa: E402


def hash_with_zero_bits(z: int) -> str:
    """A 256-bit hash with exactly z leading zero bits."""
    return format((1 << (255 - z)) | 1, "064x")


def ticket(height: int, z: int, at: str) -> dict:
    return {"mode": "live", "height": height, "hash_hex": hash_with_zero_bits(z), "nonce": height, "attempted_at": at}


def attempt(height: int, z: int) -> "lm.BlockAttempt":
    h = hash_with_zero_bits(z)
    return lm.BlockAttempt(height=height, prev_hash="00" * 32, bits=0x17023AD4, nonce=height,
                           hash_hex=h, target_hex="0" * 8 + "f" * 56, won=False, mode="live")


def stamp(day: int) -> str:
    return f"2026-08-{day:02d}T00:00:00+00:00"


def main() -> int:
    fails = []

    def check(label, got, want):
        ok = got == want
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}: {got!r}")
        if not ok:
            fails.append(f"{label}: got {got!r}, want {want!r}")

    # --- seeding from the stored window: one entry per IMPROVEMENT, oldest-first ---
    print("seed the ladder from the stored ticket window")
    history = [ticket(1000 + i, z, stamp(10 + i)) for i, z in enumerate([2, 1, 5, 3, 9])]
    state = lm.normalize_stats({"history": list(reversed(history))})  # history is stored newest-first
    ladder = state["best_history"]
    check("records", [(e["zero_bits"], e["height"]) for e in ladder], [(2, 1000), (5, 1002), (9, 1004)])
    check("each carries its timestamp", [e["at"] for e in ladder], [stamp(10), stamp(12), stamp(14)])
    check("all marked reconstructed", all(e["seeded"] for e in ladder), True)

    # --- a record set BEFORE the window still belongs on the ladder ---
    print("a record older than the stored window is kept")
    older = {"zero_bits": 17, "height": 42, "hash": hash_with_zero_bits(17), "nonce": 42, "at": stamp(1)}
    state = lm.normalize_stats({"history": list(reversed(history)), "best": older})
    check("standing record is on the ladder", state["best_history"][-1]["zero_bits"], 17)

    # --- seeding runs ONCE: a real ladder is never rebuilt from the (rolling) window ---
    print("an existing ladder is left alone")
    kept = [{"zero_bits": 3, "height": 7, "hash": hash_with_zero_bits(3), "nonce": 7, "at": stamp(2)}]
    state = lm.normalize_stats({"history": list(reversed(history)), "best_history": list(kept)})
    check("untouched", state["best_history"], kept)

    # --- recording a beaten record appends; a worse ticket does not ---
    print("a new record appends one step; a losing ticket appends nothing")
    lm.fetch_network_winner = lambda *a, **k: None  # offline: this test never touches the network
    state = lm.normalize_stats({"history": list(reversed(history))})
    before = len(state["best_history"])
    state = lm.record_attempt(state, attempt(2000, 12), "seed", "live")
    check("ladder grew by one", len(state["best_history"]) - before, 1)
    check("newest step is the new record", state["best_history"][-1]["zero_bits"], 12)
    check("the step is dated", bool(state["best_history"][-1]["at"]), True)
    check("live steps aren't flagged as reconstructed", "seeded" in state["best_history"][-1], False)
    check("it matches best", state["best"]["zero_bits"], state["best_history"][-1]["zero_bits"])
    state = lm.record_attempt(state, attempt(2001, 4), "seed", "live")
    check("a worse ticket adds no step", len(state["best_history"]) - before, 1)

    # --- a poisoned history must not take the miner down with it ---
    #
    # load_state() calls normalize_stats with no guard, and this seeding loop runs on EVERY existing install
    # (best_history is a new key), over every ticket on their disk. An unparseable hash there would be a miner
    # that will not start — for everyone, on the first launch after updating.
    print("a malformed ticket is skipped, not fatal")
    poisoned = [
        ticket(1100, 3, stamp(20)),
        {"mode": "live", "height": 1101, "hash_hex": "not-a-hash", "attempted_at": stamp(21)},
        {"mode": "live", "height": 1102, "hash_hex": None, "attempted_at": stamp(22)},
        {"mode": "live", "height": 1103, "attempted_at": stamp(23)},
        ticket(1104, 8, stamp(24)),
    ]
    state = lm.normalize_stats({"history": list(reversed(poisoned))})
    check("good tickets still seed the ladder", [e["zero_bits"] for e in state["best_history"]], [3, 8])
    check("…and the histogram", sorted(state["zhist"]), ["3", "8"])
    check("…and the standing record", state["best"]["zero_bits"], 8)
    check("a non-numeric stored best is ignored, not compared", "best_history" in
          lm.normalize_stats({"history": [], "best": {"zero_bits": None, "hash": "00ff"}}), True)

    # --- the ladder is bounded ---
    print("the ladder is bounded")
    state = {"best_history": [{"zero_bits": i, "at": stamp(1)} for i in range(lm.BEST_HISTORY_LIMIT + 40)], "history": []}
    state = lm.record_attempt(state, attempt(3000, 200), "seed", "live")
    check("capped at BEST_HISTORY_LIMIT", len(state["best_history"]), lm.BEST_HISTORY_LIMIT)
    check("the newest record survives the trim", state["best_history"][-1]["zero_bits"], 200)

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("the record ladder holds: seeded once, appended per record, capped, and dated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
