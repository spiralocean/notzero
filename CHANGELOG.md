# Changelog

Notable changes per release. All platforms ship from a unified `main` and publish the **same version**
(mac → Windows → Linux; see `DEPLOY.md`). When cutting a release, move **Unreleased** down under the new
version number and bump `desktop/package.json`.

## Unreleased — next: 0.1.60

**Dashboard**
- **If you run your own node, the dashboard leans on it instead of the public API.** The current block — the one
  the NEXT BLOCK, VERIFY, and your-ticket panels are built from — now comes straight from your synced node
  (which already knows it) rather than being fetched from mempool.space every 30 seconds. That's two fewer
  public-API calls per cycle, and the block actually updates *faster* (your node is checked every few seconds).
  The public demo, and a node that's still syncing, still use mempool.space as before. A bonus: with your node
  supplying the block, a mempool.space outage no longer even shows a notice — your dashboard just keeps working.
- **Only fetches the busy mempool data when you're actually looking at it.** The mempool detail — the projected
  blocks, the fee weather, the live transaction feed — is drawn only inside the MEMPOOL panel, so when that
  panel is collapsed the dashboard no longer keeps pulling it from the public mempool.space API every 30 seconds.
  If you run your own node, the "N pending" count comes straight from it, so a collapsed panel makes no external
  calls at all. Opening the panel loads everything on demand. (Together with the earlier change, a node user
  with the panel closed now makes only a couple of API calls per cycle instead of ten.)

**Desktop**
- **Clear path to fully uninstall.** Settings now has an "Uninstall notzero completely" note next to "Remove node
  & all data", spelling out the two steps to get back to before you installed — remove the node + data, then quit
  and remove the app the normal way for your system (drag to the Trash on macOS, Settings → Apps on Windows,
  delete the AppImage on Linux). Previously "Remove node & all data" left you at the first-run screen with the app
  still installed, which isn't the same as uninstalling.
- **Clearer status while your node is setting up.** During the initial blockchain sync the bottom of the screen
  used to read "practice mode — set up a node," which was both wrong (the app is setting one up for you) and
  overlapped the disk-usage readout. It now shows the real sync status ("syncing blockchain — NN%"), and the
  duplicate line that caused the overlap is gone until the node is ready.

## 0.1.59

**Node**
- **New nodes reach the point where they can mine much faster.** notzero's managed node fast-starts from a
  verified UTXO snapshot; that snapshot moved from block 880,000 to 935,000 — 55,000 blocks closer to the tip.
  For someone setting up for the first time that's roughly **8 hours instead of 25, and ~41 GB of block data
  instead of ~134** before mining begins (and the snapshot file itself is a touch smaller too). No change for
  anyone already set up. Existing installs on older versions keep working — the previous snapshot stays hosted.

**Dashboard**
- **Gentler on the public mempool.space API when it's under strain.** If mempool.space starts rate-limiting or
  erroring, the dashboard now backs off — waiting well beyond its normal 30-second cadence, and honouring the
  server's own "try again in N seconds" — instead of retrying every few seconds. (A regression from 0.1.58's
  faster-recovery change, which correctly sped up retries for a dropped connection but wrongly applied the same
  speed-up when the server was explicitly asking for less.) A genuinely unreachable host still recovers fast.
- **Lighter touch on the public mempool.space API.** Slow-moving figures — the bitcoin price, the 3-day average
  hashrate, and the next-difficulty estimate — were being refetched every 30 seconds even though they barely
  change minute to minute. They now update on the existing 5-minute cycle instead, cutting roughly a quarter of
  the requests the dashboard makes while it's open, with no visible difference. Live data (the chain tip and the
  mempool) still refreshes every 30 seconds.
- **The tagline sits properly under the title now.** The line under "₿ITCOIN LOTTERY" was close enough to touch
  the title's descenders; it now has room to breathe, with the quote below it moving down to match.

## 0.1.58

**Node**
- **Your node now runs Bitcoin Core 31.1.** A maintenance release from the Bitcoin Core project — bug and security
  fixes on top of 31.0, no new behaviour. If notzero manages your node, it picks up the new node software by itself
  the next time it starts: **your blockchain data is untouched and nothing re-syncs**, so it costs one short
  download and you carry on mining. Every downloaded copy is checked against a hash pinned inside the signed app,
  so a tampered or corrupted download is refused rather than run.
- **You can now see which Bitcoin Core you're running.** Settings and the NETWORK panel show your node's version —
  and it's read from the node itself, not from whatever notzero ships, so it's right whether the app manages your
  node or you connected your own. If you run your own node, that's the difference between assuming you're current
  and knowing it. Nothing in the app showed this before.

**Dashboard**
- **A dropped connection no longer blanks the whole app.** If mempool.space couldn't be reached — a wifi blip, or a
  laptop waking from sleep — the dashboard replaced *every* panel with a single error line, including the panels
  that never needed that site at all (your node, your ticket, the SHA-256 walkthroughs). Now the dashboard stays
  up: panels keep their last known values, and the outage is reported as a small notice in the top-left corner
  that also tells you how old the chain data is.
