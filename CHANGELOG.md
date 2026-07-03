# Changelog

Notable changes per release. All platforms ship from a unified `main` and publish the **same version**
(mac → Windows → Linux; see `DEPLOY.md`). When cutting a release, move **Unreleased** down under the new
version number and bump `desktop/package.json`.

## Unreleased — next: 0.1.23

_Nothing yet._

## 0.1.22

**Dashboard — a "how a hash works" explainer, plus fixes**
- **INSIDE THE HASH** — type anything and watch what a computer actually does to turn it into a 256-bit hash:
  your text → bits → padded 512-bit block → 64 rounds of mixing (the whole state scrambles) → the hash.
- **BIT OPERATIONS** and **ONE ROUND** — readable, labeled panels with worked examples; the four bit ops are
  boxed so they don't read as a pipeline, and ONE ROUND shows the round's registers and math on real values.
- **YOUR TICKETS** — cap the graph at ~100 blocks so long sleep gaps don't stretch it endlessly (a longer
  record is still kept on disk), and **hover tooltips** on the ticket bars + the odds-map "you" marker.
- **Fixed the "not submitting" false alarm** — a genuinely slow block no longer trips the warning; it only
  fires when your ticket is actually stale relative to the chain tip advancing.

**Miner**
- Grow the stored ticket record (→ 1000) so the closeness / odds-map cloud is seeded richer.

## 0.1.21

**App — don't let the managed node fill the disk**
- **Delete the assumeutxo snapshot file after loading it.** The ~9.8 GB `utxo-<height>.dat` is read exactly
  once by `loadtxoutset`; it was being left behind forever. On one shared box that dead weight (plus
  assumeutxo's temporary dual chainstate) filled the disk to 100% and crashed the node. Now deleted right
  after a successful load, and any leftover is swept on the next start (fixes existing installs on update).
- **Disk-space guard.** Skip the ~10 GB snapshot download if there isn't ≥14 GB free (fall back to normal IBD
  instead of filling the disk), and if free space ever drops below ~2 GB while running, **pause the node
  cleanly** with a clear message rather than letting bitcoind hit 100% — a full disk can corrupt the
  chainstate and take down everything else on the machine. A paused node just needs space freed + a restart.

## 0.1.20

**App**
- **Node startup no longer fails on a slow restart.** Reloading the block index + mempool + resuming
  assumeutxo validation after an update can take minutes; the wait went from 90s to 300s and now shows elapsed
  time instead of freezing on "Starting…" then failing.
- **No more "Cannot obtain a lock … already running."** A retry could launch a second bitcoind over the
  first's datadir lock — the app now stops any leftover bitcoind (and waits for the lock to release) before
  every launch.
- **Safer node-error dialog:** "Try again" is now the primary, auto-focused button; the destructive "Remove &
  start over" (which wipes the node and re-syncs) is demoted to a quiet secondary.

**Dashboard — learn how hashing works**
- **INSIDE THE HASH** — a live, from-scratch SHA-256 shown as a 4-stage pipeline (your typed message → bits →
  padded 512-bit block → 64 rounds churning the 8 registers → the hash). Type anything and watch it re-hash.
- **ONE ROUND** — the exact fixed recipe every round runs (Σ0/Σ1, Ch, Maj, +K +W → the two new registers).
- **BIT OPERATIONS** — the four atomic ops (rotate, XOR, AND, add) on 32-bit words.
- Message-bits view wraps to multiple rows (see more without shrinking the squares); the padding stage is
  labeled as the fixed, non-random recipe it is.
- **Odds map** flags the luckiest recent network winner ("beat target by +N bits") when it lands visibly past
  the target line.

## 0.1.19

**App**
- **Fixed mining stalling on 0.1.18 (all platforms).** The CI-built miner shipped without a CA-certificate
  bundle, so its `mempool.space` calls failed SSL verification ("unable to get local issuer certificate") and
  the poll loop stalled before submitting — the pill showed "not submitting · last ticket …h ago." The miner
  now uses `certifi` for its trust store (bundled by PyInstaller), and the release workflow installs `certifi`
  so every build includes it.

**Dashboard**
- The footer no longer claims "LIVE solo mining" when the miner is synced but hasn't submitted a ticket in
  over 20 minutes — it shows "miner not submitting (last ticket …)" instead, matching the top status pill.

## 0.1.18

**Dashboard**
- **No more "jumping" when the node briefly falls behind.** The mining panels now only collapse during the
  *initial* sync; after the node has caught up once, a transient desync (sleep / chainstate flush) keeps every
  panel in place and the sync panel shows "catching up" inline — no reflow.
- **YOUR TICKETS shows downtime gaps as real empty space.** The timeline now places one slot per block height,
  so missed blocks render as actual gaps instead of a compressed "⋯N" marker; participation markers appear only
  at heights where a ticket was entered.
