#!/usr/bin/env bash
# promote-release.sh — make a STAGED release live.   usage: promote-release.sh <version>
#
# A real release no longer goes live when it is built. CI uploads the versioned installers (which nothing points
# at) and STAGES everything that makes a release visible under staged/<version>/ in the bucket:
#     latest-mac.yml  latest.yml  latest-linux.yml        the updater feeds — what every install polls
#     notzero-mac.dmg  notzero-win.exe  notzero-linux.AppImage   the website's download buttons
#     SHA256SUMS                                           the stable checksum list
#     CHANGELOG.md                                         in-app "what's new" + the VERIFIED UPDATES list
# This script moves them into place. upgrade-timestamps.yml runs it by itself once the release's OpenTimestamps
# proof has confirmed in a Bitcoin block, so an update reaches users already on-chain. Run it by hand (the same
# workflow's "promote_now" input) to send a HOTFIX out before then — the app holds such an update and offers
# "install now" (desktop/update-hold.js).
#
# Feeds go LAST: they are the switch. Everything a feed or the website points at is in place before it flips.
#
# Needs rclone with an `r2` remote (or the RCLONE_CONFIG_R2_* env the workflows set).
set -euo pipefail
VER="${1:?usage: promote-release.sh <version>}"
BUCKET="${R2_BUCKET:-r2:notzero-dl}"
SRC="$BUCKET/staged/$VER"
FEEDS="latest-mac.yml latest.yml latest-linux.yml"
INSTALLERS="notzero-mac.dmg notzero-win.exe notzero-linux.AppImage"

# all of it or none of it: a release that published two platforms out of three is the thing the release
# workflow's `needs:` exists to prevent, and promoting a partial stage would bring it back
have="$(rclone lsf "$SRC" 2>/dev/null || true)"
for f in $FEEDS $INSTALLERS SHA256SUMS CHANGELOG.md; do
  grep -qxF "$f" <<<"$have" || { echo "x staged/$VER has no $f — refusing to promote a partial release" >&2; exit 1; }
done

# never move the feeds BACKWARDS (an older stage promoted after a newer hotfix went out by hand)
live="$(rclone cat "$BUCKET/latest-linux.yml" 2>/dev/null | sed -n 's/^version: *//p' | tr -d '\r' | head -1)"
if [ -n "$live" ] && [ "$live" != "$VER" ] && [ "$(printf '%s\n%s\n' "$live" "$VER" | sort -V | tail -1)" = "$live" ]; then
  echo "x live is already $live, newer than $VER — refusing to move the feeds backwards" >&2; exit 1
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
echo "-> fetching staged/$VER ..."
rclone copy "$SRC" . --s3-no-check-bucket -q
# the proof comes from the versioned copy, not the stage: that is the one upgrade-timestamps.yml upgrades, so
# by now it carries the Bitcoin attestation the staged (pending) one never will
rclone copyto "$BUCKET/SHA256SUMS-$VER.ots" SHA256SUMS.ots --s3-no-check-bucket -q

# what we are about to put behind the download buttons must be what was timestamped
rclone copyto "$BUCKET/SHA256SUMS-$VER" SHA256SUMS.anchored --s3-no-check-bucket -q
cmp -s SHA256SUMS SHA256SUMS.anchored || { echo "x staged SHA256SUMS differs from the anchored SHA256SUMS-$VER" >&2; exit 1; }
SHA="sha256sum"; command -v sha256sum >/dev/null || SHA="shasum -a 256"   # CI is Linux; a mac run by hand has shasum
$SHA --ignore-missing -c SHA256SUMS   # the mac .zip is listed but lives at its versioned url, not in the stage

echo "-> publishing $VER ..."
for f in $INSTALLERS; do rclone copyto "$f" "$BUCKET/$f" --s3-no-check-bucket --s3-chunk-size 64M --header-upload "Cache-Control: no-cache" -q; done
rclone copyto SHA256SUMS     "$BUCKET/SHA256SUMS"     --s3-no-check-bucket --header-upload "Cache-Control: no-cache" -q
rclone copyto SHA256SUMS.ots "$BUCKET/SHA256SUMS.ots" --s3-no-check-bucket --header-upload "Cache-Control: no-cache" -q
rclone copyto CHANGELOG.md   "$BUCKET/CHANGELOG.md"   --s3-no-check-bucket --header-upload "Cache-Control: public, max-age=300" -q
for f in $FEEDS; do rclone copyto "$f" "$BUCKET/$f" --s3-no-check-bucket --header-upload "Cache-Control: no-cache" -q; done

rclone purge "$SRC" -q
echo "ok: notzero $VER is live."
for f in $FEEDS; do printf '   %-17s ' "$f"; curl -fsS "https://dl.getnotzero.com/$f" | sed -n 's/^version: *//p' | head -1 || echo "(couldn't read it back)"; done
