# Multiplayer AI (macOS)

One application. The window is the product; the menu bar is somewhere to glance at it; the half
that keeps this Mac's agent connected runs inside the same process. The normal path is: open it,
watch it set itself up, sign in, name your workspace, name the agent you already run, make a room
— and you are in the workspace. No Terminal, no Node install, no configuration file, no `chmod`,
no shell, and no enrollment code.

## The first run

Which screen you get is read from what is actually true — the session the workspace honours, what
the workspace contains, and what this Mac holds — never from a step counter. Quitting halfway
through and coming back lands exactly where you left off, and a returning launch goes straight to
the room you were last in.

```
                    ┌─ nothing set up here ──────→ Launch → Setting up
GET /v1/auth/me ────┤
                    ├─ signed out ───────────────→ Sign in
                    └─ signed in ─┬─ no workspace → Name your workspace
                                  ├─ no agent ────→ Connect your existing agent
                                  ├─ no room ─────→ Where should it work?
                                  ├─ not bound ───→ (binds itself, asks nothing)
                                  └─ ready ───────→ the workspace
```

Anything that stops being true routes to the one step that fixes it, never back to the start: an
expired session asks only for a sign-in, an agent somebody removed asks only for an agent, and a
credential macOS will not release gets its own screen rather than being mistaken for a Mac that
was never set up.

**Binding needs no code.** The person is signed in *in this app*, on the machine the agent runs
on, so the app asks the workspace for this agent's credential directly and puts it in the
Keychain. Enrollment codes remain for the case where that is not true — a Mac nobody is signed in
on — and for recovery.

**Join an existing room is deliberately absent.** Being invited into somebody else's workspace is
not a thing the backend can express yet. The room screen is built around a list of choices so Join
takes its place beside Create the day it becomes real; it does not show a door that opens onto
nothing.

## How it is put together

Two pieces, with a deliberate split:

- **The app** (`Sources/MultiplayerAI`, `Sources/ConnectorUI`) — a SwiftUI application with a
  window and a `MenuBarExtra`. It owns the first-run journey, the Keychain, the workspace address,
  what is shown, and the helper's lifetime. The workspace itself is the existing web product in a
  `WKWebView`; none of it is reimplemented here.
- **The helper** (`sidecar/sidecar.mjs`) — the connector core and the Hermes adapter that the rest
  of the product already uses, built into a Node single-executable so nobody has to install Node.
  The app spawns it and talks to it over stdin/stdout in JSON lines.

The helper is also the command surface Hermes itself calls (`sidecar message …`). Those calls use
the room-scoped session, never the machine credential.

### Where the product lives

The room, Home, presence, tasks, dependencies, Needs You, approvals, pause/resume and reassign are
the web product, loaded from the workspace origin in a `WKWebView`. Signing in happens natively,
so the session cookie is copied into the web view before the workspace loads — one signed-in
person, not two. Links out of the product open in a browser rather than replacing the workspace
inside the window, and the product's own signed-out pages hand back to the native side so there is
only ever one place to sign in.

### Where the credential lives

In the Keychain, under this bundle's own identifier, written once when this Mac is bound and read
only to hand to the helper at startup. It is
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

While the workspace is open, none of this is shown unless something is wrong: a connected agent is
not worth interrupting anybody about, and everything else appears as a banner over the product
naming what stopped and what to do.

A live connection says nothing about whether Hermes is installed, which is why a Mac with no
Hermes still reads `Workspace: Connected` while the headline says `Runtime unavailable`.

Identifiers, cursors, session IDs, and file paths appear only in **Advanced Diagnostics**, which
has to be opened on purpose. Even there, the credential and session token are deliberately absent.

## Building

```
apps/connector-macos/scripts/build-app.sh
```

Produces `build/Multiplayer AI.dmg`. `MPAI_WORKSPACE_URL` stamps the workspace a build points at,
so nobody is asked to type an address; `MPAI_BUNDLE_ID` gives a build its own identity, settings,
keychain item and helper state, which is how a verification build runs beside the real app. The bundle is assembled outside the repository,
because the repository may sit in an iCloud-synced folder that keeps re-applying extended
attributes that `codesign` refuses to sign over.

**Signing.** If a Developer ID Application certificate is present it is used; otherwise the build
is signed locally so it runs on this Mac. Notarisation remains gated on that certificate — set
`CONNECTOR_SIGNING_IDENTITY` to choose an identity explicitly.

## Private technical beta installation

Private beta builds may be distributed with ad-hoc signing and without Apple notarisation. This is
a known distribution limitation, not a reason to weaken the Connector's credential, enrollment, or
Gateway security behavior.

1. Move **Multiplayer AI.app** to `/Applications`.
2. On first launch, macOS may say the app “cannot be verified.” Right-click the app and choose
   **Open**, then confirm **Open**. If macOS still blocks it, open **System Settings → Privacy &
   Security** and choose **Open Anyway** for Multiplayer AI.
3. Follow the setup the app runs. Do not copy credentials into files or bypass its Keychain
   storage.
4. An ad-hoc signed upgrade can have a different signing identity. If Keychain no longer recognizes
   the upgraded app as the same client, sign out if the previous build is still accessible, request
   a fresh one-time enrollment code, and enroll again. Do not migrate or export the stored
   credential manually.

Developer ID signing and notarisation remain required before public distribution, but they do not
block this private technical beta.

## Checking it

```
swift test                                                      # what the app may claim
MPAI_API_LOG=… scripts/verify-shell.sh <workspace-url>          # the whole first run, for real
DATABASE_URL=… HERMES_STUB=… node scripts/verify-connector.mjs  # the helper against a live workspace
swift run ConnectorPreviews <dir>                               # render the real views to PNGs
```

`verify-shell.sh` walks the shipping `AppModel` through a real first run against a real workspace:
launch, automatic setup, Hermes detected, sign in, workspace, agent, room, binding with no code,
the agent appearing in the workspace, the product rendering signed-in inside a web view, and a
relaunch returning to the same room. It runs in a bundle of its own so it can never touch the
credential belonging to the app you actually use.

The workspace it is pointed at must not mark its session cookie `Secure` while being served over
plain HTTP (`AUTH_COOKIE_SECURE=0`), or nothing can hold a session against it — the app says so in
those words rather than looking like a link that did not work.

`verify-connector.mjs` drives the shipped helper binary against a running workspace over the same
Gateway routes the product uses: Hermes missing and present, a valid code, an unrecognised code,
a code reused, connecting, disconnecting, an unreachable workspace, a revoked credential, signing
out, and that nothing secret reaches the log.
