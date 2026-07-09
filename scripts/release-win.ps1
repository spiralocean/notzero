# release-win.ps1 — build the Windows NSIS installer and publish it to R2 (dl.getnotzero.com).
# The Windows analogue of release-mac.sh. No signing/notarization (ships unsigned → SmartScreen
# "More info → Run anyway"); add signtool here if a code-signing cert is ever bought.
#
# Requires on the machine:
#   - Node + npm, Python 3.9+ with PyInstaller  (the engines are PyInstaller binaries built on Windows;
#     build-engines.sh is macOS-only, so this builds them directly)
#   - rclone with an 'r2' remote pointing at the notzero-dl bucket (same remote release-mac.sh uses)
#
# Publishes (mirrors release-mac.sh — versioned installer is immutable/cacheable; the feed + the website
# alias are stable URLs that change each release, so they upload Cache-Control: no-cache):
#   notzero-${version}-win.exe          the electron-updater target (version-specific URL → cache forever)
#   notzero-${version}-win.exe.blockmap delta-update map (version-specific → cacheable)
#   latest.yml                          the electron-updater feed (references the versioned exe) → no-cache
#   notzero-win.exe                     stable alias for the website download button only → no-cache
#                                       (cache-ruled fresh; the updater never uses this URL)
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
$DESKTOP = Join-Path $ROOT "desktop"
$DIST = Join-Path $DESKTOP "dist"
$RES = Join-Path $DESKTOP "resources"
$BUCKET = if ($env:R2_BUCKET) { $env:R2_BUCKET } else { "r2:notzero-dl" }
$VERSION = (Get-Content (Join-Path $DESKTOP "package.json") -Raw | ConvertFrom-Json).version
Write-Host "-> releasing notzero-win $VERSION to $BUCKET"

# 1) engines: miner.exe + bridge.exe (onefile, no Python needed on the user's machine).
#    SKIP_BLOCK_VERIFY equivalent: we don't gate on a node here; the macOS release does the validity gate.
Write-Host "-> building engines (PyInstaller)..."
Push-Location $ROOT
python -m PyInstaller --onefile --clean --noconfirm --name miner  --distpath $RES lottery_miner.py | Out-Null
python -m PyInstaller --onefile --clean --noconfirm --name bridge --paths . --hidden-import lottery_miner --distpath $RES scripts/node_bridge.py | Out-Null
Pop-Location
if (-not (Test-Path (Join-Path $RES "miner.exe")) -or -not (Test-Path (Join-Path $RES "bridge.exe"))) { throw "engine build failed" }

# 2) installer (electron-builder reads win.artifactName = notzero-${version}-win.${ext});
#    produces notzero-$VERSION-win.exe + latest.yml (the feed references the versioned exe)
Write-Host "-> building NSIS installer..."
Push-Location $DESKTOP
npx electron-builder --win
Pop-Location

$exe = Join-Path $DIST "notzero-$VERSION-win.exe"
$blockmap = "$exe.blockmap"
$yml = Join-Path $DIST "latest.yml"
foreach ($f in @($exe, $yml)) { if (-not (Test-Path $f)) { throw "missing build artifact: $f" } }

# gate: refuse to publish a package missing a required local module (see 0.1.30 postmortem)
Write-Host "-> verifying the packaged app.asar contains every required module..."
node (Join-Path $ROOT "scripts\check-asar-requires.cjs")
if ($LASTEXITCODE -ne 0) { throw "asar require check FAILED — refusing to publish a broken build" }

# 3) publish to R2 (skipped on a dry run — build-only validation)
if ($env:DRY_RUN -eq "1") {
  Write-Host "-> DRY RUN — built notzero-$VERSION-win.exe (+ latest.yml), skipping R2 upload."
  exit 0
}
Write-Host "-> uploading to $BUCKET ..."
# versioned installer + blockmap → version-specific (immutable) URLs, fine to cache at the edge
rclone copyto $exe "$BUCKET/notzero-$VERSION-win.exe" --s3-no-check-bucket --s3-chunk-size 64M -q
if (Test-Path $blockmap) { rclone copyto $blockmap "$BUCKET/notzero-$VERSION-win.exe.blockmap" --s3-no-check-bucket -q }
# feed (references the versioned exe) → stable URL, no-cache so the CDN always serves the latest
rclone copyto $yml "$BUCKET/latest.yml" --s3-no-check-bucket --header-upload "Cache-Control: no-cache" -q
# stable alias for the website download button → no-cache (cache-ruled fresh); the updater does NOT use this
rclone copyto $exe "$BUCKET/notzero-win.exe" --s3-no-check-bucket --s3-chunk-size 64M --header-upload "Cache-Control: no-cache" -q

Write-Host ""
Write-Host "ok: released notzero-win $VERSION"
Write-Host "   download : https://dl.getnotzero.com/notzero-win.exe          (stable, website button)"
Write-Host "   updater  : https://dl.getnotzero.com/notzero-$VERSION-win.exe (versioned, cacheable)"
Write-Host "   feed     : https://dl.getnotzero.com/latest.yml"
