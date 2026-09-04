#!/usr/bin/env python3
"""A restarted miner must not draw the block the previous process already drew.

The poll loop kept "which block did I last ticket?" in a local variable, so every restart began at None and
the new process ticketed the current tip again. Same seed, same height, same nonce, same hash — the same
ticket logged twice. On a real install (2026-08-29/30) 22 of 1,000 stored tickets were repeats, each a minute
or two after a watchdog "miner stalled" restart; one block was logged four times in ten minutes. They inflated
total_attempts, the yardstick a record's depth is judged lucky against, and the odds map counted a hash twice.

Two layers: resume_height() on the on-disk shape record_attempt actually writes, and the loop itself, driven
end to end with the network stubbed out, so the test pins the wiring and not just the helper. Confirmed to
fail against the old loop before the fix: the "same tip after a restart" case logged a second ticket.

    python3 tests/test_resume_height.py
"""
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
os.environ.setdefault("LOTTERY_DATA_DIR", tempfile.mkdtemp(prefix="resume-height-test-"))
import lottery_miner as lm  # noqa: E402

SEED = "7346a1154e214bec"
SETTINGS = {"mode": "symbolic", "machine_seed": SEED, "payout_address": ""}


def attempt(height: int, mode: str = "symbolic") -> "lm.BlockAttempt":
    return lm.BlockAttempt(height=height, prev_hash="00" * 32, bits=0x17023AD4, nonce=lm.pick_nonce(height, SEED),
                           hash_hex=format(height, "064x"), target_hex="0" * 8 + "f" * 56, won=False, mode=mode)


class WouldWait(Exception):
    """The loop decided there was nothing to draw and went to sleep — the outcome the fix exists to produce."""


def run_loop_once(tip: int) -> str:
    """Drive watch_and_hash(once=True) against a fixed tip with every network call stubbed.

    Returns "drew" if the loop ticketed the tip and returned, "waited" if it declined and slept.
    """
    saved = {n: getattr(lm, n) for n in ("get_tip_height", "refresh_node_status", "update_price_state",
                                          "update_wallet_balance_state", "symbolic_attempt",
                                          "install_stall_reporting")}
    saved_sleep = lm.time.sleep

    def sleep(_s):
        raise WouldWait()

    try:
        lm.get_tip_height = lambda timeout=0: tip
        lm.refresh_node_status = lambda state, settings: state
        lm.update_price_state = lambda state, config: state
        lm.update_wallet_balance_state = lambda state, config: state
        lm.symbolic_attempt = lambda height, seed: attempt(height)
        lm.install_stall_reporting = lambda log: None
        lm.time.sleep = sleep
        try:
            lm.watch_and_hash(dict(SETTINGS), once=True, daemon=False)
            return "drew"
        except WouldWait:
            return "waited"
    finally:
        for n, f in saved.items():
            setattr(lm, n, f)
        lm.time.sleep = saved_sleep


def main() -> int:
    fails = []

    def check(label, got, want):
        ok = got == want
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}: {got!r}")
        if not ok:
            fails.append(f"{label}: got {got!r}, want {want!r}")

    print("resume_height() on the shape record_attempt writes")
    state = lm.record_attempt(lm.load_state(), attempt(965368), SEED, "symbolic")
    check("same mode → the height the last process drew", lm.resume_height(state, "symbolic"), 965368)
    check("other mode → a symbolic draw does not settle a live one", lm.resume_height(state, "live"), None)
    check("fresh install, nothing drawn yet", lm.resume_height({"history": []}, "symbolic"), None)
    check("garbage on disk is ignored, not crashed on", lm.resume_height({"last_attempt": {"height": "965368", "mode": "symbolic"}}, "symbolic"), None)
    check("a bool is not a height", lm.resume_height({"last_attempt": {"height": True, "mode": "symbolic"}}, "symbolic"), None)

    print("the loop, restarted against the tip it already drew")
    lm.save_state(state)
    before = lm.load_state()["stats"]["total_attempts"]
    check("first process drew block 965368", before, 1)
    check("restart, same tip → waits for the next block instead of drawing again", run_loop_once(965368), "waited")
    check("no second ticket was logged", lm.load_state()["stats"]["total_attempts"], before)
    check("the stored ticket count for that block", sum(1 for t in lm.load_state()["history"] if t["height"] == 965368), 1)

    print("the loop, restarted after a new block arrived")
    check("restart, tip moved on → draws it", run_loop_once(965369), "drew")
    check("exactly one more ticket", lm.load_state()["stats"]["total_attempts"], before + 1)
    check("and it is the new block", lm.load_state()["last_attempt"]["height"], 965369)

    print("a mode switch is not a restart")
    live = lm.load_state(); live["last_attempt"]["mode"] = "live"; lm.save_state(live)
    check("last draw was live, this process is symbolic → the block is still owed a draw", run_loop_once(965369), "drew")

    if fails:
        print("\nFAILED:\n  " + "\n  ".join(fails))
        return 1
    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
