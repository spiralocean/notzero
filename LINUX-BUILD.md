# Linux build — handoff

> ## ⚡ READ FIRST — current status (updated 2026-07-02)
> **Linux is SHIPPED.** notzero **0.1.28** is live (download + auto-update) at https://dl.getnotzero.com —
> all three platforms (mac, Windows, Linux) now ship 0.1.28 from a unified `main`.
> **Build on x86_64 Linux — the easy path is WSL2 on the Windows laptop** (native x86_64 + WSLg to
> GUI-test). Do **not** build on the mac repo: it's arm64, so an x86_64 AppImage would need slow, flaky
> qemu emulation, and a native arm64 build wouldn't run on most Linux desktops. The release is one script.
> **First time on a fresh box? Do `LINUX-BOOTSTRAP.md` first** (installs Node 20, PyInstaller venv, Claude
> Code, git/rclone creds), then come back here.
>
> ### To cut the Linux release (whole flow = one script)
> 1. On **x86_64 Linux with a display** (a real Ubuntu 24 desktop — local, VM, or remote-with-GUI — is
>    ideal: native arch + you can GUI-test "Set one up for me" on the same box). One-time setup:
>    - **Node 20 LTS** via nvm or NodeSource — *not* `apt install nodejs` (Ubuntu's is too old for electron-builder).
>    - `sudo apt install -y libfuse2t64 git build-essential` (FUSE — the AppImage won't mount without it).
>    - **PyInstaller in a venv** (Ubuntu 24 blocks system pip — PEP 668):
>      `python3 -m venv ~/.venv && source ~/.venv/bin/activate && pip install pyinstaller`
>      (activate that venv in the shell that runs the release script).
>    - Clone the repo, then once: `cd desktop && npm install`.
> 2. `git pull origin main`; bump `"version"` in `desktop/package.json` if shipping a new version.
> 3. `./scripts/release-linux.sh` — builds engines (PyInstaller) + the AppImage, then publishes to R2:
>    - `notzero-<version>-linux-<arch>.AppImage` (+ `.blockmap`) — versioned, cacheable → updater target
>    - `latest-linux.yml` — updater feed (`no-cache`), references the versioned AppImage
>    - `notzero-linux.AppImage` — stable alias for the website download button (`no-cache`)
>    Requires `rclone` with an `r2` remote (bucket `notzero-dl`).
>
> ### After publishing (first Linux release only)
> - Extend the Cloudflare cache rule to cover **`/notzero-linux.AppImage`** + **`/latest-linux.yml`**
>   (Bypass cache + Respect origin TTL — same as the win/mac files) so re-uploads serve fresh.
> - Flip the landing page Linux "coming soon" → real download (`site/index.html`, per `DEPLOY.md`):
>   `cd site && npx wrangler pages deploy`, or have mac-Claude do it.
> - `git push origin main` so mac-Claude + the website integrate.

Context for a Claude Code session building + testing the **Linux** package of **notzero** (Bitcoin
Lottery). **All three platforms — macOS, Windows, Linux — are shipped at 0.1.28** (https://dl.getnotzero.com).
Read `WINDOWS-BUILD.md` first for the shared app overview — this doc only covers Linux specifics.

## Good news: Linux is the simpler target
- **No code signing** — Linux has no SmartScreen/Gatekeeper equivalent, so unsigned ships clean.
- The code already handles Linux everywhere: `node-provision.js` pins the `x86_64-linux-gnu` +
  `aarch64-linux-gnu` Core tarballs; `managedPaths()`/`engineCmd()` use no `.exe`; `defaultCookiePath()`
  falls back to `~/.bitcoin/.cookie`.
- `desktop/package.json` `linux` target is **AppImage** (single portable file — `chmod +x` and run; the
  most distro-agnostic format). Could also add `deb`/`rpm` later for Ubuntu/Fedora.

## Goal
A working **AppImage** that passes the full "Set one up for me" flow on Linux (download/verify Core, run
bitcoind, load the 880k assumeutxo snapshot, sync, mine) — then publish it with `release-linux.sh` (above).

## Build environment — why x86_64 Linux is required
The engines (`miner`, `bridge`) are **PyInstaller binaries, which don't cross-compile** — they must be
built on Linux to produce Linux ELF binaries. Build **x86_64** (what most Linux desktops run):
- **WSL2 on the Windows laptop** ← recommended: native x86_64 + WSLg to GUI-test, on a machine already in play.
- A **Linux VM** (UTM/VirtualBox) or physical x86_64 box — also build + test natively.
- **GitHub Actions** (ubuntu runner) — reproducible build only; download the AppImage and test on a Linux box.
- *Not the mac repo:* it's arm64 → x86_64 needs qemu emulation (slow/flaky PyInstaller); arm64 output
  won't run on most Linux desktops. (An arm64 AppImage for Pi/arm servers is a separate, later build.)

## Known Linux items to sort during testing
- **AppImage needs FUSE** — some distros need `libfuse2` installed (`sudo apt install libfuse2`), else the
  AppImage won't mount. Note this on the download page.
- **Close vs quit**: same as Windows — `window-all-closed` **quits** on non-mac, so closing stops mining,
  and the dashboard note is Mac-worded ("⌘Q"). Make it OS-aware or add a tray. (`web/app.js` `drawNetwork`.)
- **Sandbox**: Electron on some Linux setups needs `--no-sandbox` or the chrome-sandbox SUID bit;
  electron-builder usually handles it, but watch for a sandbox error on first launch.

---

[a **spiralocean** project](https://spiralocean.com)

