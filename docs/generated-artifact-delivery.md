# Generated artifacts: delivery gate and acceptance

## Evidenced source defect at dcc0940

The macOS sidecar implemented `attach` but omitted it from `COMMAND_SURFACE`, the list embedded in every Hermes invocation. The adapter's attach/message examples also retained the literal `COMMAND` placeholder. The model was given an inconsistent interface. More importantly, `message` accepted a local-path body without any upload, and the adapter treated a zero CLI exit as success without checking generated-file delivery.

This is a source-level diagnosis consistent with the reported Air failure, not a recovered trace of JJ's exact model/tool calls. The physical Air invocation log was not available during this change. The Mac mini's local connector log had no relevant PDF/attach trace. Human PDF reception on the Air is user-reported physical evidence.

## New contract

Each Hermes invocation gets a private flat `generated-output/invocation-*/files` directory, plus a manifest outside it. The prompt tells Hermes to declare expected filenames and write deliverables there. `MPAI_OUTPUT_DIR` and `MPAI_OUTPUT_MANIFEST` also expose these paths. No Hermes profile/config is modified.

The actual sidecar `message` command, not the model, enumerates that output directory, validates every file, uploads it via the existing room-scoped Gateway client, and sends one message containing the returned artifact IDs. No explicit attach call is required. Explicit attach remains compatible. Known staged paths are replaced by filenames in the room body. Common absolute local document-path replies without artifact IDs are refused with a recovery instruction, not silently published or used to read arbitrary files.

A missing declared output blocks the message and can be created and retried with the same key. A generated file left undelivered makes an otherwise successful Hermes process fail its invocation. Current session credentials are published synchronously before invocation, removing the initial timer race. The advertised attach verb and concrete examples are corrected.

## Safety and retry behavior

- Only the fresh output directory is auto-scanned; no home scan or arbitrary prose-path upload.
- Symlink roots/files, hardlinks, directories, empty files, traversal declarations, more than 20 files, and files over 25 MiB are rejected.
- A receipt fences concurrent same-key calls. Prepared message retries reuse uploaded IDs and the same gateway idempotency key.
- Ambiguous/crashed uploads remain blocked rather than risking duplicate uploads. Reconcile such failures before deliberately starting a new delivery key.
- Generated files/receipts remain local for diagnosis; automatic retention cleanup is not introduced in this slice.
- This is a delivery boundary, not a sandbox for an agent already authorized to use local terminal/file tools. The model still must generate the intended file and invoke the room message command. A CLI-only answer is not silently posted as room content.
- Existing Gateway authorization, content handling and human upload routes remain unchanged. No DB migration.

## Verification and release

Run integration tests against a disposable database only (the suites truncate data):

```
NODE_OPTIONS=--no-experimental-webstorage DATABASE_URL=<disposable-local-db> pnpm test
NODE_OPTIONS=--no-experimental-webstorage DATABASE_URL=<disposable-local-db> pnpm test:e2e
pnpm exec playwright test --config tests/e2e/attachments.config.ts
pnpm typecheck
(cd apps/connector-macos && swift test)
```

The process integration uses a **fake Hermes executable** with real authenticated local Gateway requests, storage and message associations; it includes success, missing output, failed upload, no message, explicit attach and replay. Browser coverage generates a deterministic PDF (not an LLM PDF), runs the real auto-upload gate, observes its live card and Files increment, opens the PDF preview iframe and compares downloaded bytes. This does not prove native PDF rendering on the Air. The browser menu fixture uses real components/CSS but a fake upload boundary; the separate full browser suite covers human uploads against the actual local API.

Deploy the updated web build to Render for the popover/chips. Rebuild and install a new DMG on **the machine running JJ** for the bundled sidecar/Hermes adapter changes. A Render-only deploy or an old dcc0940 DMG does not install the delivery gate. Preserve Application Support data, Keychain, Hermes files and both runtime/connector identities. Replacing the app does not require erasing those. Signing/notarization constraints remain unchanged.

Final physical gate: real JJ generates a PDF without being told to call attach → actual room card → Files increments → Preview and Download open the real file on the other machine → human PDF upload still works. Keep that gate pending until the new DMG is tested. No mentions or multi-room changes belong to this slice.
