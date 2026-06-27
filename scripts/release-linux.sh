#!/usr/bin/env bash
# release-linux.sh — build the Linux AppImage and publish it to R2 (dl.getnotzero.com).
# The Linux analogue of release-mac.sh / release-win.ps1. No signing (Linux has no Gatekeeper/SmartScreen).
#
# RUN THIS ON LINUX — PyInstaller is platform-specific, so the engines must be compiled on Linux. Build
# x86_64 on an x86_64 host (what most Linux desktop users run). The easy path is WSL2 on the Windows
# laptop (native x86_64 + WSLg to GUI-test); this macOS repo is arm64, so it can't build x86_64 natively.
#
# Requires on the machine:
#   - Node + npm, Python 3.9+ with PyInstaller  (engines are PyInstaller binaries built here)
#   - rclone with an 'r2' remote pointing at the notzero-dl bucket (same remote release-mac.sh uses)
#   - libfuse2 on some distros for the AppImage build/run (sudo apt install libfuse2)
#
# Publishes (mirrors release-mac.sh — the versioned AppImage is immutable/cacheable; the feed + the
# website alias are stable URLs that change each release, so they upload Cache-Control: no-cache):
#   notzero-<version>-linux-<arch>.AppImage (+ .blockmap)  the electron-updater target (cacheable)
#   latest-linux.yml                                       the electron-updater feed (no-cache)
#   notzero-linux.AppImage                                 stable alias for the website button (no-cache)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/desktop"; DIST="$DESKTOP/dist"; RES="$DESKTOP/resources"
BUCKET="${R2_BUCKET:-r2:notzero-dl}"
VERSION="$(node -p "require('$DESKTOP/package.json').version")"
echo "-> releasing notzero-linux $VERSION to $BUCKET"

# 1) engines: miner + bridge (onefile ELF, no Python needed on the user's machine). Built directly with
#    PyInstaller — build-engines.sh runs a node-gated validity check; the macOS release does that gate,
#    so here we skip it (same as release-win.ps1).
echo "-> building engines (PyInstaller)..."
( cd "$ROOT" \
  && python3 -m PyInstaller --onefile --clean --noconfirm --name miner  --distpath "$RES" lottery_miner.py >/dev/null \
  && python3 -m PyInstaller --onefile --clean --noconfirm --name bridge --paths . --hidden-import lottery_miner --distpath "$RES" scripts/node_bridge.py >/dev/null )
{ [ -x "$RES/miner" ] && [ -x "$RES/bridge" ]; } || { echo "x engine build failed" >&2; exit 1; }

# 2) AppImage (electron-builder reads linux.artifactName = notzero-${version}-linux-${arch}.${ext});
#    produces the .AppImage + latest-linux.yml. Build the linux target directly (don't `npm run dist` —
#    that re-runs the macOS build-engines.sh).
echo "-> building AppImage..."
( cd "$DESKTOP" && npx electron-builder --linux )

# select the freshly built artifacts for THIS version (never let a stale one sneak through)
APPIMG="$(ls "$DIST"/notzero-"$VERSION"-linux-*.AppImage 2>/dev/null | head -1)"
YML="$DIST/latest-linux.yml"
{ [ -n "$APPIMG" ] && [ -f "$APPIMG" ] && [ -f "$YML" ]; } || { echo "x build artifacts missing in $DIST" >&2; exit 1; }
APPBASE="$(basename "$APPIMG")"

# 3) publish to R2
echo "-> uploading to $BUCKET ..."
# versioned AppImage + blockmap → version-specific (immutable) URLs, fine to cache at the edge
rclone copyto "$APPIMG" "$BUCKET/$APPBASE" --s3-no-check-bucket --s3-chunk-size 64M -q
[ -f "$APPIMG.blockmap" ] && rclone copyto "$APPIMG.blockmap" "$BUCKET/$APPBASE.blockmap" --s3-no-check-bucket -q
# feed (references the versioned AppImage) → stable URL, no-cache so the CDN always serves the latest
rclone copyto "$YML" "$BUCKET/latest-linux.yml" --s3-no-check-bucket --header-upload "Cache-Control: no-cache" -q
# stable alias for the website download button → no-cache (cache-ruled fresh); the updater does NOT use this
rclone copyto "$APPIMG" "$BUCKET/notzero-linux.AppImage" --s3-no-check-bucket --s3-chunk-size 64M --header-upload "Cache-Control: no-cache" -q

echo
echo "ok: released notzero-linux $VERSION"
echo "   download : https://dl.getnotzero.com/notzero-linux.AppImage   (stable, website button)"
echo "   updater  : https://dl.getnotzero.com/$APPBASE   (versioned, cacheable)"
echo "   feed     : https://dl.getnotzero.com/latest-linux.yml"
echo "   Bump the version in desktop/package.json before the next release so updates trigger."
echo "   Remember the Cloudflare cache rule must cover notzero-linux.AppImage + latest-linux.yml (no-cache)."
