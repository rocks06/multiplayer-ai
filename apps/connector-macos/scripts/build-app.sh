#!/bin/bash
# Builds Multiplayer AI Connector.app and a .dmg someone can drag to Applications.
#
# Developer ID signing and notarisation are a separate, later gate: without that certificate this
# produces a locally signed build, which runs on this Mac and on any Mac where the user allows it
# once. Everything else about the install — no Node, no Terminal, no configuration files — is the
# same as the shipping path.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
connector="$(dirname "$here")"
repo="$(cd "$connector/../.." && pwd)"
name="Multiplayer AI Connector"
out="$connector/build"
# The repository may live in an iCloud-synced folder, which continuously re-applies
# com.apple.FinderInfo to everything inside it — and codesign refuses to sign over that. The
# bundle is therefore assembled and signed somewhere local, and only the finished disk image
# comes back into the repository, where extended attributes on it are harmless.
work="${TMPDIR:-/tmp}/multiplayer-ai-connector-build"
app="$work/$name.app"

echo "• building the connector helper"
node "$here/build-sidecar.mjs"

echo "• building the app"
cd "$connector"
swift build -c release --product MultiplayerAIConnector >/dev/null
binary="$(swift build -c release --product MultiplayerAIConnector --show-bin-path)/MultiplayerAIConnector"

echo "• assembling the bundle"
rm -rf "$work"
mkdir -p "$work"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/$name"
cp "$out/mpai-connector-sidecar" "$app/Contents/Resources/mpai-connector-sidecar"
chmod +x "$app/Contents/Resources/mpai-connector-sidecar"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>com.multiplayerai.connector</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- A menu bar app: no Dock icon, no window taking over the screen. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

echo "• signing"
# Copying leaves extended attributes behind, which codesign refuses to sign over.
xattr -cr "$app"

identity="${CONNECTOR_SIGNING_IDENTITY:-}"
if [ -z "$identity" ]; then
  # Prefer a real Developer ID when one exists; otherwise sign locally so macOS will run it.
  # No Developer ID on this machine is the expected case for now, not a build failure.
  identity="$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"' || true)"
fi
if [ -n "$identity" ]; then
  echo "  using: $identity"
  sign=(codesign --force --options runtime --timestamp --sign "$identity")
else
  echo "  no Developer ID certificate found — signing locally (notarisation still gated)"
  sign=(codesign --force --sign -)
fi
# macOS keeps re-applying com.apple.provenance to files as the build touches them, and codesign
# refuses to sign over it. Clearing immediately before each attempt usually wins the race; a
# couple of retries make it reliable rather than occasionally red.
sign_path() {
  local target="$1"
  for attempt in 1 2 3; do
    xattr -cr "$app" 2>/dev/null || true
    if "${sign[@]}" "$target" 2>/dev/null; then return 0; fi
  done
  echo "  could not sign $target" >&2
  return 1
}

# Nested code first, so the outer signature covers a settled inside.
sign_path "$app/Contents/Resources/mpai-connector-sidecar"
sign_path "$app"

xattr -cr "$app"
codesign --verify --deep --strict "$app" && echo "  signature verifies"

echo "• building the disk image"
staging="$work/dmg"
rm -rf "$staging"
mkdir -p "$staging" "$out"
cp -R "$app" "$staging/"
ln -s /Applications "$staging/Applications"
hdiutil create -volname "$name" -srcfolder "$staging" -ov -format UDZO "$work/$name.dmg" >/dev/null
rm -rf "$staging"
# The app inside the image is already sealed, so copying the image itself is safe.
cp "$work/$name.dmg" "$out/$name.dmg"

echo "✓ $app"
echo "✓ $out/$name.dmg ($(du -h "$out/$name.dmg" | cut -f1))"
