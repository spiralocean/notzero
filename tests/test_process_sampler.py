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
    """Every row is (pid, rss_bytes, cpu_seconds, text) and usable — the parser produced data, not debris."""
    ok = bool(rows)
    print(f"  {'✓' if ok else '✗'} the sampler returned {len(rows)} process row(s) on {sys.platform}")
    if not ok:
        fails.append("_sample_processes() returned nothing — the platform branch failed or was unparseable")
        return
    shaped = all(isinstance(r, tuple) and len(r) == 4 and isinstance(r[0], int) and r[0] > 0
                 and isinstance(r[1], int) and r[1] >= 0
                 and isinstance(r[2], float) and r[2] >= 0 and isinstance(r[3], str) for r in rows)
    print(f"  {'✓' if shaped else '✗'} every row is (pid, rss_bytes, cpu_seconds, text) with sane values")
    if not shaped:
        bad = next(r for r in rows if not (isinstance(r, tuple) and len(r) == 4 and isinstance(r[0], int) and r[0] > 0))
        fails.append(f"a row came back malformed: {bad!r}")
    biggest = max(rows, key=lambda r: r[1])
    ok = biggest[1] > 1024 * 1024
    print(f"  {'✓' if ok else '✗'} the largest process reads as {biggest[1] / 1048576:.0f} MB — memory is being parsed")
    if not ok:
        fails.append(f"no process had a plausible footprint; largest was {biggest[1]} bytes")


def check_real_memory(fails):
    """The honest-memory conversion returns something sane for a process we KNOW the size of — this one.

    The bug being fixed here is a measurement one (RSS counts mmap'd files, so bitcoind read ~6x its real
    size), and the failure mode of the fix is the mirror image: a parser that silently returns nothing and
    falls back to the same wrong RSS, invisibly. So check it against a live pid rather than trusting it.
    """
    rss = 0
    for pid, r, _cpu, _text in nb._sample_processes():
        if pid == os.getpid():
            rss = r
            break
    got = nb._real_memory_bytes(os.getpid(), rss or 1)
    ok = isinstance(got, int) and got > 0
    print(f"  {'✓' if ok else '✗'} real memory for this test process reads as {got / 1048576:.1f} MB (rss {rss / 1048576:.1f} MB)")
    if not ok:
        fails.append(f"_real_memory_bytes() returned {got!r}")
        return
    # Never MORE than RSS: every platform path either excludes mapped files or returns RSS unchanged. A result
    # above it means the units were misread — the exact class of bug that made the old number nonsense.
    if rss and got > rss * 1.05:
        print(f"  ✗ it exceeds RSS, so the units are being misread")
        fails.append(f"_real_memory_bytes() returned {got} for a process whose RSS is {rss}")
    elif rss:
        print(f"  ✓ it does not exceed RSS, so the units parsed correctly")
    # A pid that cannot exist must fall back to the RSS handed in, never crash or return 0.
    fell_back = nb._real_memory_bytes(-1, 12345)
    ok = fell_back == 12345
    print(f"  {'✓' if ok else '✗'} an unreadable process falls back to the RSS it was given ({fell_back})")
    if not ok:
        fails.append(f"fallback returned {fell_back!r}, expected 12345")


def check_footprint_parser(fails):
    """The macOS parser, exercised on every platform — it's pure text handling and CI is mostly not a mac."""
    cases = [
        ("    phys_footprint: 450 MB\n", 450 * 1024 ** 2),
        ("phys_footprint: 7714 KB", 7714 * 1024),
        ("phys_footprint: 1.5 GB", int(1.5 * 1024 ** 3)),
        ("phys_footprint_peak: 900 MB\nphys_footprint: 450 MB", 450 * 1024 ** 2),  # must not match the PEAK line
        ("phys_footprint: 450 QB", None),                                          # unknown unit -> caller keeps RSS
        ("nothing useful here", None),
    ]
    for text, want in cases:
        got = nb._footprint_bytes(text)
        ok = got == want
        print(f"  {'✓' if ok else '✗'} {text.strip().splitlines()[-1][:40]!r} -> {got}")
        if not ok:
            fails.append(f"_footprint_bytes({text!r}) returned {got!r}, expected {want!r}")


FIND_DEADLINE = 45.0   # generous: only reached when something is actually wrong, so it costs nothing on a good run
FAKE_MIN_RSS = 5 * 1024 * 1024


