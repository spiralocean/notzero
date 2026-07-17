#!/bin/bash
# Build the node-less NotZero macOS screensaver (.saver) from the command line — no Xcode project.
# It bundles the SAME web canvas the desktop app uses (web/ambient*.html) and loads it via file://,
# so it runs fully self-contained: no server, no node, no network.
set -euo pipefail
cd "$(dirname "$0")"

NAME="NotZero"
OUT="build/$NAME.saver"
CONTENTS="$OUT/Contents"
SDK="$(xcrun --show-sdk-path)"

echo "→ cleaning"
rm -rf "$OUT"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp Info.plist "$CONTENTS/Info.plist"

echo "→ compiling universal (arm64 + x86_64)"
# -emit-library + -Xlinker -bundle → a loadable Mach-O bundle (MH_BUNDLE), which is what a .saver is.
# Build each arch and lipo them so the same .saver runs natively on Apple Silicon AND Intel.
FRAMEWORKS="-framework ScreenSaver -framework WebKit -framework AppKit"
SRC="NotZeroSaverView.swift ConfigSheet.swift"
for ARCH in arm64 x86_64; do
  swiftc -sdk "$SDK" -target "$ARCH-apple-macosx11.0" -module-name "$NAME" -O \
    -emit-library -o "build/$NAME.$ARCH" -Xlinker -bundle $FRAMEWORKS $SRC
done
lipo -create "build/$NAME.arm64" "build/$NAME.x86_64" -output "$CONTENTS/MacOS/$NAME"
rm -f "build/$NAME.arm64" "build/$NAME.x86_64"

echo "→ bundling the web views (loaded via file:// → self-contained)"
cp ../web/ambient.html ../web/ambient-rain.html "$CONTENTS/Resources/"

echo "→ ad-hoc signing (so it loads locally; use a Developer ID + notarization to distribute)"
codesign --force --deep --sign - "$OUT"

echo ""
echo "✓ built $OUT"
file "$CONTENTS/MacOS/$NAME" | sed 's/^/   /'
echo ""
echo "Install locally:"
echo "   cp -R \"$OUT\" ~/Library/Screen\\ Savers/"
echo "   then open  System Settings → Screen Saver → NotZero   (Screen Saver Options… picks Breath / Rain)"
echo "Or just double-click the .saver in Finder to install."
