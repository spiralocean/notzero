#!/usr/bin/env python3
"""Every test file in this repo is actually executed by CI.

THREE TIMES NOW, a test or a code path has existed in the tree while running on no machine anywhere:

  1. psutil shipped dead for weeks — CI compiled the bridge through PyInstaller but never RAN it.
  2. The bridge's Windows PowerShell sampler branch had executed on NO MACHINE until a test was written
     for it specifically (see tests/test_process_sampler.py's docstring).
  3. 2026-08-14: five of the six files under tests/ ran nowhere in CI. Only test_process_sampler.py was
     wired up — and only in the Windows job, because THAT one had already shipped a dead branch. The
     miner's consensus-critical maths (check_win, coinbase_height, payout_script, tip_current) was
     covered by tests that never ran.

The unifying failure is not a language or a platform. It is that a test file's EXISTENCE was being taken
as evidence that it RUNS. Adding the missing wiring fixes today's instance; it does nothing about the
fourth. This file is the thing that makes the fourth impossible: it enumerates the test files on disk,
works out which ones the release workflow actually invokes, and fails naming any that nothing runs.

Deliberately dependency-free — no YAML parser, no globbing library beyond the stdlib. It reads the
workflow as text, because a guard that needs a dependency installed is a guard that can itself silently
stop running. If it is ever wrong it should be wrong LOUDLY (a false alarm), never quietly.
"""
import fnmatch
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github/workflows/release.yml"

# What counts as a test file. Several conventions are already in use here, and the one that nearly slipped
# past while writing this guard was scripts/test-win-regtest.py — a hyphen, not an underscore, so a
# `test_*` search misses it entirely. Cast wide; a false positive is a visible argument, a miss is silence.
TEST_PATTERNS = [
    "*.test.js", "*.test.mjs", "*.test.cjs",
    "*.spec.js", "*.spec.mjs", "*.spec.cjs",
    "test_*.py", "test-*.py", "*_test.py",
]
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "release", "out"}

fails = []


def looks_like_a_test(path: pathlib.Path) -> bool:
    return any(fnmatch.fnmatch(path.name, pat) for pat in TEST_PATTERNS)


def test_files_on_disk():
    found = []
    for p in ROOT.rglob("*"):
        if not p.is_file() or not looks_like_a_test(p):
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(ROOT).parts):
            continue
        found.append(p.relative_to(ROOT).as_posix())
    return sorted(found)


def run_commands(text: str) -> str:
    """Only the lines CI actually EXECUTES — the contents of `run:` steps, shell comments stripped.

    Scanning the whole workflow was wrong in a way that defeated the entire guard, and it was caught by
    testing that this file fails when it should: a YAML comment in the workflow mentioning `tests/test_*.py`
    counted as an invocation, so deleting the step that ran the Python suite left this green. A comment
    describes intent. Only `run:` is evidence.
    """
    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        m = re.match(r"^(\s*)-?\s*run:\s*(\|-?|>-?)?\s*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        indent, block, inline = len(m.group(1)), m.group(2), m.group(3)
        if block:  # a `run: |` literal block — take the lines indented under it
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= indent:
                    break
                out.append(nxt)
                i += 1
            continue
        if inline:
            out.append(inline)
        i += 1
    return "\n".join(re.sub(r"#.*$", "", line) for line in out)


def workflow_patterns(text: str):
    """Path-like tokens the workflow invokes — globs kept as globs, so desktop/*.test.js covers new files."""
    return set(re.findall(r"[A-Za-z0-9_./*-]+\.(?:js|mjs|cjs|py)", text))


def playwright_patterns(text: str):
    """`npx playwright test` names no paths — its scope comes from playwright.config.mjs testDir."""
    if "playwright test" not in text:
        return set()
    cfg = (ROOT / "playwright.config.mjs")
    if not cfg.exists():
        return set()
    m = re.search(r"testDir:\s*['\"]([^'\"]+)['\"]", cfg.read_text())
    if not m:
        return set()
    d = m.group(1).lstrip("./").rstrip("/")
    # playwright's default testMatch is **/*.@(spec|test).?(c|m)[jt]s. Both depths are needed: fnmatch
    # requires a literal separator for the `**/` segment, so that form alone misses a spec sitting directly
    # in testDir — which is where this repo's only one lives. Getting that wrong reported a covered file as
    # uncovered; harmless here because the guard fails loudly, which is the whole design.
    out = set()
    for ext in ("spec.mjs", "spec.js", "test.mjs", "test.js"):
        out.add(f"{d}/*.{ext}")
        out.add(f"{d}/**/*.{ext}")
    return out


def covered(rel_path: str, patterns) -> bool:
    for pat in patterns:
        if fnmatch.fnmatch(rel_path, pat) or rel_path == pat:
            return True
        # a bare `foo/*.test.js` should not match `foo/bar/baz.test.js`, which fnmatch would allow;
        # but `**` patterns from playwright legitimately cross directories.
    return False


if not WORKFLOW.exists():
    print("FAIL: cannot find", WORKFLOW)
    sys.exit(1)

raw = WORKFLOW.read_text()
text = run_commands(raw)   # executed lines only — comments are not invocations
patterns = workflow_patterns(text) | playwright_patterns(text)
on_disk = test_files_on_disk()

print(f"{len(on_disk)} test file(s) on disk; {len(patterns)} path pattern(s) invoked by the release workflow\n")

uncovered = []
for rel in on_disk:
    ok = covered(rel, patterns)
    print(f"  {'✓' if ok else '✗'} {rel}")
    if not ok:
        uncovered.append(rel)

if uncovered:
    fails.append(
        "these test files exist but NOTHING in .github/workflows/release.yml runs them:\n    - "
        + "\n    - ".join(uncovered)
        + "\n  Add them to a job (the `unit` job runs both the JS and Python suites), or delete them."
    )

# The guard must also notice the wiring being REMOVED, not just new files appearing unwired. These are the
# invocations today's coverage depends on; if one disappears, whole suites go quiet and every file above
# would still report as covered by whatever remains.
REQUIRED_INVOCATIONS = [
    ("node --test", "the JS suites (desktop/*.test.js web/*.test.js)"),
    ("tests/test_*.py", "the Python suite under tests/"),
    ("playwright test", "the dashboard snapshot suite"),
]
print()
for needle, what in REQUIRED_INVOCATIONS:
    ok = needle in text
    print(f"  {'✓' if ok else '✗'} workflow still invokes {what}")
    if not ok:
        fails.append(f"the release workflow no longer contains '{needle}' — {what} is not running")

# And this file is worthless if IT does not run.
print()
me = pathlib.Path(__file__).resolve().relative_to(ROOT).as_posix()
ok = covered(me, patterns)
print(f"  {'✓' if ok else '✗'} this guard itself is run by CI ({me})")
if not ok:
    fails.append("this guard is not invoked by the release workflow, so it guards nothing")

print()
if fails:
    for f in fails:
        print("FAIL:", f)
    sys.exit(1)
print("every test file in the tree is invoked by the release workflow.")
