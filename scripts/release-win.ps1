# release-win.ps1 — build the Windows NSIS installer and publish it to R2 (dl.getnotzero.com).
# The Windows analogue of release-mac.sh. No signing/notarization (ships unsigned → SmartScreen
# "More info → Run anyway"); add signtool here if a code-signing cert is ever bought.
#
# Requires on the machine:
#   - Node + npm, Python 3.9+ with PyInstaller  (the engines are PyInstaller binaries built on Windows;
#     build-engines.sh is macOS-only, so this builds them directly)
#   - rclone with an 'r2' remote pointing at the notzero-dl bucket (same remote release-mac.sh uses)
#
# Publishes (stable URLs, re-uploaded each release → Cache-Control: no-cache so the CDN serves the latest):
#   notzero-win.exe          the download (site link) AND the electron-updater target
#   notzero-win.exe.blockmap delta-update map
#   latest.yml               the electron-updater feed (references notzero-win.exe)
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

# 2) installer (electron-builder reads win.artifactName = notzero-win.${ext}); produces notzero-win.exe + latest.yml
Write-Host "-> building NSIS installer..."
Push-Location $DESKTOP
npx electron-builder --win
Pop-Location

$exe = Join-Path $DIST "notzero-win.exe"
$blockmap = "$exe.blockmap"
$yml = Join-Path $DIST "latest.yml"
foreach ($f in @($exe, $yml)) { if (-not (Test-Path $f)) { throw "missing build artifact: $f" } }

# 3) publish to R2
Write-Host "-> uploading to $BUCKET ..."
rclone copyto $exe "$BUCKET/notzero-win.exe" --s3-no-check-bucket --s3-chunk-size 64M --header-upload "Cache-Control: no-cache" -q
if (Test-Path $blockmap) { rclone copyto $blockmap "$BUCKET/notzero-win.exe.blockmap" --s3-no-check-bucket -q }
rclone copyto $yml "$BUCKET/latest.yml" --s3-no-check-bucket --header-upload "Cache-Control: no-cache" -q

Write-Host ""
Write-Host "ok: released notzero-win $VERSION"
Write-Host "   download : https://dl.getnotzero.com/notzero-win.exe"
Write-Host "   feed     : https://dl.getnotzero.com/latest.yml"
