#!/bin/bash
# Turn a built app into one an external user can open.
#
# Gatekeeper rejects the ad-hoc signed build, and rightly: an ad-hoc signature says nothing about
# who made it. Getting past that is not one step but five, in an order that cannot be varied —
# sign inside-out, verify, put the signed app in a disk image, notarise the image, staple the
# ticket to it. Skip the stapling and the first person to open it on a machine with no network
# gets the same rejection the whole exercise was meant to remove.
#
# Nothing secret lives here. The certificate stays in the login keychain and the notary
# credentials in a keychain profile; this reads names, never values, and prints neither.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
connector="$(dirname "$here")"
name="Multiplayer AI"
out="$connector/build"
dmg="$out/$name.dmg"

identity="${CONNECTOR_SIGNING_IDENTITY:-}"
profile="${NOTARY_PROFILE:-multiplayer-ai}"

step() { printf '\n• %s\n' "$1"; }
die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
step "checking what this machine can do"
[ -n "$identity" ] || identity="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"' || true)"
[ -n "$identity" ] || die "No Developer ID Application certificate in the keychain.
  Install it from the Apple Developer account that owns the app, or set
  CONNECTOR_SIGNING_IDENTITY to its exact name. An Apple Development certificate is not
  the same thing and cannot be notarised."
echo "  signing identity: $identity"

xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1 || die \
"No notary credentials stored under the keychain profile '$profile'.
  Create it once, on this machine, with your own Apple ID:

    xcrun notarytool store-credentials \"$profile\" \\
      --apple-id <your-apple-id> --team-id WP7F3WZ7DE \\
      --password <app-specific-password>

  The password is generated at appleid.apple.com and is not a normal account password.
  It is stored in the keychain; nothing in this repository ever reads it."
echo "  notary profile:   $profile"

[ -f "$dmg" ] || die "No disk image at $dmg — run scripts/build-app.sh first."

# ---------------------------------------------------------------- verify what actually ships
# The app is signed inside build-app.sh and only the image comes back, so the copy inside the
# image is the one to inspect: it is the one a person will drag to Applications.
step "verifying the signature on the app inside the image"
inspect="$(mktemp -d /tmp/mpai-inspect-XXXX)"
hdiutil attach -nobrowse -quiet -readonly "$dmg" -mountpoint "$inspect"
inspect_app="$inspect/$name.app"
verify_failed=0
codesign --verify --deep --strict --verbose=2 "$inspect_app" || verify_failed=1
authority="$(codesign --display --verbose=2 "$inspect_app" 2>&1 | grep '^Authority=' | head -1 || true)"
runtime_flag="$(codesign --display --verbose=2 "$inspect_app" 2>&1 | grep -c 'flags=.*runtime' || true)"
entitled=0
codesign --display --entitlements - "$inspect_app/Contents/Resources/mpai-connector-sidecar" 2>/dev/null \
  | grep -q "allow-jit" && entitled=1
hdiutil detach "$inspect" -quiet

[ "$verify_failed" -eq 0 ] || die "The app inside the image does not verify."
case "$authority" in
  *"Developer ID Application"*) echo "  $authority" ;;
  *) die "The app inside the image is not signed with a Developer ID.
  It says: ${authority:-<no authority>}
  Rebuild with CONNECTOR_SIGNING_IDENTITY set, then run this again. An ad-hoc signature is
  exactly what Gatekeeper is rejecting." ;;
esac
[ "$runtime_flag" -gt 0 ] || die "The app is not signed with Hardened Runtime (--options runtime).
  Apple will refuse to notarise it."
[ "$entitled" -eq 1 ] || die \
"The background helper is not signed with com.apple.security.cs.allow-jit.
  It carries V8, which writes machine code at runtime; under Hardened Runtime it is killed
  with SIGTRAP the moment it starts. The app would notarise perfectly, install perfectly,
  and then never connect for anybody."
echo "  Hardened Runtime on, helper entitled to JIT"

# ---------------------------------------------------------------- the disk image
step "signing the disk image"
codesign --force --timestamp --sign "$identity" "$dmg"
codesign --verify --strict --verbose=2 "$dmg"

# ---------------------------------------------------------------- notarise and staple
step "submitting to Apple (this waits, and can take a few minutes)"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait

step "stapling the ticket"
# Stapled to the image, so a machine that is offline the first time it opens this still passes.
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"

# ---------------------------------------------------------------- prove it to Gatekeeper
step "asking Gatekeeper what it makes of the result"
mount="$(mktemp -d /tmp/mpai-release-XXXX)"
hdiutil attach -nobrowse -quiet -readonly "$dmg" -mountpoint "$mount"
trap 'hdiutil detach "$mount" -quiet 2>/dev/null || true' EXIT
spctl --assess --type execute --verbose=4 "$mount/$name.app"
codesign --verify --deep --strict --verbose=2 "$mount/$name.app"

printf '\n✓ %s is signed, notarised, stapled, and accepted by Gatekeeper\n' "$name"
shasum -a 256 "$dmg" | sed 's/^/  sha256 /'
printf '  Publish with: pnpm deploy:site\n'
