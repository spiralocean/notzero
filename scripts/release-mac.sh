#!/usr/bin/env bash
# release-mac.sh — build, notarize, and publish the macOS release in ONE command.
# Produces a signed + notarized + stapled .dmg (the download) and a .zip + latest-mac.yml
# (the electron-updater feed), then uploads everything to R2 at dl.getnotzero.com.
#
# Why a script: electron-builder notarizes the .app (via the afterSign hook) but leaves the
# .dmg unsigned/un-notarized, so the dmg needs a manual sign→notarize→staple. This captures
# that, plus the upload, so a release is reproducible instead of a pile of manual steps.
#
# Requires in the environment:
#   APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER   (App Store Connect API key)
#   LOTTERY_DATA_DIR                                   (a synced node's data dir, for the
#                                                       build's block-validity gate)
# And on the machine: rclone with an 'r2' remote (bucket notzero-dl), and a
#   "Developer ID Application" signing identity in the keychain.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/desktop"; DIST="$DESKTOP/dist"
SIGN_ID="${MAC_SIGN_ID:-Developer ID Application: Stephen Zinn (2386YZLWA2)}"
BUCKET="${R2_BUCKET:-r2:notzero-dl}"

: "${APPLE_API_KEY:?set APPLE_API_KEY (path to the .p8)}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
: "${LOTTERY_DATA_DIR:?set LOTTERY_DATA_DIR (a reachable, synced node's data dir)}"

echo "→ building (engines + dmg + zip; the .app is notarized by the afterSign hook)…"
( cd "$DESKTOP" && npm run dist )

DMG="$(ls "$DIST"/notzero-*-mac-*.dmg 2>/dev/null | head -1)"
ZIP="$(ls "$DIST"/notzero-*-mac-*.zip 2>/dev/null | head -1)"
YML="$DIST/latest-mac.yml"
{ [ -f "$DMG" ] && [ -f "$ZIP" ] && [ -f "$YML" ]; } || { echo "✗ expected build artifacts missing in $DIST" >&2; exit 1; }

echo "→ signing + notarizing + stapling the dmg ($(basename "$DMG"))…"
codesign --force --sign "$SIGN_ID" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature "$DMG" >/dev/null 2>&1 \
  && echo "  ✓ dmg passes Gatekeeper (Notarized Developer ID)" \
  || { echo "✗ dmg failed Gatekeeper after notarization" >&2; exit 1; }

echo "→ trimming the now-stale dmg entry from latest-mac.yml (the updater uses the zip)…"
sed -i '' "/- url: $(basename "$DMG")/,+2d" "$YML" 2>/dev/null || true

echo "→ uploading to $BUCKET …"
rclone copyto "$DMG" "$BUCKET/notzero-mac-arm64.dmg" --s3-no-check-bucket --s3-chunk-size 64M -q   # stable name for the landing page
rclone copyto "$ZIP" "$BUCKET/$(basename "$ZIP")"   --s3-no-check-bucket --s3-chunk-size 64M -q   # versioned, referenced by latest-mac.yml
[ -f "$ZIP.blockmap" ] && rclone copyto "$ZIP.blockmap" "$BUCKET/$(basename "$ZIP").blockmap" --s3-no-check-bucket -q
rclone copyto "$YML" "$BUCKET/latest-mac.yml" --s3-no-check-bucket -q

echo
echo "✓ released."
echo "  download : https://dl.getnotzero.com/notzero-mac-arm64.dmg"
echo "  feed     : https://dl.getnotzero.com/latest-mac.yml  ($(basename "$ZIP"))"
echo "  Bump \"version\" in desktop/package.json before the next release so updates trigger."
