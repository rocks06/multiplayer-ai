# Native discovery and helper connection fix

## Scope

This slice changes native onboarding, helper startup/IPC diagnostics, adapter-owned discovery and authenticated lookup of an existing runtime binding. Mentions and multi-room work are excluded. No schema migration is added.

Detection opens a **Detect Agent** sheet immediately. The sheet shows scanning, selectable runtime/profile cards, an explicit empty state and Retry. **Advanced / Connect with code** remains available. A signed-in workspace user selects a discovered runtime and room; known runtime bindings supply the existing principal/name, otherwise a display name is requested. Membership and machine credentials use the existing authenticated APIs. Detection, helper startup and socket-open do not imply Connected: authenticated `session.ready` must reach the connector's `live` state.

## Startup diagnosis boundary

The prior synchronous runtime probes could block unrelated helper IPC. Isolated archived-helper versus candidate testing with a stalled status command reproduced this problem. The candidate uses bounded asynchronous subprocess probes. Native diagnostics now retain launch errors, process exit/status classification, IPC EOF/schema failures and request timeouts independently of helper diagnostics replies. Stderr is drained to avoid pipe backpressure; arbitrary stderr is not exposed.

The helper build also rejects non-system dynamic dependencies in its Node SEA runtime. Use a standalone macOS Node binary through `MPAI_NODE_BINARY`. This prevents shipping a helper that depends on the build machine's Homebrew libraries.

These are automated local findings, not a claim that the physical MacBook Air's exact launch failure has been captured or its acceptance passed.

## Verification contracts

- `pnpm test`: complete main suite; includes authenticated code-free fresh-user binding, selected-room membership, credential/session creation and reuse without duplicate principals/credentials, runtime lookup authorization and real WebSocket `session.ready` gating.
- `pnpm typecheck` and `pnpm build`.
- Build the helper from that server output using `MPAI_NODE_BINARY=<standalone-node> node apps/connector-macos/scripts/build-sidecar.mjs`.
- `python3 scripts/verify-helper-discovery.py <absolute-built-helper>`: executes the actual bundled helper with isolated support/identity directories, a synthetic running runtime/profile and a loopback enrollment fixture. Exercises discovery/selection without code, configure/relaunch identity restoration, manual enrollment and no-agent state. The fixture explicitly answers `--version`, `status`, and `gateway status`; it does not invoke a model or represent a physical gateway.
- From `apps/connector-macos`, `MPAI_TEST_SIDECAR=<absolute-built-helper> swift test`: native state/upgrade tests plus startup/IPC failure, timeout, stderr-backpressure, process fencing and real bundled-helper protocol checks.

Use only disposable PostgreSQL databases for integration tests: the suite truncates its test data. Node environments with experimental Web Storage may require the command-local `NODE_OPTIONS=--no-experimental-webstorage` compatibility flag.

## Rollout

**Render/backend deployment is required** for the authenticated runtime-connection GET lookup and updated web entry labels. **A new connector app/DMG is required** for the native sheet, IPC handling and bundled helper. No database migration is required. Installing the update must preserve Application Support, Keychain, Hermes configuration and durable connector/runtime identity storage. Backend deployment alone cannot update the installed helper.

Physical Air reconnect and generated-file/native Preview/Download acceptance remain separate release checks. Automated fixtures do not establish real-model execution or physical-device acceptance.

## Named Hermes profile discovery identity

Named profiles use `hermes:profile:<sha256>` discovery IDs derived read-only from the profile directory's filesystem object identity: device (`dev`), inode (`ino`), and creation time (`birthtimeNs`), read using bigint stat precision. Names and paths are presentation/location metadata, not identity. Same-volume directory renames and configuration edits retain the ID; deleting/recreating a directory, copying/cloning it, or moving it across volumes creates a new identity. Creation time disambiguates inode reuse on filesystems that provide it; continuity is not guaranteed across filesystem restore or filesystems without reliable creation metadata. Discovery writes no marker or other file into Hermes homes/profiles.

The root/default candidate deliberately retains the historical `hermes:default` compatibility identity, rather than adopting filesystem identity. This exception preserves existing default bindings and does not distinguish replacements of the default home. A named directory under `profiles/default` is still a named profile and receives a hashed ID, not the root/default compatibility ID. Existing name-derived named-profile IDs are not automatically reused: a profile name alone cannot safely establish continuity with the prior filesystem object.