- **Faster recovery after sleep or a wifi drop.** While offline the app retries every few seconds instead of waiting
  out its 30-second cycle, and it refetches immediately when the network comes back or when the machine wakes —
  so opening the lid no longer leaves stale numbers (or a stale error) sitting on screen.

## 0.1.57

**Linux**
- **No more old copies piling up after updates.** On Linux, each in-place auto-update could leave the previous
  version's background process running — over many updates these idle leftovers accumulated and tripped Ubuntu's
  "obsolete binaries / relogin required" notice. On startup notzero now cleans up any leftover process from a
  prior version (identified precisely by its replaced binary — never the running app, node, or miner), so exactly
  one copy runs and the notice stays clear.

## 0.1.56

**Ambient view**
- **The heat now belongs to the block, not the whole screen.** Instead of the entire sea changing color as a block
  approaches, only the gathered sphere — the block being built — warms toward ember. The surrounding sea stays a
  calm cool blue, so the color actually means something and the forming block becomes the focal point.
- **Warmth bleeds into the nearby sea.** Transactions closest to the sphere pick up its warmth and fade back to
  cool as they drift into the deep — so a sprite gently warms as it nears the block and cools as it moves away,
  rather than the sea being uniformly cold.

**Dashboard**
- **The version no longer hides behind the ambient button.** The status line's version now clears the round
  ambient-view button in the bottom-right corner instead of sitting underneath it.

## 0.1.55

**Ambient view**
- **The sea changes color gently now.** As a block ages the swarm warms from cool blue toward ember, and after a
  block it eases back to cool. That shift used to happen in hard steps that recolored the whole field at once —
  now it glides through a continuous range, and it eases (instead of snapping) when a new block resets it.
- **Each transaction warms on its own schedule.** Rather than the whole field turning color in unison, every sprite
  now shifts at a slightly different time — some quicker, some slower — so the change ripples across the sea as a
  natural scatter instead of a single flip.

## 0.1.54

**Ambient view**
- **Captured transactions no longer dim.** A transaction pulled into the sphere used to draw at about half the
  brightness of the surrounding sea, so it visibly darkened the moment it was caught. Captured sprites now hold the
  sea's brightness, so they stay bright through the gather instead of fading as they join.

## 0.1.53

**Updates**
- **"Update Now" reacts instantly.** After choosing "Update Now," the dashboard used to sit still for up to a minute
  before the download status appeared — it only noticed once its next background refresh came around. Now the app
  pushes the status through immediately: the pill flips to **"Preparing update…"** the moment you press the button,
  then to **"Downloading update… X%"** once the download is underway. No more wondering whether the click registered.

## 0.1.52

**Node**
- **Your node now warns you if the network changes rules under it.** If Bitcoin Core detects that an unknown
  consensus rule has **locked in or activated** — a soft fork your current version doesn't understand — the
  dashboard shows a **"Network rule change detected"** banner and you get a one-time notification, so you know to
  update rather than silently mining under outdated rules. It reads Core's own signal (no per-proposal logic), and
  it deliberately ignores mere miner *signaling* that may never activate — it only speaks up on a real lock-in/
  activation. On desktop, clicking the banner checks for an update.

## 0.1.51

**Ambient view**
- **The deep feels alive and has depth now.** Overall brightness is up a notch, and the sea has real depth: near
  transactions sit steady and bright while far ones recede and slowly **breathe in and out of the dark**, so the water
  reads as deep rather than flat.
- **The sea stays populated when a block is found.** About **45% of the sea is now permanent background** that never
  gets pulled into a block, so the deep no longer empties out the moment a block forms.
- **Blocks form organically.** Instead of the whole sea flipping into the sphere on a single frame, the swarm now
  **streams in gradually** over the gather — you watch transactions join the block rather than blink into it.
- **Transactions resurface naturally.** After the sealed block sinks, fresh transactions return from **both the sides
  and the depths**, fading in on a slow, wide, randomized stagger — no more horizontal line of sprites popping in at
  the bottom.

## 0.1.50

**Updates**
- **The update now shows it's working.** After you choose "Update Now" (or click the update pill), the download used to
  be silent — the dialog closed and the pill just sat there, so it looked like nothing was happening and you might
  click it again. Now the pill turns into a live **"Downloading update… X%"** status with a progress fill, and it's
  **not clickable while downloading** so a stray click can't re-trigger it. It still installs and restarts
  automatically when the download finishes.

**Ambient view**
- **Reworked the block-found sequence.** When a block is found, the gathered transactions now *fuse* — their motion
  leaves persistent tails that build up and fill the sphere into a solid coin — then it locks and sinks: a smooth,
  eased descent (no jerk at the lock), travelling deeper and dimming as one solid disc as it recedes into the deep,
  rather than shrinking to a dot or thinning into gaps. The fill is soft-edged so nothing lingers as a halo when it
  collapses.

