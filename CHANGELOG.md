# Changelog

Notable changes per release. All platforms ship from a unified `main` and publish the **same version**
(mac → Windows → Linux; see `DEPLOY.md`). When cutting a release, move **Unreleased** down under the new
version number and bump `desktop/package.json`.

## Unreleased — next: 0.1.15

_Nothing yet._

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
