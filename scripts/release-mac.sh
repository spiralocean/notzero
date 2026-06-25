#!/usr/bin/env bash
# release-mac.sh — build, notarize, and publish the macOS release in ONE command.
# Produces a signed + notarized + stapled .dmg (the download) and a .zip + latest-mac.yml
# (the electron-updater feed), then uploads everything to R2 at dl.getnotzero.com.
#
# Why a script: electron-builder notarizes the .app (via the afterSign hook) but leaves the
# .dmg unsigned/un-notarized, so the dmg needs a manual sign -> notarize -> staple. This
# captures that, plus the upload, so a release is reproducible instead of manual steps.
#
# Requires in the environment:
#   APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER   (App Store Connect API key)
#   LOTTERY_DATA_DIR                                   (a synced node data dir, for the
#                                                       build block-validity gate)
# And on the machine: rclone with an r2 remote (bucket notzero-dl), and a
#   Developer ID Application signing identity in the keychain.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/desktop"; DIST="$DESKTOP/dist"
SIGN_ID="${MAC_SIGN_ID:-Developer ID Application: Stephen Zinn (2386YZLWA2)}"
BUCKET="${R2_BUCKET:-r2:notzero-dl}"

: "${APPLE_API_KEY:?set APPLE_API_KEY to the path of the .p8 key}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
: "${LOTTERY_DATA_DIR:?set LOTTERY_DATA_DIR to a reachable synced node data dir}"

echo "-> cleaning dist to avoid stale artifacts from a previous version..."
rm -rf "$DIST"

echo "-> building (engines + dmg + zip; the .app is notarized by the afterSign hook)..."
( cd "$DESKTOP" && npm run dist )

# select artifacts by the exact version being built (never let an old version sneak through)
VERSION="$(node -p "require('$DESKTOP/package.json').version")"
DMG="$(ls "$DIST"/notzero-"$VERSION"-mac-*.dmg 2>/dev/null | head -1)"
ZIP="$(ls "$DIST"/notzero-"$VERSION"-mac-*.zip 2>/dev/null | head -1)"
YML="$DIST/latest-mac.yml"
{ [ -f "$DMG" ] && [ -f "$ZIP" ] && [ -f "$YML" ]; } || { echo "x build artifacts missing in $DIST" >&2; exit 1; }
DMGBASE="$(basename "$DMG")"; ZIPBASE="$(basename "$ZIP")"

echo "-> signing + notarizing + stapling the dmg ($DMGBASE)..."
codesign --force --sign "$SIGN_ID" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"
if spctl -a -t open --context context:primary-signature "$DMG" >/dev/null 2>&1; then
  echo "   ok: dmg passes Gatekeeper (Notarized Developer ID)"
else
  echo "x dmg failed Gatekeeper after notarization" >&2; exit 1
fi

echo "-> trimming the now-stale dmg entry from latest-mac.yml (the updater uses the zip)..."
sed -i '' "/- url: $DMGBASE/,+2d" "$YML" 2>/dev/null || true

echo "-> uploading to $BUCKET ..."
rclone copyto "$DMG" "$BUCKET/notzero-mac-arm64.dmg" --s3-no-check-bucket --s3-chunk-size 64M -q
rclone copyto "$ZIP" "$BUCKET/$ZIPBASE" --s3-no-check-bucket --s3-chunk-size 64M -q
[ -f "$ZIP.blockmap" ] && rclone copyto "$ZIP.blockmap" "$BUCKET/$ZIPBASE.blockmap" --s3-no-check-bucket -q
rclone copyto "$YML" "$BUCKET/latest-mac.yml" --s3-no-check-bucket -q

echo
echo "ok: released."
echo "   download : https://dl.getnotzero.com/notzero-mac-arm64.dmg"
echo "   feed     : https://dl.getnotzero.com/latest-mac.yml  ($ZIPBASE)"
echo "   Bump the version in desktop/package.json before the next release so updates trigger."
