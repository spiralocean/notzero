# Linux build — handoff

Context for a Claude Code session building + testing the **Linux** package of **notzero** (Bitcoin
Lottery). macOS is fully shipped (0.1.11, https://dl.getnotzero.com); Windows is in progress (see
`WINDOWS-BUILD.md`); **Linux is the last platform.** Read `WINDOWS-BUILD.md` first for the shared app
overview — this doc only covers Linux specifics.

## Good news: Linux is the simpler target
- **No code signing** — Linux has no SmartScreen/Gatekeeper equivalent, so unsigned ships clean.
- The code already handles Linux everywhere: `node-provision.js` pins the `x86_64-linux-gnu` +
  `aarch64-linux-gnu` Core tarballs; `managedPaths()`/`engineCmd()` use no `.exe`; `defaultCookiePath()`
  falls back to `~/.bitcoin/.cookie`.
- `desktop/package.json` `linux` target is **AppImage** (single portable file — `chmod +x` and run; the
  most distro-agnostic format). Could also add `deb`/`rpm` later for Ubuntu/Fedora.

## Goal
Produce a working **AppImage**, then test the full "Set one up for me" flow on Linux (download/verify
Core, run bitcoind, load the 880k assumeutxo snapshot, sync, mine).

## Build environment (engines must be built ON Linux — PyInstaller is platform-specific)
Pick one:
- **Docker on the Mac** (build only): a Linux container builds the engines + AppImage. Can't easily run a
  GUI app to *test*, so pair with a VM for testing.
- **WSL2 on the Windows laptop** (build + test): WSL2 + WSLg can build the engines/AppImage and run the
  GUI app — convenient since the Windows laptop is already in play.
- **A Linux VM** (UTM/VirtualBox) or physical Linux box — build + test natively (most faithful).
- **GitHub Actions** (ubuntu runner) — reproducible CI build; download the AppImage and test on a Linux box.

## Build steps
1. Clone the repo; install **Node LTS**, **Python 3.9+**, `pip install pyinstaller`.
2. `cd desktop && npm install`
3. Build the engines into `desktop/resources/` (Linux ELF binaries named `miner` + `bridge`, no extension):
   `desktop/build-engines.sh` should work on Linux (it's bash) — but it runs a block-validity gate needing
   a node, so for a first build use `SKIP_BLOCK_VERIFY=1`. Or run PyInstaller directly:
   `python3 -m PyInstaller --onefile --name miner lottery_miner.py` and
   `python3 -m PyInstaller --onefile --name bridge --paths . --hidden-import lottery_miner scripts/node_bridge.py`.
4. `npm run dist` → electron-builder produces an **`.AppImage`** in `desktop/dist/`.
5. `chmod +x *.AppImage && ./notzero*.AppImage` → test "Set one up for me".

## Known Linux items to sort during testing
- **AppImage needs FUSE** — some distros need `libfuse2` installed (`sudo apt install libfuse2`), else the
  AppImage won't mount. Note this on the download page.
- **Close vs quit**: same as Windows — `window-all-closed` **quits** on non-mac, so closing stops mining,
  and the dashboard note is Mac-worded ("⌘Q"). Make it OS-aware or add a tray. (`web/app.js` `drawNetwork`.)
- **Sandbox**: Electron on some Linux setups needs `--no-sandbox` or the chrome-sandbox SUID bit;
  electron-builder usually handles it, but watch for a sandbox error on first launch.

## After it builds + tests clean
- Host on R2: `rclone copyto <file>.AppImage r2:notzero-dl/notzero-linux-x86_64.AppImage`.
- Update the landing page (`site/index.html`, deploy per `DEPLOY.md`) — Linux is currently "coming soon".
