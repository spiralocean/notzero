#!/usr/bin/env python3
"""The process sampler runs, and on Windows it actually finds the miner and the node.

`_sample_processes()` in scripts/node_bridge.py has two branches. The POSIX one (`ps -axo rss=,time=,args=`)
runs on every mac and Linux install continuously. The Windows one — a PowerShell `Get-Process` pipeline —
was written blind and, until this test, had executed on NO MACHINE ANYWHERE: CI only ever compiled the bridge
through PyInstaller, it never ran it. That is also how psutil shipped dead for weeks.

WINDOWS gets the full test. Matching there is on ProcessName, which comes from the executable's FILENAME and
ignores argv entirely, so a fake is a real file called miner.exe / bitcoind.exe. It is copied NEXT TO
python.exe rather than into a temp dir, so python3xx.dll resolves from the same directory.

POSIX only gets a shape check on the parser, and that is deliberate rather than lazy. Faking a named process
is not portable: on Linux `ps` reads /proc/pid/cmdline, so overriding argv[0] works, but on macOS `ps` reports
the real exec path and the override is invisible — a fake spawned that way is simply absent from the rows, and
an earlier draft of this file "passed" on a mac purely because a real notzero install happened to be running.
Better a check that states what it covers than one that quietly measures someone's live app.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
import node_bridge as nb  # noqa: E402

WIN = sys.platform == "win32"

# Holds an unmistakable amount of memory, burns a little CPU so the cumulative-seconds counter is non-zero,
# then idles well past the end of the test.
CHILD = ("import time\n"
         "blob = bytearray(48 * 1024 * 1024)\n"
         "blob[::4096] = b'x' * len(blob[::4096])\n"   # touch every page so it is resident, not just reserved
         "end = time.time() + 1.0\n"
         "while time.time() < end: pass\n"
         "time.sleep(180)\n")


def check_rows(rows, fails):
    """Every row is (rss_bytes, cpu_seconds, text) and usable — the parser produced data, not debris."""
    ok = bool(rows)
    print(f"  {'✓' if ok else '✗'} the sampler returned {len(rows)} process row(s) on {sys.platform}")
    if not ok:
        fails.append("_sample_processes() returned nothing — the platform branch failed or was unparseable")
        return
    shaped = all(isinstance(r, tuple) and len(r) == 3 and isinstance(r[0], int) and r[0] >= 0
                 and isinstance(r[1], float) and r[1] >= 0 and isinstance(r[2], str) for r in rows)
    print(f"  {'✓' if shaped else '✗'} every row is (rss_bytes, cpu_seconds, text) with sane values")
    if not shaped:
        bad = next(r for r in rows if not (isinstance(r, tuple) and len(r) == 3))
        fails.append(f"a row came back malformed: {bad!r}")
    biggest = max(rows, key=lambda r: r[0])
    ok = biggest[0] > 1024 * 1024
    print(f"  {'✓' if ok else '✗'} the largest process reads as {biggest[0] / 1048576:.0f} MB — memory is being parsed")
    if not ok:
        fails.append(f"no process had a plausible footprint; largest was {biggest[0]} bytes")


def main():
    fails = []
    if not WIN:
        check_rows(nb._sample_processes(), fails)
        print()
        if fails:
            for f in fails[:8]:
                print("FAIL:", f)
            return 1
        print(f"the sampler's {sys.platform} branch parses; the miner/node MATCH is covered on Windows,")
        print("where the branch had never run at all (see this file's docstring for why not here).")
        return 0

    # ---- Windows: the branch that had never executed anywhere -------------------------------------------
    pydir = pathlib.Path(sys.executable).parent
    procs, made = [], []
    try:
        for name in ("miner.exe", "bitcoind.exe"):
            fake = pydir / name
            if not fake.exists():
                shutil.copy2(sys.executable, fake)
                made.append(fake)
            procs.append(subprocess.Popen([str(fake), "-c", CHILD]))

        time.sleep(3)   # let both allocate and get past their CPU burn
        dead = [p for p in procs if p.poll() is not None]
        if dead:
            print(f"  ✗ {len(dead)} fake process(es) exited early (rc={[p.returncode for p in dead]})")
            print("FAIL: the fakes could not be started — the test could not run")
            return 1

        rows = nb._sample_processes()
        check_rows(rows, fails)
        if fails:
            for f in fails[:8]:
                print("FAIL:", f)
            return 1

        res = nb.miner_proc_stats()
        ok = bool(res)
        print(f"  {'✓' if ok else '✗'} miner_proc_stats() reported {res}")
        if not ok:
            print("FAIL: rows were sampled but neither the miner nor the node matched them")
            return 1

        node = res.get("node") or {}
        for good, msg in (
            (res.get("mem_mb", 0) > 5, f"the miner is found with a plausible footprint ({res.get('mem_mb')} MB)"),
            (bool(node), "the node is found too, reported separately from the miner"),
            (node.get("mem_mb", 0) > 5, f"…with a plausible footprint of its own ({node.get('mem_mb')} MB)"),
            (bool(res.get("total")), "and a combined total, which is what the dashboard shows"),
        ):
            print(f"  {'✓' if good else '✗'} {msg}")
            if not good:
                fails.append(msg)

        # cpu is 0.0 on a first sample by design (no baseline to difference against) — assert only that the
        # field exists and is sane, never that it is non-zero, or this flakes on an idle runner.
        for role, d in (("miner", res), ("node", node)):
            cpu = d.get("cpu")
            good = isinstance(cpu, (int, float)) and cpu >= 0
            print(f"  {'✓' if good else '✗'} {role} cpu reads as a number ({cpu})")
            if not good:
                fails.append(f"{role} cpu was {cpu!r}")
    finally:
        for p in procs:
            p.kill()
        for p in procs:
            try:
                p.wait(timeout=10)
            except Exception:  # noqa: BLE001 — best effort; the runner is torn down anyway
                pass
        for f in made:        # only the copies WE made, never a pre-existing file
            try:
                f.unlink()
            except OSError:
                pass

    print()
    if fails:
        for f in fails[:8]:
            print("FAIL:", f)
        return 1
    print("the process sampler works on Windows — PowerShell branch runs, parses, and finds both processes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