**Ambient view**
- **The OS's own screensaver no longer takes over the ambient view.** While the ambient view is showing, the app now
  tells the system the display is in use (`prevent-display-sleep`), so macOS's screensaver / display-sleep won't fire
  on top of it. Released the moment the view is dismissed. (Trade-off: the display won't auto-sleep while the ambient
  view is up — it *is* the screen activity.)

**Ambient view**
- **Removed the full-screen ambient glow — the "halo" is gone for good.** A soft screen-spanning glow (whether a
  gradient or a sprite) always bands into a ring and tints the corners on 8-bit panels, no matter how it's dithered.
  So it's gone: all light and color now come from the swarm's own localized sprites, and the black between them stays
  truly black on every display.
- **The background no longer shifts temperature with the swarm.** The trail-fade was tinting the whole abyss toward the
  swarm color as pressure built; now it's pure abyss, so only the sprites carry the cold→warm shift.

**Linux**
- **Fixed auto-start on Linux — it never actually worked.** The app relied on Electron's `setLoginItemSettings`, which
  is a no-op on Linux, so it never registered itself to launch on login (a reboot or system update left it not
  running). It now writes a proper freedesktop autostart entry (`~/.config/autostart`), using the AppImage's stable
  path, so mining resumes on login. Turn it off with the existing auto-start setting.

