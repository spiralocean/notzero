# Improvements — known gaps, ranked

Work identified but not done, with enough context to pick up cold. Recorded 2026-07-26, after a session that
found four defects in the win path (see `## Already covered` for what's now protected, so nobody redoes it).

Ordered by leverage, not by size.

---

## ~~1. The test suites don't run in CI~~ — DONE 2026-07-26

Two jobs added to `release.yml`, and `release` now `needs: [verify-core, dashboard, win-path]`, so nothing
publishes unless both are green. The pixel-snapshot tests skip themselves under `CI` (committed per-platform
as `…-darwin.png`; a Linux runner looks for `…-linux.png` and fails every time) — 20 behavioural tests run,
5 pixel tests stay local. Original note below, kept for the reasoning.

<details><summary>original</summary>

### The test suites don't run in CI

**The 25 Playwright dashboard tests never execute in the release workflow.** `.github/workflows/release.yml`
runs `verify-core`, the platform builds, the asar-require gate and the launch smoke test — and nothing else. So
every dashboard test in `tests/dashboard.spec.mjs` only runs when someone types `npx playwright test`. A
regression ships green.

This is why two layout bugs reached releases in one day (the 0.1.64 overlap, the 0.1.68 squashed charts): the
tests that would have caught the second one were written *after*, and even those don't run automatically.

The three consensus gates (`test_check_win`, `test_payout_script`, `test_coinbase_height`) **are** wired in,
because `build-engines.sh` runs them and CI runs that. Only the dashboard suite is unprotected.

Fix: a step in the release job (or a separate push workflow) running `npm ci && npx playwright install --with-deps
chromium && npx playwright test`. Cheap. Note the suite needs the local static server the Playwright config
already starts.

**Watch out:** `celebration › win celebration (preview)` is flaky — it failed and passed on retry twice in one
day. Wiring the suite into CI without fixing that buys a workflow that fails at random, which trains everyone
to ignore it. Fix or delete that test as part of this.

</details>

---

## ~~2. A block containing real transactions has never been accepted~~ — DONE 2026-07-27

The harness now refills the mempool before **every** attempt with three transactions — one spending a P2PKH
coinbase (no witness, txid == wtxid) and two spending bech32 coinbases (witness, txid != wtxid) — and asserts
the won block carried them, that the mix is present, and that the coinbase holds the segwit commitment. The
node accepting the block is the proof: it recomputed both merkle trees from our bytes and agreed.

Two things worth keeping in mind if this is ever reworked:

- **The refill has to be inside the attempt loop.** A losing attempt ends with `generatetoaddress`, which
  confirms the mempool away — filling once at the top would leave whichever attempt actually *wins* building
  on an empty template again, which is the exact gap this closed.
- **The P2PKH coinbases live in their own wallet.** Held alongside the bech32 ones they are just the oldest
  coins in the pot, so coin selection reaches for them first and every "segwit" send comes out legacy. The
  first run of this scored 0 segwit / 3 legacy for precisely that reason.

<details><summary>original</summary>

### A block containing real transactions has never been accepted

`scripts/test-win-regtest.py` mines blocks against a near-empty mempool, so the witness commitment and a
non-trivial merkle tree are only ever exercised by `verify-block.py`'s `getblocktemplate` **proposal** mode.
Proposal mode is a good check but it is not acceptance, and it explicitly skips proof-of-work.

Fix: fund the regtest wallet, create a handful of transactions (at least one segwit, one legacy) so the
template carries `default_witness_commitment` and several txids, then mine and submit as the harness already
does. ~15 lines. Closes the last correctness gap in block construction.

</details>

---

## ~~3. The regtest win harness doesn't run in CI~~ — DONE 2026-07-26

The `win-path` job fetches the pinned Core (version and sha256 read from `node-provision.js`'s exports — the
same pin the app verifies before running Core) and runs the harness on every release. Original note below.

<details><summary>original</summary>

### The regtest win harness doesn't run in CI

`scripts/test-win-regtest.py` is the deepest test in the repo — it found `check_win`'s byte order, the BIP34
coinbase height sign byte, the P2P false-negative, and proved the rescue path terminates. It runs only when
invoked by hand.

Fix: have CI fetch the pinned Bitcoin Core (the same tarball `node-provision.js` verifies) and run the harness
before publishing. ~90s per release. Heavier than the others; also the most durable, since this is the code
path the product exists for.

</details>

---

## ~~4. The Windows process sampler has never executed~~ — DONE 2026-07-27

It works. `tests/test_process_sampler.py` spawns processes named `miner.exe` and `bitcoind.exe` and requires
the sampler to find both; the `win-sampler` job runs it on `windows-latest` and gates `release`. First run on
a real Windows runner: 2 rows returned, both roles matched at 57.7 MB. The PowerShell branch was correct — but
that was luck, not knowledge, since nothing had ever run it.

Notes for anyone extending it:

- **Matching differs per platform, so a fake process has to be built differently to be seen at all.** Windows
  matches on `ProcessName`, which comes from the executable's *filename* and ignores argv — hence real
  `miner.exe` files, copied next to `python.exe` so its DLLs resolve.
- **POSIX gets a parser shape check, not fakes, and that is deliberate.** Linux `ps` reads
  `/proc/pid/cmdline` so an argv[0] override works, but macOS `ps` reports the real exec path and the override
  is invisible. An early draft "passed" on macOS purely because a real notzero install was running — it was
  measuring the live app, not its own fakes.
- It is a **separate job**, not a step inside the Windows build: that matrix is `fail-fast: false`, so a
  failure there would let mac and Linux publish a version Windows never shipped.

<details><summary>original</summary>

### The Windows process sampler has never executed

`_sample_processes()` in `scripts/node_bridge.py` has a PowerShell branch for Windows written blind. CI only
ever *compiles* the bridge through PyInstaller; it never runs it. So that code has executed on no machine
anywhere.

Downside is bounded — on failure it returns `[]` and the CPU/RAM readout is simply absent, which is where
Windows already was. But it is untested code shipping to users.

Fix: a CI step on `windows-latest` that runs the bridge for a few seconds and asserts `node.json` parses with a
plausible `miner_proc`. Would also have caught the psutil-never-installed bug, which shipped dead for weeks.

</details>

---

## ~~5. An update landing while the what's-new dialog is open~~ — DONE 2026-07-27

The install now waits for the dialog to be dismissed instead of quitting out from under it, and the
"restarting in a moment" notification and overlay moved behind the same gate — showing those while the app
cannot in fact restart was the visible half of the bug. Policy is in `desktop/install-gate.js` (7 tests,
injected timers) because `main.js` needs a live Electron app to run and that module needs nothing.

**This removed the possibility; it did not reproduce the failure.** Nobody has seen the hang on a real
machine. If you ever want to confirm the original behaviour, it needs a packaged build, the recap open, and a
release landing in the same window.

Two decisions worth not re-litigating:

- **No cap that installs anyway after N minutes.** It would reintroduce the same hang on a slower timer. An
  un-dismissed dialog leaving the app on the old version is the same outcome as pressing "Later".
- **A throwing `isBusy` installs rather than stalls** — a wedged updater is the thing being prevented, so an
  unanswerable predicate must not be able to wedge it permanently.

To answer the question that raised it: the "Got it" button gates nothing. It belongs to the recap shown AFTER
an update installs; a user who never clicks it still receives every subsequent release.

---

## 6. Not code

- **Cloudflare cache rules** for `dl.getnotzero.com`. Five rules, and the ORDER matters: `.ots` must precede
  `SHA256SUMS` or pending proofs freeze at the edge for a year — `.ots` files are NOT immutable,
  `upgrade-timestamps.yml` rewrites them every 6h until they land in a block. Lower priority now that the
  0.1.63 proof cache removed most of the traffic they would have absorbed. Full rule list is in the session
  history; re-derive before applying.
- **`site/index.html` says "About 20 GB"** on the REVERSIBLE card. Accurate for what's stored, and deliberately
  left — the ~750 GB download is disclosed in the wizard, which is before any of it is spent.

---

## The mainnet block-validity gate is NOT in CI — it is scheduled locally

`scripts/verify-block.py` asks a real node, through `getblocktemplate` proposal mode, whether the exact block
this miner assembles is one bitcoind would accept. It is the strongest evidence a found block would land, and
CI cannot run it: GitHub runners have no synced node, so every release since 0.1.69 built with
`SKIP_BLOCK_VERIFY=1`. It ran only when someone typed the command.

`scripts/verify-block-scheduled.sh` now runs it weekly via a launchd agent (`--install` / `--remove`), logging
to `verify-block.log` and writing `verify-block-status.json` beside the app's data. It distinguishes **fail**
from **skipped** — a node that is down or syncing is not a defect in the block builder, and a month of "could
not check" must never read as a month of "verified". A failure raises a macOS notification, because a silent
failure is the same as not running.

Still true, and worth knowing: this runs on ONE machine. If that machine's node is down for a month, nothing
is checking. A second scheduled runner elsewhere would fix that.

## Already covered — don't redo these

| Property | Where | Gated? |
|---|---|---|
| A winning hash is recognised (consensus byte order) — at 2009 AND current difficulty | `tests/test_check_win.py` | yes, every build |
| The payout address derives the right script | `tests/test_payout_script.py` | yes, every build |
| BIP34 coinbase height is a valid CScriptNum | `tests/test_coinbase_height.py` | yes, every build |
| The built block would be accepted (PoW aside) | `scripts/verify-block.py` | weekly on a local node, NOT in CI |
| A real block is submitted and accepted | `scripts/test-win-regtest.py` | yes, every release |
| …carrying real transactions, segwit **and** legacy, with a live witness commitment | same | yes, every release |
| The block survives to disk before submitting | same | yes, every release |
| Rescue resubmits **and stops** (no infinite retry) | same | yes, every release |
| Direct P2P delivery to a disconnected peer | same | yes, every release |
| Settles at 6 confirmations, matures at 100 | same | yes, every release |
| The Windows process sampler runs and finds both processes | `tests/test_process_sampler.py` | yes, every release |
| An update waits for an open dialog instead of quitting under it | `desktop/install-gate.test.js` | yes, every release |
| The OTS proof parser and its node check | `desktop/ots-verify.test.js` | yes, every release |

Three offline gates need no node and have no opt-out: a miner that cannot recognise a win, derives the wrong
payout script, or encodes the height wrongly cannot be packaged.

---

## Useful while working on this

- `bash scripts/preview-dashboard.sh` — the dashboard you're editing, against your real node's data. The
  packaged app only ever runs the last release, and `web/node.json` is a fixture predating half the fields, so
  without this the only way to see a dashboard change was to cut a version.
- `python3 scripts/test-win-regtest.py` — full win path on a private chain, ~2 minutes.
- `node scripts/stats.mjs` — downloads and installs, no auth needed.