- **Fixed an overlapping label in the sync panel** — the "assembling" text no longer runs into "network mining"
  (most visible on Windows, with its wider fonts).

## 0.1.17

**App**
- **Fixed the dashboard "blinking" after an in-place update.** An old engine process orphaned by the update
  kept writing `node.json` (without the new fields), fighting the new bridge. Now the bridge claims a
  single-writer **lockfile** (a superseded instance exits), and the app **reaps stale engine processes** on
  startup — so exactly one bridge writes `node.json`.
- **"Caught up" no longer flaps to "not connected" during post-sync flushes.** An RPC **timeout** (node alive
  but busy, e.g. a chainstate flush on a slower disk / Intel Mac) was treated like the node being down. It's
  now distinguished from a real connection refusal, and the last-good "synced" state is held through the flush.

**Dashboard**
- **YOUR TICKETS now separates participation from performance.** A consistent **ticket marker** under each bar
  means "a ticket was entered" (so a weak `z=0` hash is never mistaken for a gap); the **bar** is purely hash
  strength. Marker colour shows submit state: amber = normal, green ★ = won & accepted, **red ⚠ = won but
  `submitblock` failed** (saved for manual resubmit) — the one case where "not submitted" critically matters.
- **A "caught up — now mining" moment** when sync completes, instead of the dashboard silently reflowing and
  jumping to the top.

## 0.1.16

**App**
- **"New best" notifications now speak in bits, not just whole leading-"0"s.** The miner takes one attempt
  per block, so your best creeps up bit by bit over days; the alert now fires on each zero-bit gained and
  reads like the dashboard gauge — *"Your closest hash yet: 1 leading "0" (+3/4 toward the next)."* Still
  gated by the **Show notifications** toggle; stays quiet below the first whole "0".
- **Fixed phantom "new best" alerts.** When the node went unreachable past the bridge's grace window
  (typically laptop sleep/wake), `node.json` arrives with no miner data and the notifier read the missing
  best as 0 — then re-fired "new best" the instant the real value reappeared. It now only advances the
  baseline when real miner data is present (`best` is monotonic upstream, so this is safe).

**Dashboard**
- **Nibble gauge under the best hash** — four dots beneath the first non-zero hex char show bit-level
  progress toward the next leading "0" (`zero_bits % 4` filled), the resolution that whole-"0" counts hide.
  The best row also spells it out: *"1 zero · 7 bits (+3/4 to next)."* The closeness panel grew slightly to
  make room below the gauge.

## 0.1.15

**App**
- Status pill: moved up so it no longer overlaps the title; and when the node is synced but there's no
  ticket timestamp yet (e.g. just after an update), it shows "submitting · mining the current block"
  instead of a misleading "not submitting · last ticket —".
- Settings: a **Show notifications** toggle (master on/off for all mining notifications).
- Notifications: **debounce node sync changes** — a brief drop/recover no longer notifies; the
  "out of sync" / "synced" notice only fires once the new state has held ~5 min (a blip that recovers
  within a block doesn't threaten one hash per block).

## 0.1.14

**App**
- **Mining notifications** — native OS notifications for the events that matter, fired from the main
  process so they arrive even when the window is closed: 🎯 block won (confirmed), 📈 new leading-"0"
  milestone, ✅ node synced / ⚠️ node catching up. Each gated by its existing `notify_*` setting (these
  were config-only leftovers from the legacy Swift app — now actually wired up).
- **Auto-start on login** — the app now registers a per-user login item so mining resumes after a reboot.
  It launches into the tray (mining starts headless; open the window from the tray). **Off via a new
  Settings toggle** ("Start automatically when I log in").
- **"Submitting tickets" status pill** at the top of the dashboard — 🟢 submitting (with a *last ticket Xm
  ago* timer) · 🟡 getting ready (syncing %) · 🔴 not submitting (stalled or node offline). No more wondering
  whether it's actually working.
- **Intel Mac fan** — the managed node now caps script-verification threads (`par=2`) on Intel Macs so the
  one-time assumeutxo background validation stays cool and quiet.

**Website**
- Don't show the "signed & notarized by Apple" line to **Windows/Linux** visitors — only the Mac build is
  notarized (Windows/Linux ship unsigned, no paid cert).
- **Downloads counter** is hidden until it reaches **500** — a low count reads as anti-social-proof.

**Build / infra**
- Windows + Linux release scripts (`release-win.ps1`, `release-linux.sh`) with versioned, cacheable
  installer artifacts + stable website aliases (mirrors `release-mac.sh`).

## 0.1.13
- Fix the confusing "new best" toast — consistent units (leading-"0" count vs. zero-bits no longer mixed).

## 0.1.12
- Cap dashboard render CPU (30 fps, throttle when unfocused) and add a **motion: off** mode — fixes the
  high CPU / fan on Intel Macs.

---

[a **spiralocean** project](https://spiralocean.com)
