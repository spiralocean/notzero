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

## 2. A block containing real transactions has never been accepted

`scripts/test-win-regtest.py` mines blocks against a near-empty mempool, so the witness commitment and a
non-trivial merkle tree are only ever exercised by `verify-block.py`'s `getblocktemplate` **proposal** mode.
Proposal mode is a good check but it is not acceptance, and it explicitly skips proof-of-work.

Fix: fund the regtest wallet, create a handful of transactions (at least one segwit, one legacy) so the
template carries `default_witness_commitment` and several txids, then mine and submit as the harness already
does. ~15 lines. Closes the last correctness gap in block construction.

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

## 4. The Windows process sampler has never executed

`_sample_processes()` in `scripts/node_bridge.py` has a PowerShell branch for Windows written blind. CI only
ever *compiles* the bridge through PyInstaller; it never runs it. So that code has executed on no machine
anywhere.

Downside is bounded — on failure it returns `[]` and the CPU/RAM readout is simply absent, which is where
Windows already was. But it is untested code shipping to users.

Fix: a CI step on `windows-latest` that runs the bridge for a few seconds and asserts `node.json` parses with a
plausible `miner_proc`. Would also have caught the psutil-never-installed bug, which shipped dead for weeks.

---

## 5. An update landing while the what's-new dialog is open

With auto-update on, `update-downloaded` calls `quitAndInstall()` six seconds later regardless of what is on
screen. The what's-new recap (`whatsNewDialog`) is shown parented to the window when one exists, which on
macOS makes it a window-modal sheet. Quitting and relaunching with that sheet open is untested — and it is the
same shape as the 0.1.33→0.1.34 stall, where `quitAndInstall` hung because the window hid instead of closing.

Narrow: the dialog has to sit open for the ~2h until the next check, and a release has to land in that window.
The failure would look like an update that hangs. Untested rather than known-broken.

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

## Already covered — don't redo these

| Property | Where | Gated? |
|---|---|---|
| A winning hash is recognised (consensus byte order) | `tests/test_check_win.py` | yes, every build |
| The payout address derives the right script | `tests/test_payout_script.py` | yes, every build |
| BIP34 coinbase height is a valid CScriptNum | `tests/test_coinbase_height.py` | yes, every build |
| The built block would be accepted (PoW aside) | `scripts/verify-block.py` | yes, when a node is reachable |
| A real block is submitted and accepted | `scripts/test-win-regtest.py` | manual |
| The block survives to disk before submitting | same | manual |
| Rescue resubmits **and stops** (no infinite retry) | same | manual |
| Direct P2P delivery to a disconnected peer | same | manual |
| Settles at 6 confirmations, matures at 100 | same | manual |

Three offline gates need no node and have no opt-out: a miner that cannot recognise a win, derives the wrong
payout script, or encodes the height wrongly cannot be packaged.

---

## Useful while working on this

- `bash scripts/preview-dashboard.sh` — the dashboard you're editing, against your real node's data. The
  packaged app only ever runs the last release, and `web/node.json` is a fixture predating half the fields, so
  without this the only way to see a dashboard change was to cut a version.
- `python3 scripts/test-win-regtest.py` — full win path on a private chain, ~2 minutes.
- `node scripts/stats.mjs` — downloads and installs, no auth needed.
