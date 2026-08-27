# Multiplayer AI Connector (macOS)

Brings an agent on this Mac into a Multiplayer AI workspace. The normal path is: install, enter
the code from your workspace, see Hermes detected, press Connect. No Terminal, no Node install,
no configuration file, no `chmod`, no shell.

## How it is put together

Two pieces, with a deliberate split:

- **The app** (`Sources/MultiplayerAIConnector`, `Sources/ConnectorUI`) — a SwiftUI menu bar app.
  It owns the Keychain, the enrolment code entry, what is shown, and the helper's lifetime.
- **The helper** (`sidecar/sidecar.mjs`) — the connector core and the Hermes adapter that the rest
  of the product already uses, built into a Node single-executable so nobody has to install Node.
  The app spawns it and talks to it over stdin/stdout in JSON lines.

The helper is also the command surface Hermes itself calls (`sidecar message …`). Those calls use
the room-scoped session, never the machine credential.

### Where the credential lives

In the Keychain, written once at enrolment, read only to hand to the helper at startup. It is
never written to a file, never passed on a command line, and never shown. Signing out deletes it
along with the connector's durable room state, so nothing is left that could reconnect.

### What `launchd` does, and does not, do

`launchd` starts the app at login and after a restart, via `SMAppService`. That is all it does.
The app supervises its own helper and restarts it with a backoff if it dies.

Recovering a dropped network connection is the connector's own business and stays inside it: it
already resumes a room from where it left off, and bouncing the process to fix a blip would throw
that away.

### The four things it knows, kept apart

The app never lets one of these stand in for another:

| Row         | What it means                                              |
| ----------- | ---------------------------------------------------------- |
| Workspace   | what the Gateway connection is actually doing               |
| Hermes      | whether the runtime is installed and usable on this Mac     |
| Room        | how much of the room has been read, and what is still queued |
| Connector   | whether the local helper process is alive                    |

A live connection says nothing about whether Hermes is installed, which is why a Mac with no
Hermes still reads `Workspace: Connected` while the headline says `Runtime unavailable`.

Identifiers, cursors, session IDs, and file paths appear only in **Advanced Diagnostics**, which
has to be opened on purpose. Even there, the credential and session token are deliberately absent.

## Building

```
apps/connector-macos/scripts/build-app.sh
```

Produces `build/Multiplayer AI Connector.dmg`. The bundle is assembled outside the repository,
because the repository may sit in an iCloud-synced folder that keeps re-applying extended
attributes that `codesign` refuses to sign over.

**Signing.** If a Developer ID Application certificate is present it is used; otherwise the build
is signed locally so it runs on this Mac. Notarisation remains gated on that certificate — set
`CONNECTOR_SIGNING_IDENTITY` to choose an identity explicitly.

## Checking it

```
swift test                                                   # what the app may claim
DATABASE_URL=… HERMES_STUB=… node scripts/verify-connector.mjs  # the helper against a live workspace
swift run ConnectorPreviews <dir>                            # render the real views to PNGs
```

`verify-connector.mjs` drives the shipped helper binary against a running workspace over the same
Gateway routes the product uses: Hermes missing and present, a valid code, an unrecognised code,
a code reused, connecting, disconnecting, an unreachable workspace, a revoked credential, signing
out, and that nothing secret reaches the log.