**Ambient view**
- **Reworked the glow to fix the "halo" ring (and undo 0.1.45's washed-out blacks).** 0.1.45 tried to dither the glow
  with additive grain, which lifted the black floor. That's removed. The ambient glow is now fainter and more diffuse
  with a gentler falloff, so it no longer bands into a visible ring on 8-bit panels, and the deep stays deep.

## 0.1.45

**Ambient view**
- **Fixed a trap when the OS screensaver/lock engaged over the ambient view.** If macOS's own screensaver or password
  lock came on top of the (always-on-top, full-screen) ambient view, on unlock it could be left stuck — Esc didn't
  reach it and it blocked ⌘-Tab. Now the view dismisses itself on any OS lock/unlock/sleep/wake event (which fire
  reliably where window `blur` doesn't), tears the window down forcefully (drops always-on-top, destroys it), and a
  **global Esc** dismisses it even if it has lost keyboard focus. It can no longer strand you.
- **Fixed the "halo" ring around the sphere on some displays.** The soft ambient glow is a large, faint radial
  gradient, which banded into visible concentric rings on 8-bit panels (notably the Intel Mac and 150% Windows). A
  faint dither grain now breaks up the banding so the glow stays smooth.

**Reliability**
- **The miner now self-heals if it hangs.** Until now the app only restarted the miner engine if it fully *crashed*;
  a hung miner (alive but no longer submitting tickets) would sit stalled until you noticed the "not submitting"
  warning and restarted the app yourself. A watchdog now restarts the miner automatically if it's been silent for
  too long while your node is synced — the same staleness check the dashboard's liveness pill already uses.

## 0.1.43

**Ambient view**
- **Fixed the sphere drawing off-screen on Retina / HiDPI Macs (and the "bottom-right bias" on 150% Windows) — the
  real root cause.** A `<canvas>` is a *replaced element*, so with only `inset:0` it renders at its full-resolution
  bitmap size — 2× too big on a Retina display, 1.5× on 150% Windows — pushing the sphere off the bottom-right.
  Pinning the canvas's CSS size to the logical size fixes it on every display. (This is what all the recent
  window-sizing changes were chasing at the wrong layer.)
- **Full-screen restored.** With the canvas bug gone, the ambient view goes back to true full-screen — covering the
  menu bar / Dock / taskbar — and the sphere stays centred.

**Ambient view**
- **A block now always forms from a visible convergence, never a coin popping from nowhere.** When a block lands, the
  whole swarm is recruited and rushes inward to gather into the sphere for ~0.9s *before* it locks into the coin — so
  even a block found early (or right after the last one, when it's mostly open sea) shows the transactions coming
  together first.

**Dashboard**
- **"Verified Updates" no longer looks empty right after an update.** The release list used to wait for your node to
  finish booting before it populated — a couple of minutes staring at what looked like "nothing verified." Now it
  shows a clear **"Checking recent releases against your node…"** message while it works, and populates immediately
  from each release's published on-chain proof (upgrading to node-confirmed once your node is answering).

## 0.1.41

**Ambient view**
- **Really fixed the sphere off-screen on scaled displays.** The action-safe approach in 0.1.40 helped but didn't fully
  land (Windows recentred toward the bottom-right; the Intel Mac still clipped) because Electron's renderer mis-reports
  `window.screen` on those displays, so the view couldn't reliably detect the visible area. The ambient window now
  skips the fullscreen call entirely and is sized to the display's logical bounds (which the main process reports
  reliably) — a window that size simply cannot exceed the screen, so the sphere always centres. Trade-off on macOS:
  the menu bar (and Dock, unless auto-hidden) stay visible as a thin strip instead of full-screen immersion.
- **Fixed a block occasionally solidifying twice** (two spheres condensing into the coin at once). The node poller is
  `async` on a 4s timer; a slow fetch could let two polls overlap, both see the same new height, and land the block
  twice. Polls are now serialized (no overlap) and a duplicate height can never solidify the same block again.
- Added a **tray menu → "Ambient View (Debug Numbers)"** item that opens the view with an on-screen size readout —
  a one-click way to diagnose a display, no config editing.
- Added a **tray menu → "Ambient View (Immersive test)"** item — a candidate way to hide the menu bar / Dock without
  the fullscreen call that over-sized scaled displays (it raises the window level instead, which can't change the
  size). Opens with the size readout so the sizing can be confirmed; Esc, ⌘-Tab, and a 2-minute auto-close all exit.

## 0.1.40

**Ambient view**
- **Fixed the sphere going off-screen on scaled displays** (Intel Mac at a scaled resolution, Windows at 150%). On a
  scaled/HiDPI display, full-screen can hand the page a canvas *larger* than the visible screen — the drawing anchors
  top-left, so the excess spills off the bottom-right and the sphere lands off-frame. The view now borrows the analog-
  TV idea of an **"action-safe" area**: it pins its stage to the *visible* screen (`window.screen`), centres on that,
  and keeps the sphere within a safe inset — so it can never be drawn past the edges, on any display or aspect. The
  whole composition is also **scaled down** a touch to sit comfortably inside the frame. (Set `ambient.debug: true` in
  config for an on-screen size readout if you ever need to diagnose a display.)
- **Lock-on-wake no longer triggers a scary "wants to control System Events" prompt by default.** On macOS the lock
  now simply sleeps the display (which locks if your Mac requires a password after sleep) — no permission prompt. A
  new **"Force the lock screen"** option (off by default) uses the ⌃⌘Q shortcut for a guaranteed lock, and only that
  asks for the one-time macOS permission. Windows and Linux are unchanged — they lock cleanly with no prompt.

## 0.1.39

**Ambient view**
- **Fixed low-res/fuzzy rendering with the sphere off-screen on some displays** (notably the native screensaver at
  certain resolutions). A missing viewport tag let the canvas render at a smaller logical size than the display and
  scale up — bigger, blurry sprites and mis-placed geometry. Now it renders at the display's true size, and the
  "your attempt" cluster is clamped so a narrow/laptop aspect can't push it off-screen.
- **Sprites scale with the display** so the swarm holds a consistent apparent size, instead of looking oversized /
  chunky on low-resolution or scaled displays.

**Dashboard**
- **The "feel the odds" quote no longer conflates leading zeros with coin-flips.** A coin-flip is one hash *bit*;
  each leading zero in the hex you see is *four* bits, so "count the zeros" and "~79 flips" were off by 4×. Reworded
  to keep both layers straight: every heads is a bit, every four-in-a-row is one leading zero.

## 0.1.38

**Ambient view (new)**
- **An idle screensaver, driven by your own node.** After a few minutes idle, notzero can show a full-screen
  ambient view: **The Deep** — transactions rise from the mempool, gather into a block, and a coin (coloured by the
  real block hash your node just verified) sinks into the deep — or a **Matrix rain** of the live tip hash. Turn it
  on in Settings, with an idle delay, a style picker, and an optional "lock the screen when it wakes." Launch it
  anytime from the dashboard button or ⌘⇧A; press Esc (or move the mouse) to exit.
- Your best-ever near-miss shows as a faint second gathering off to the side — an honest picture of how close
  you've come, without overselling it.

**Node**
- The node bridge now publishes the tip block hash (`bestblockhash`), used to colour each minted coin.

## 0.1.37

**Dashboard**
- **The "block mined" banner no longer overlaps the mempool labels.** When a new block was found, the green
  "⛏ block #… mined" announcement in the MEMPOOL panel landed on top of the "backlog · … sat/vB" row beneath the
  title, smearing both. It now sits on its own line (taking over the fee explainer's row while it shows), clear of
  the labels below.
- **The blockchain train shows the full block height again.** The blocks in the sync/conveyor view labelled their
  height mod 100000, so a tip of 957781 rendered as #57781 — looking like a stale chain 900000 blocks behind the
  real one. They now show the full height, matching the network number.
- **"Preview a block" always shows something now.** It only animated inside the MEMPOOL/SYNC panels — and the sync
  half needs the node at the tip — so pressing it while scrolled away, with those panels closed, or mid-sync did
  nothing. It now always opens the MEMPOOL panel and scrolls to it, so the block-mined harvest is visible wherever
  you are.
- **The fixed top controls no longer overlap panel text when scrolled.** "Preview a block / a win" (top-right) and
  the motion / text-size controls (top-left) sat directly on top of whatever panel had scrolled up behind them.
  They now have a scrim, like the footer, so they stay readable and clear of the content.
- **The "N peers" label no longer overlaps the sync warning.** While the node was catching up, the peer-arch label
  sat on top of the "your computer may warm up…" line. The arch now drops a row while syncing so the two are clear.
- **Node-startup messaging reads as "working," not a to-do.** While your managed node was still starting, the
  dashboard said "start your node (bitcoind)" and "no peers connected" — implying you had to do something, for a
  node the app runs itself. It now shows "starting your node…" / "connecting to the Bitcoin network…" with an
  animated indicator, so it's clearly working, not stalled. (Bring-your-own-node keeps a gentle "waiting for your
  node" variant.)
- **Node status is consistent across panels during startup.** BROADCAST, the miner pill and the footer no longer
  say "node offline / not submitting / node syncing / check your node" while SYNC shows the node still starting —
  in managed mode they all agree on "starting" until it's actually up.
- **The dashboard now narrates what your node is actually doing.** Instead of a generic "starting," managed setup
  shows the real phase from the node itself — "Downloading Bitcoin Core," "Loading the verified snapshot 42%" (with
  a progress bar), "Syncing the blockchain" — and if setup fails, it says so ("Your node hit a snag") with the
  reason, instead of looking stuck forever. The phase also shows in the top pill and footer.

**Desktop**
- **No more false "node offline?" after a reboot.** The on-chain update check ran the instant the app launched, so
  if bitcoind was still starting it stamped VERIFIED UPDATES with "not checked — node offline?" even though the
  node came up moments later. The first check now waits (up to 5 min, with backoff) for the node to answer RPC
  before running; the periodic re-checks are unchanged, so a genuinely offline node still reports honestly.

## 0.1.36

**Dashboard**
- **The closeness panel stays readable on smaller screens.** On a narrow window or a low-resolution display, the
  hash row could run into the description text on the right — or squash into an unreadable smear. Now the hash
  trims with a "…" when there isn't room (always keeping the leading zeros and the labels clear) and still shows
  in full when the window is wide.
- **"Verified updates" wording now reads right on every OS.** The update-verification explainer referred to the
  macOS `.dmg` file for everyone; it now just says "the app," so it's accurate for Windows and Linux users too.
- **Small polish:** the closeness panel labels its "bits" figures consistently — the live stats line and the
  best-hash summary now both show the unit instead of a bare number.

## 0.1.35

**Desktop**
- **macOS: auto-updates install cleanly again.** An update would download but then hang on "installing" —
  the app never fully quit, so the installer couldn't swap in the new version and you had to force-quit and
  relaunch. Fixed: the app now quits properly when installing an update. *(One-time note for macOS: updating
  **from 0.1.34 to 0.1.35** still needs a manual quit — fully **Quit** the app with ⌘Q (not just closing the
  window, which keeps it running), then reopen; from 0.1.35 onward, updates install on their own.)*

## 0.1.34

**Dashboard**
- **Odds you can feel.** Your best hash and the target are now shown as *coin-flips* — each leading zero in the
  hash is one more heads landing in a row — and as how often a hash that good turns up on your machine (once a
  month, once a decade, and so on), right alongside the exact 1-in-N. A win comes out to about 79 heads in a row.
  A new rotating line invites you to flip a real coin and count your streak.

## 0.1.33

**Desktop**
- **Update notices are calmer — the pill, not a popup.** An available update just lights the in-app "update
  available" pill (top-right); it no longer pops an unsolicited dialog while you're working. Clicking the pill
  still shows the release notes with an Update / Later choice, and the notes no longer appear **twice** (once at
  the notice and again after updating) — you see them once.
- **macOS: the window remembers its size + position.** Closing the window now *hides* it (the app keeps mining in
  the dock) instead of destroying it, so reopening from the dock restores exactly where you were — same size,
  same position, same scroll — instead of a fresh default-size window.
- **Mining no longer stalls on a flaky IPv6 connection.** On some networks the route to the public block API
  (mempool.space) over IPv6 silently black-holes — the miner would wait out a long timeout on every call and
  fall minutes behind, occasionally skipping a block's ticket entirely. The engine now prefers IPv4, and in live
  mode it triggers each attempt off **your own synced node's** tip instead of the public API — so a slow or
  broken external route can't delay the one thing that matters. A public-API hiccup now only affects the
  supplementary price/stats display, never the ticket.

**Dashboard**
- **Your best hash shows its exact odds.** The closeness panel used to round rarity to whole zero-bits, so the
  figure only moved in 2× jumps. It now shows the exact 1-in-N for your specific best hash — e.g. *1 in 176*
  rather than a bucketed *1 in 128* — next to the true odds of an actual win, and the "new best" toast carries
  the exact odds too. Framed as a record you've set, not progress toward a win (every ticket is an independent
  draw).

## 0.1.32

**Desktop**
- **A bad build can't strand you silently.** Layers of protection after the 0.1.30 startup-crash incident:
  (1) the release pipeline now **launches the packaged app in CI** and refuses to publish if it doesn't start
  cleanly — plus a static check that every required module is actually bundled; (2) the optional on-chain
  update-verification module loads **defensively**, so a missing/broken optional file degrades to "unverified"
  instead of crashing; (3) if startup ever fails anyway, the app shows a local **"reinstall the latest version"
  page** instead of dying with no explanation.
- **Linux: relaunching no longer piles up stray processes.** A second launch of the tray-resident app now
  hard-exits immediately instead of leaving an orphaned AppImage launcher behind. Those accumulating shims were
  what tripped the system's "obsolete binaries / relogin required" notice.
- **Linux: the "what's new" dialog fits the screen.** Its Update/Later buttons no longer fall off the bottom when
  the release notes are long — the notes are capped to a screen-safe length (with "See Full Notes"), the same fix
  the macOS dialog already had. (Linux GTK dialogs don't scroll a long body, just like macOS; Windows does, so
  it's unchanged.)
- **macOS: fixed the garbled app icon.** The icon rendered as colour noise in Finder and System Settings ›
  Notifications on Apple Silicon — electron-builder's PNG→icns conversion was mangling it. The app now ships a
  native `.icns`.

**Dashboard**
- **VERIFIED UPDATES reads clearly while a proof is still settling.** A freshly-installed version now says
  *"installed & verified — its Bitcoin timestamp is still confirming"* instead of a bare "pending" (which looked
  like the update itself wasn't verified). Once anchored, each release shows its Bitcoin block **plus a live
  confirmation count** (chain tip − the anchor block). In the animation, the stamped block is marked **🔒 locked
  in a block from the moment it's on-chain** — immutable immediately, *not* gated on a confirmation threshold —
  with its confirmation depth beside it (each new block on top just buries it deeper).

## 0.1.31

**Desktop**
- **Hotfix — 0.1.30 crashed on launch.** 0.1.30 shipped without `ots-verify.js` in the packaged app, so it failed
  immediately at startup (`Cannot find module './ots-verify.js'`) on every platform. 0.1.31 bundles it. If you're
  stuck on a crashing 0.1.30, download 0.1.31 from [getnotzero.com](https://getnotzero.com) — a crashed install
  can't auto-update itself. (Also hardened the release workflow so the changelog-publish step can no longer trip
  `pipefail`, which had skipped the on-chain checksum anchoring for 0.1.30.)

## 0.1.30

**Desktop**
- **Updates verified against your own node.** Before installing an auto-update, notzero checks the download's hash
  against the release's `SHA256SUMS` and confirms that checksum file is anchored in a Bitcoin block your node
  validated (OpenTimestamps) — it installs on a checksum match, shows on-chain status when available, and only
  blocks a definitive mismatch. The VERIFIED UPDATES section shows the live status **and a history of recent
  releases** — each re-confirmed against your node (verified on-chain · block N · pending · mismatch).
  electron-updater's signed feed stays the baseline.
- **Release-notes dialog fits the screen (macOS).** The "what's new" dialog no longer grows past the screen on
  smaller Macs — where the buttons could fall off the bottom out of reach. Long notes are capped to a screen-safe
  length (with "See Full Notes" for the rest) and render cleanly without stray markdown.

**Dashboard**
- **Adjustable text size.** A new A−/A+ control (top-left, next to the motion toggle) scales the whole dashboard
  up or down and remembers your choice — easier reading on any display, without hunting for browser zoom. The app
  opens a touch larger by default.
- **Clearer hash walk-throughs.** THE CHURN and several panels got readability and spacing polish: each step's
  explanation now holds long enough to read (then clears as it scrolls out), rows stay put instead of jumping, and
  every result slides cleanly into the running hash state.

## 0.1.29

**Verification**
- **Verify your download against Bitcoin.** Every release now publishes a `SHA256SUMS` and timestamps it onto the
  Bitcoin blockchain (OpenTimestamps, from the release pipeline — no wallet or fee on our side). A new
  [getnotzero.com/verify](https://getnotzero.com/verify) page walks through checking a download's hash and
  confirming it against that immutable on-chain record — ideally against your own node, which needs only block
  headers, so the pruned node notzero already runs is enough. The one moment of risk is your first download;
  verify it once.

**Onboarding**
- **"New to Bitcoin? No wallet yet?" help.** The setup wizard now has an expandable helper under the payout
  field for total newcomers — what a wallet/receive address is, three steps to get one, and self-custody +
  seed-phrase safety — linking to a new plain-language [getnotzero.com/wallet](https://getnotzero.com/wallet)
  page (explains wallet types, the "never share your recovery phrase" rule, and points to a neutral wallet
  chooser). Non-custodial throughout: we only ever want your public receive address.

**Dashboard**
- **VERIFIED UPDATES panel.** A new section animates how the app trusts an update: a new version → its SHA-256
  fingerprint → committed in a Bitcoin block → confirmed by your own node. Only block headers are needed, so the
  pruned node you already run is enough. The visual companion to the new
  [getnotzero.com/verify](https://getnotzero.com/verify) page.
- **THE CHURN: each mix step's output stands out.** The result ("= …") row of every mix step now gets a
  neutral white outline + soft glow, so the output pops without changing the lane colours (teal = from e,
  violet = from a, gold = the sums, green = the new registers).
- **Tidier top level + clearer registers.** MERKLE TREE, THE AVALANCHE, VERIFY THIS BLOCK, and INSIDE THE HASH
  (with all its deep dives) now nest under **HASH BUILD** — so the entire hashing deep-dive folds into a single
  top-level row (collapsed by default). Two-level nesting: HASH BUILD's children indent one step, INSIDE THE
  HASH's dives another.
  And the a–h registers in INSIDE THE HASH each get a defined boundary box (both the 8-register strip and the
  64-round matrix), so it's clear where one register ends and the next begins.
- **THE AVALANCHE.** A new panel showing *why* a hash is unpredictable: flip one bit of the nonce and ~half of
  the 256 output bits change (real double-SHA-256 — before/after, with the flipped bits cascading in gold and a
  live counter). Drives home "there's no aiming — change the nonce and the hash leaps somewhere completely new";
  guess-and-check is the only way.

**Desktop**
- **In-app "update available" pill.** When an update is pending, a persistent gold pill shows in the dashboard
  (top-right) — click it to check + get the what's-new / install choice. No longer just a missable OS
  notification. And the notification now fires **once per version** (persisted across restarts) instead of on
  every 2-hour check — the pill carries ongoing visibility, so no more repeat nags.

## 0.1.28

**Desktop**
- **Release notes / "what's new."** Updates no longer install silently: "Check for Updates" (and notify-only
  when the window is open) shows a dialog with the changelog *since your version* and **Update Now / See Full
  Notes / Later**. After an auto-update, the next launch gives a one-time recap of what changed — with a new
  **Settings → "Show what's new after updates"** toggle. **Help → Release Notes** and a Settings link open the
  new [getnotzero.com/changelog](https://getnotzero.com/changelog) page. Users who skip releases see *every*
  version since theirs, not just the latest. Repeat notify-only notifications are deduped to one per version.

**Mining**
- **Do-whatever-it-takes block submission.** A won block is now pushed through **two gateways at once** from the
  first instant: the node's `submitblock` RPC *and* a direct **P2P broadcast** fanned out in parallel to ~25
  well-connected nodes (your node's own peers first, then the DNS seeds) so it reaches the big miners in ~1–2s.
  If the node RPC keeps failing, a background worker hammers both — RPC retries fast-early and capped at 30s;
  P2P re-pushed to fresh peers every ~45s — and independently confirms via a public explorer,
  until the block lands, the node reports a duplicate, or another block fills the height. Resumes on the next
  launch if the app crashed mid-retry; the found block is still written to disk first so it can never be lost.
  Previously a failed submit only saved the hex for **manual** resubmit — useless for an unattended miner in the
  ~10-minute window. (Opt out with `"p2p_fallback": false` in config.)

**Dashboard**
- **BROADCAST panel.** A live "if you win" view: your miner at the hub with the block radiating out to the
  network (major pools labelled) via your node's peers *and* a direct P2P push, as a sonar wavefront — your
  directly-connected peers light first (instant), then gossip carries it outward, and on an actual win it flips
  to a gold "BLOCK FOUND — broadcasting" burst. Real readiness badges — node sync state + live peer count
  (`getpeerinfo`), and "Direct
  P2P: armed" — so you can see at a glance that a win would go out instantly. Ties together the do-whatever-
  it-takes submission work.
- **VERIFY THIS BLOCK.** A new panel that independently recomputes a real recent block's proof-of-work
  in-browser and shows the three checks a node runs turn green: double-SHA-256 of the 80-byte header matches
  the block's hash, the hash is below the difficulty target, and the merkle root rebuilt from every txid
  matches the header — no trust required. Closes the loop with HASH BUILD, MERKLE TREE, and YOUR CLOSENESS.
- **Best-match odds.** YOUR CLOSENESS now shows the true 1-in-2ⁿ rarity of your best hash (e.g. "7 bits ·
  1 in 128") on the best row and in the ◆ best / ● you hover tooltips, framed against the target ("a win is
  1 in ~10^N").
- **Win celebration — stages + clearer dismiss.** The full-screen win now shows your block's journey as an
  animated stepper (FOUND → SUBMITTING → CONFIRMING n/6 → CONFIRMED), and "preview a win" walks through it
  so you can see the whole flow. Added a visible "✕ close" (it already dismissed on any click).
- Fixed THE FOLD hash chip overlapping the box during the mid-slide keyframe.

## 0.1.27

**Dashboard**
- **THE FOLD** — a new animated panel (under INSIDE THE HASH, after THE CHURN) showing how SHA-256 digests a
  message longer than its 256-bit output. A "64-round machine" slides along the message, eating one 512-bit
  segment at a time; the box has two rows (top = the incoming segment, bottom = the state), the segment drops
  into the state and churns, then the box slides right **leaving the hash** — which slides into the next box as
  its new bottom row, so the previous hash literally becomes the new constants. Includes **play / pause /
  step** transport (like THE CHURN) with non-linear pacing that holds on each readable step.

## 0.1.26

**App**
- **Auto-update opt-out.** A new Settings toggle, *"Install updates automatically"* (default on). Turn it off
  and notzero switches to **notify-only**: it tells you when a version is available but never downloads or
  installs on its own — you install it yourself from **Help → Check for Updates**. For the security-conscious
  who'd rather not have code auto-run from a server; everyone else keeps getting fixes automatically.

**Website**
- The *"The Mac app is signed & notarized by Apple"* trust line now shows to **all** visitors (it was hidden
  for Windows/Linux), scoped clearly to the Mac app and worded so a non-Mac reader isn't misled that their own
  download is signed.

## 0.1.25

**Dashboard**
- **Plain-English explainers on the MEMPOOL and NETWORK panels.** A live one-liner turns the numbers into the
  mechanism behind them: why the backlog sets the fee (*"cheaper txs wait for it to drain"*), and why more
  hashpower means higher difficulty, not faster blocks. Derived from the data already shown — mechanism only,
  no prediction or price commentary.
- **New MERKLE TREE section** — how every transaction folds into one root by hashing in pairs, with the step
  people trip on made explicit: two 32-byte hashes are *concatenated* into one 64-byte string, then hashed.
- **Block-time distribution in NEXT BLOCK** — a histogram of recent block intervals (per-bar minute labels + a
  live "you are here" marker) showing block times are memoryless: 10 min is an average, not a schedule.
- **Block chaining in INSIDE THE HASH** — a strip showing a longer message runs the same churn once per 512-bit
  block, each starting from the *previous* block's output (the Merkle–Damgård fold), not the constants.
- **Hover tooltips on the MEMPOOL blocks** — size, tx count, and miner, plus why a block is taller than its
  neighbor (height = data size; space is capped ~4M weight, so fullness tracks demand).

**App**
- **A clear "Installing update" screen when an update applies.** Auto-updates used to only fire an OS
  notification, then quit + relaunch — which, if notifications were off, looked like a crash. The window now
  shows a full-screen **"Installing update — notzero is restarting… mining resumes automatically"** overlay
  (with the target version) before it relaunches, independent of notification permission, and waits a beat
  longer (6s) so it's readable.

**Security / build**
- **The pinned Bitcoin Core download hashes are now verified against Core's PGP-signed SHA256SUMS in CI.** The
  managed node already refuses to run any bitcoind that doesn't match a SHA-256 pinned inside the signed app;
  a new required release gate (`scripts/verify-core-pins.cjs`) confirms those pins match Core's builder-signed
  checksums, so a mistyped or tampered pin can never ship.
- **Fail-fast on an incomplete assumeutxo snapshot download.** A dropped/partial 10 GB snapshot download is now
  caught by an exact size check *before* it's loaded, with a clear "syncing normally — reopen to retry"
  message, instead of a cryptic failure deep inside Core's load. (Core still validates the contents itself.)

## 0.1.24

**App**
- **New app icon** — a bigger, higher-contrast ₿ that stays legible at small sizes (menu bar, notifications,
  System Settings), where the old one read as a dark blob.
- **Settings: "Send test notification" button** — fires a real OS notification so you can confirm delivery (and
  trigger the macOS permission prompt). If your OS reports notifications aren't available, it says so.
- **Saving settings no longer looks like it disconnects you.** Saving restarts the miner + bridge, and for a
  few seconds the dashboard showed a scary "no node connected." It now holds the last-good state and shows a
  calm **"reconnecting to your node…"** for a short grace window (the panel, status pill, and footer), then
  fills back in once the bridge reconnects.

**Linux**
- **Closing the window no longer quits — it keeps mining.** The Linux build now hides to a system tray on
  close (matching macOS's dock and the Windows tray) instead of stopping. Reopen from the tray, or just launch
  the app again; **Quit** from the tray to actually stop. On desktops that hide the tray (e.g. GNOME without
  the AppIndicator extension), a one-time notification tells you it's still running so it doesn't look like the
  app vanished. (Falls back to quit-on-close only if no tray could be created at all.)

## 0.1.23

**Dashboard — a full, animated walk through one SHA-256 round**
- **THE CHURN** — watch a round get built live, one operation at a time: each register is read in (its source
  blinks, then its row fills), the operation runs (rotate / XOR / choose / majority / add — shown bit by bit,
  with carries), the result scrolls up into a "store" of intermediate values (Σ1, Ch, T1, Σ0, Maj, T2), and
  spent values scroll out. It's a read → operate → store flow you can pause, step through operation by
  operation, and slow down (speed pill: ¼×–4×). The register grid scrolls a row per round so you can watch
  the message spread through a–h.
- **ONE STEP · Σ1 / Ch / Maj** and **ONE ROUND** — roomier, clearer worked examples of each operation on real
  round-0 register values.
- The whole **INSIDE THE HASH** deep dive (previously lab-only) is now on by default.

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
