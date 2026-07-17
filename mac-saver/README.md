# NotZero — node-less macOS screensaver (`.saver`)

A real macOS screensaver (System Settings + lock screen) that reuses the **same web canvas** as the
desktop app's ambient view. It's a thin Swift `ScreenSaverView` hosting a `WKWebView` that loads
`ambient.html` / `ambient-rain.html` from the bundle via `file://`.

**Why node-less works:** loaded from `file://`, the pages skip the node feed entirely and run
self-contained (The Deep uses its own cadence; Rain uses default glyphs). No server, no node, **no
network** — which is exactly why the sandbox that blocks screensaver networking is a non-issue here.

## Build

```bash
cd mac-saver
./build.sh          # → build/NotZero.saver  (Mach-O bundle, ad-hoc signed)
```
Requires the Xcode command-line tools (`swiftc`, `xcrun`) — already present on this machine.

## Install (local test)

```bash
cp -R build/NotZero.saver ~/Library/Screen\ Savers/
```
Then **System Settings → Screen Saver → NotZero**. Click **Screen Saver Options…** to pick
**The Deep** or **Matrix rain** (stored in `ScreenSaverDefaults`; applied live).
Or just double-click the `.saver` in Finder to install.

To style-switch without the sheet:
```bash
defaults write com.getnotzero.saver style rain   # or: breath
```

## Files

- `NotZeroSaverView.swift` — the `ScreenSaverView`; hosts the `WKWebView`, loads the chosen HTML.
- `ConfigSheet.swift` — the programmatic "Screen Saver Options…" sheet (style picker).
- `Info.plist` — `NSPrincipalClass = NotZeroSaverView`, bundle metadata.
- `build.sh` — compiles + assembles + ad-hoc signs the `.saver`; copies `web/ambient*.html` into Resources.

The two HTML files are **copied from `web/`** at build time, so the screensaver and the in-app ambient
view stay in sync — edit the visuals once in `web/`, rebuild.

## Before shipping (not done yet — prototype)

- **Universal binary.** `build.sh` builds the host arch (arm64). For distribution, build `arm64` +
  `x86_64` (`-target …`) and `lipo` them together.
- **Signing + notarization.** It's ad-hoc signed for local use. Distribution needs a Developer ID
  signature + notarization (same key path as the app's notarize flow), or Gatekeeper will block it.
- **Sequoia (macOS 15).** The screensaver engine was rewritten and runs savers sandboxed in a separate
  process. This WKWebView approach is expected to work (no network needed), but **test on 15** before
  relying on it — that engine has broken third-party savers before.
- **First-launch quarantine.** A freshly built/unsigned `.saver` may need
  `xattr -dr com.apple.quarantine build/NotZero.saver` (or right-click → Open) on some setups.
