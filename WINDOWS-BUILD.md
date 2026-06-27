# Windows build — handoff

> ## ⚡ READ FIRST — current status (updated 2026-06-27)
> **Windows is SHIPPED.** notzero **0.1.13** is live (download + auto-update) at https://dl.getnotzero.com,
> linked from getnotzero.com. mac + Windows both ship from a unified `main`. **Linux (AppImage) is the only
> remaining platform.** The manual "Build steps" / "After it builds" sections below are now **historical
> reference** — the release is one script.
>
> ### To cut a Windows release (whole flow = one script)
> 1. `git pull origin main` — gets the latest dashboard/engines/fixes **and** the release script.
> 2. If shipping a new version, bump `"version"` in `desktop/package.json` (shared across mac/win/linux;
>    each platform publishes its own feed, so the same version number is fine).
> 3. `pwsh ./scripts/release-win.ps1` (or `powershell -File scripts\release-win.ps1`).
>    Builds engines (PyInstaller) + the NSIS installer, then publishes to R2 (`r2:notzero-dl`):
>    - `notzero-<version>-win.exe` (+ `.blockmap`) — **versioned, cacheable** → the electron-updater target
>    - `latest.yml` — the updater feed (`no-cache`), references the versioned exe
>    - `notzero-win.exe` — **stable alias** for the website download button only (`no-cache`)
>    Requires: Node, Python 3.9+ with PyInstaller, and `rclone` with an `r2` remote (bucket `notzero-dl`).
>
> ### Integration / coordination (how mac-Claude and you stay in sync)
> - **git is the channel.** `git pull` before you start; `git push origin main` when you commit, so the
>   mac side + website can integrate. The dashboard (`web/app.js`) is the single shared source — already merged.
> - **Never commit build artifacts** — `*.exe/.dmg/.zip/.blockmap/latest*.yml` are gitignored (they go to R2).
> - Versioned-exe naming + a Cloudflare cache rule (keeps `notzero-win.exe` + `latest.yml` fresh) are already
>   set up; `release-win.ps1` handles caching correctly — nothing to configure.

Context for a Claude Code session **running on a Windows laptop** to build + test the Windows
installer for **notzero** (a.k.a. Bitcoin Lottery). The macOS side is fully built, signed, notarized,
and shipping at https://dl.getnotzero.com.

## What this app is
A desktop app (Electron, in `desktop/`) that lets non-technical people **solo-mine Bitcoin** — one
"lottery ticket" per block. "Set one up for me" downloads + verifies official **Bitcoin Core**, runs a
private **pruned managed node** with an **assumeutxo** fast-start snapshot (height **880000**, hosted at
`https://dl.getnotzero.com/utxo-880000.dat`), then points a tiny miner at it. Non-custodial — it never
holds keys, only a payout address. The dashboard is a canvas app in `web/` bundled into the desktop app.

## Goal on Windows
Produce a working **NSIS `.exe` installer**, then **test the full "Set one up for me" flow** on Windows
(download/verify Core, run bitcoind, load the 880k snapshot, sync, mine).

## Prerequisites to install on Windows
- **Git**, **Node.js LTS**, **Python 3.9+** (tick "Add to PATH"), then `pip install pyinstaller`.

## Build steps (figure out exact commands interactively)
1. `git clone https://github.com/spiralocean/notzero` (or the user's remote) and `cd` in.
2. `cd desktop && npm install`
3. **Build the engines** (`miner.exe`, `bridge.exe`) with PyInstaller into `desktop/resources/`.
   - The macOS script is `desktop/build-engines.sh` (bash). On Windows it likely needs tweaks:
     it calls **`python3`** (Windows usually has **`python`**), and it runs a **block-validity gate**
     (`scripts/verify-block.py`) that needs a reachable node — for a first build set
     **`SKIP_BLOCK_VERIFY=1`**. Either run it in Git Bash with those adjustments, or run PyInstaller
     directly: `python -m PyInstaller --onefile --name miner lottery_miner.py` and
     `python -m PyInstaller --onefile --name bridge --paths . --hidden-import lottery_miner scripts/node_bridge.py`
     (output to `desktop/resources/`). They must be **`miner.exe`** + **`bridge.exe`**.
4. `npm run dist` (in `desktop/`) → electron-builder produces a Windows **NSIS installer** in
   `desktop/dist/` (the `win` target is already configured as `nsis` in `desktop/package.json`).
5. Install it and test **Set one up for me**.

## Already handled for Windows
- `desktop/node-provision.js` pins the **`bitcoin-31.0-win64.zip`** Core artifact (sha256) and
  `managedPaths()` adds `.exe` for bitcoind/bitcoin-cli on win32.
- `defaultCookiePath()` handles the Windows `%APPDATA%\Bitcoin\.cookie` location.
- `engineCmd()` in `main.js` now launches the engines with the **`.exe`** suffix on win32 (fixed).

## Known Windows-specific items to sort during testing
- **Close vs quit**: `window-all-closed` currently **quits** the app on non-mac — so on Windows,
  closing the window STOPS mining. The dashboard's close-vs-quit note (in `web/app.js` `drawNetwork`,
  gated on `nodeMode === "managed"`) is **Mac-worded** ("closing keeps it running… ⌘Q"). Either make it
  OS-aware, or add a **system-tray** icon so Windows can keep mining in the background. Decide with the user.
- **Code signing**: no budget → ship **unsigned** initially. Unsigned triggers **SmartScreen**
  ("Windows protected your PC" → More info → Run anyway). Add signing later if a cert is bought.
- The Help menu uses `shell.openExternal` (mailto/https) — should work cross-platform.

## After it builds + tests clean
- Host the installer on R2: `rclone copyto <installer>.exe r2:notzero-dl/notzero-setup.exe` (the mac
  release uses `scripts/release-mac.sh`; make an equivalent Windows step). Add a Windows entry to the
  updater feed if doing auto-updates (`latest.yml`).
- Update the landing page (`site/index.html`, deployed to Cloudflare **Pages** project `notzero` via
  `npx wrangler pages deploy site --project-name=notzero`) — Windows is currently "coming soon"; flip it
  to a real download once tested.

## Key facts
- Releases/deploys are documented in the file-based memory and `scripts/`. The mac release is
  `source release.env && scripts/release-mac.sh`. Downloads + snapshots live on Cloudflare **R2**
  (`r2:notzero-dl` → `dl.getnotzero.com`); the landing + demo are Cloudflare **Pages** (`notzero`,
  `notzero-demo`), NOT Vercel.
- Verify any snapshot/Core download by hash; Core verifies the assumeutxo snapshot against its baked-in
  880k hash at load time.
