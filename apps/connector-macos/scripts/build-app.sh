#!/bin/bash
# Builds Multiplayer AI.app and a .dmg someone can drag to Applications.
#
# Developer ID signing and notarisation are a separate, later gate: without that certificate this
# produces a locally signed build, which runs on this Mac and on any Mac where the user allows it
# once. Everything else about the install — no Node, no Terminal, no configuration files — is the
# same as the shipping path.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
connector="$(dirname "$here")"
repo="$(cd "$connector/../.." && pwd)"
name="Multiplayer AI"
# Where a build points when nobody tells it otherwise. Stamped into the bundle so nobody is ever
# asked to type an address; override for a build aimed at a different workspace.
workspace="${MPAI_WORKSPACE_URL:-http://127.0.0.1:4100}"
# The shipping identity by default. A build given a different one keeps its settings and its
# keychain entirely to itself, which is how a verification build runs beside the real app.
bundle_id="${MPAI_BUNDLE_ID:-com.multiplayerai.connector}"
out="$connector/build"
# The repository may live in an iCloud-synced folder, which continuously re-applies
# com.apple.FinderInfo to everything inside it — and codesign refuses to sign over that. The
# bundle is therefore assembled and signed somewhere local, and only the finished disk image
# comes back into the repository, where extended attributes on it are harmless.
work="${TMPDIR:-/tmp}/multiplayer-ai-app-build"
app="$work/$name.app"

echo "• building the background helper"
node "$here/build-sidecar.mjs"

echo "• building the app"
cd "$connector"
swift build -c release --product MultiplayerAI >/dev/null
binary="$(swift build -c release --product MultiplayerAI --show-bin-path)/MultiplayerAI"

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
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- A real application now: it has a window, a Dock icon, and a place in Cmd-Tab. The menu
       bar is still there, but as somewhere to glance rather than as the whole product. -->
  <key>MPAIWorkspaceURL</key><string>$workspace</string>
  <!-- Sign-in links open the app rather than a browser, so signing in stays inside it. -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.multiplayerai.signin</string>
      <key>CFBundleURLSchemes</key><array><string>multiplayerai</string></array>
    </dict>
  </array>
  <!-- A workspace on your own machine or your own network is reached over plain HTTP. Only
       that is allowed; this is not a blanket exemption. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
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
  # Hardened Runtime even here, so a local build fails the same way a shipped one would.
  # Without it the helper's JIT problem is invisible until after notarisation, which is to say
  # until it is already in front of external users.
  sign=(codesign --force --options runtime --sign -)
fi
# macOS keeps re-applying com.apple.provenance to files as the build touches them, and codesign
# refuses to sign over it. Clearing immediately before each attempt usually wins the race; a
# couple of retries make it reliable rather than occasionally red.
sign_path() {
  local target="$1" entitlements="${2:-}"
  local -a args=("${sign[@]}")
  [ -n "$entitlements" ] && args+=(--entitlements "$entitlements")
  for attempt in 1 2 3; do
    xattr -cr "$app" 2>/dev/null || true
    if "${args[@]}" "$target" 2>/tmp/mpai-codesign.err; then return 0; fi
  done
  # The last error is what matters, and hiding it turns a one-line fix into an afternoon.
  echo "  could not sign $target" >&2
  sed 's/^/    /' /tmp/mpai-codesign.err >&2 2>/dev/null || true
  return 1
}

# Nested code first, so the outer signature covers a settled inside.
#
# The helper is a Node single-file executable, so it carries V8, and V8 writes machine code at
# runtime. Hardened Runtime forbids that: signed with --options runtime and no entitlement, the
# helper dies with SIGTRAP the instant it starts. Notarisation would pass, the app would install
# cleanly, and every external user's agent would simply never connect. sidecar.entitlements grants
# the one thing that fixes it and nothing else — allow-unsigned-executable-memory was tested and
# makes no difference here, and a weaker runtime that buys nothing is not worth shipping.
#
# That file has no comments in it on purpose: the entitlements parser rejects XML comments outright
# ("AMFIUnserializeXML: syntax error"), which fails signing rather than being ignored.
sign_path "$app/Contents/Resources/mpai-connector-sidecar" "$here/sidecar.entitlements"
sign_path "$app"

xattr -cr "$app"
codesign --verify --deep --strict --verbose=2 "$app" && echo "  signature verifies"

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
