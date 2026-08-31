#!/bin/bash
# Walks the unified app through a real first run against a real workspace.
#
# The harness is wrapped in an app bundle of its own — its own identifier, so its own settings
# and its own keychain item — because it signs a Mac in and out for real, and must never be able
# to disturb the Multiplayer AI someone is actually using.
#
#   scripts/verify-shell.sh [workspace-url]
#
# The workspace must be reachable and must not set a Secure session cookie over plain HTTP
# (AUTH_COOKIE_SECURE=0), or nothing can hold a session against it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
connector="$(dirname "$here")"
repo="$(cd "$connector/../.." && pwd)"
base="${1:-http://127.0.0.1:4100}"
work="${TMPDIR:-/tmp}/multiplayer-ai-verify-shell"
app="$work/Verify.app"

echo "• workspace: $base"
curl -sf -m 5 "$base/health" >/dev/null || { echo "  the workspace is not answering at $base" >&2; exit 1; }

echo "• building the helper and the harness"
node "$here/build-sidecar.mjs" >/dev/null
cd "$connector"
swift build -c release --product VerifyShell >/dev/null
binary="$(swift build -c release --product VerifyShell --show-bin-path)/VerifyShell"

echo "• assembling an isolated bundle"
rm -rf "$work"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/Verify"
cp "$connector/build/mpai-connector-sidecar" "$app/Contents/Resources/mpai-connector-sidecar"
chmod +x "$app/Contents/Resources/mpai-connector-sidecar"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Verify</string>
  <key>CFBundleIdentifier</key><string>com.multiplayerai.verify-shell</string>
  <key>CFBundleExecutable</key><string>Verify</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>MPAIWorkspaceURL</key><string>$base</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
# A first launch means a Mac with nothing on it. The helper's own directory is keyed to this
# bundle, so removing it cannot touch the app someone is actually using.
rm -rf "$HOME/Library/Application Support/Multiplayer AI (com.multiplayerai.verify-shell)"

xattr -cr "$app" 2>/dev/null || true
codesign --force --sign - "$app/Contents/Resources/mpai-connector-sidecar" 2>/dev/null || true
codesign --force --sign - "$app" 2>/dev/null || true

echo "• creating an account to walk through with"
email="verify+$(date +%s)@example.com"
curl -sf -X POST "$base/v1/auth/sign-up" -H 'content-type: application/json' \
  -d "{\"name\":\"Verification\",\"email\":\"$email\"}" >/dev/null

# The developer beta has no email transport: the workspace logs the link for its operator, and
# this reads it from the same place a person would be given it. The day delivery is real, this
# is the only line here that changes.
log="${MPAI_API_LOG:-}"
if [ -z "$log" ] || [ ! -f "$log" ]; then
  echo "  set MPAI_API_LOG to the workspace's log so the sign-in link can be read" >&2
  exit 1
fi
token=""
for _ in 1 2 3 4 5; do
  token="$(grep "sign-in token for $email" "$log" | tail -1 | sed 's/.*: //' || true)"
  [ -n "$token" ] && break
  sleep 1
done
[ -n "$token" ] || { echo "  no sign-in link was issued for $email" >&2; exit 1; }

echo "• walking the first run"
"$app/Contents/MacOS/Verify" "$base" "$token"