def wait_for_fakes(procs):
    """Poll until the sampler reports BOTH fakes at a size the later assertions need. -> (rows, error_or_None).

    This replaces `time.sleep(3)` and a single sample. That was a bet that the runner is quick, and on
    2026-08-03 the bet lost: the sampler came back empty, the release dry run failed, and the very same commit
    passed on a re-run — a red X that cost a release cycle and proved nothing. A fixed delay also had to cover
    two different waits at once (the process existing, and it having allocated its memory); waiting for the
    condition the assertions actually depend on covers both without guessing at either.
    """
    started = time.time()
    attempts = 0
    rows, hits = [], {}
    while True:
        dead = [p for p in procs if p.poll() is not None]
        if dead:
            print(f"  ✗ {len(dead)} fake process(es) exited early (rc={[p.returncode for p in dead]})")
            return rows, "the fakes could not be started — the test could not run"
        attempts += 1
        rows = nb._sample_processes()
        hits = {name: rss for _pid, rss, _cpu, name in rows if name in ("miner", "bitcoind")}
        if len(hits) == 2 and all(rss > FAKE_MIN_RSS for rss in hits.values()):
            waited = time.time() - started
            print(f"  ✓ both fakes sampled after {attempts} attempt(s) in {waited:.1f}s")
            if attempts > 1:  # a breadcrumb on a PASSING run: if this creeps up, the runner is getting slower
                print(f"    (the first {attempts - 1} attempt(s) came back short — noted, not a failure)")
            return rows, None
        if time.time() - started >= FIND_DEADLINE:
            print(f"  ✗ the sampler never reported both fakes — {attempts} attempt(s) over {time.time() - started:.0f}s")
            print(f"    last sample: {len(rows)} row(s), matched {sorted(hits) or 'nothing'}")
            diagnose()
            return rows, "_sample_processes() did not report the miner and the node"
        time.sleep(1)


def diagnose():
    """Say WHICH failure this was. _sample_processes() swallows every error into [], so an empty result means
    either 'PowerShell failed or overran its timeout' or 'PowerShell ran fine and nothing matched' — opposite
    problems, identical symptom. Today's flake was unexplainable for exactly that reason, so ask directly."""
    ps = ["powershell", "-NoProfile", "-NonInteractive", "-Command"]
    script = ("Get-Process | Where-Object { $_.ProcessName -in 'bitcoind','miner' } | "
              "Select-Object ProcessName,WorkingSet64,CPU | ConvertTo-Json -Compress")
    t0 = time.time()
    try:
        p = subprocess.run(ps + [script], capture_output=True, text=True, timeout=60)
        took = time.time() - t0
        print(f"  · direct PowerShell call: rc={p.returncode} in {took:.1f}s (the sampler allows {nb.SAMPLE_TIMEOUT:.0f}s)")
        for label, s in (("stdout", p.stdout), ("stderr", p.stderr)):
            if s.strip():
                print(f"    {label}: {s.strip()[:400]}")
        if took > nb.SAMPLE_TIMEOUT:
            print(f"    → PowerShell is SLOWER than the sampler's {nb.SAMPLE_TIMEOUT:.0f}s budget. That is a PRODUCT bug,")
            print("      not a test bug: on a Windows install this same overrun blanks the dashboard's CPU/RAM readout.")
    except subprocess.TimeoutExpired:
        print("  · direct PowerShell call did not return within 60s — the shell itself is wedged on this runner")
    except Exception as e:  # noqa: BLE001 — diagnosis must never mask the failure it is explaining
        print("  · could not run PowerShell directly:", e)
    try:
        p = subprocess.run(ps + ["Get-Process | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique"],
                           capture_output=True, text=True, timeout=60)
        names = {n.strip().lower() for n in p.stdout.splitlines() if n.strip()}
        print(f"  · do the fakes exist at all? miner={'miner' in names} bitcoind={'bitcoind' in names} "
              f"({len(names)} distinct process name(s) on the box)")
    except Exception as e:  # noqa: BLE001
        print("  · could not enumerate process names:", e)


def main():
    fails = []
    check_footprint_parser(fails)   # pure text handling, so it runs everywhere including Windows CI
    if not WIN:
        check_rows(nb._sample_processes(), fails)
        check_real_memory(fails)
        print()
        if fails:
            for f in fails[:8]:
                print("FAIL:", f)
            return 1
        print(f"the sampler's {sys.platform} branch parses and reports real memory; the miner/node MATCH is")
        print("covered on Windows, where the branch had never run at all (see this file's docstring for why).")
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

        rows, err = wait_for_fakes(procs)
        if err:
            print("FAIL:", err)
            return 1

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
