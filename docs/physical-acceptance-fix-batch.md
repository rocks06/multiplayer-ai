# Physical acceptance follow-up: PDF preview, shell layout, single-room move

## Accepted baseline and scope

User-reported physical acceptance on `5fcd956123af00a66f58faebda55db4adaa61f68`:
- Detect Agent sheet and runtime discovery work.
- Agent connects and executes.
- Generated PDF auto-uploads, appears as an attachment card, increments Files, downloads as a valid PDF, and execution returns to Idle.

Preserve all of those behaviors. This batch is limited to the following failures. Mentions, ownership, and true multi-room WIP remain excluded; no merge from the paused branch.

## Required fixes and evidence

### PDF Preview

Trace authenticated artifact bytes through the native WebView preview renderer. The current browser surface creates a PDF blob URL in a sandboxed iframe; modal/filename existence is not page-rendering proof. Preserve authorized reads, safe handling of untrusted bytes, and working download. Require actual PDF page rendering in native-app technology, with explicit error/retry rather than blank content.

### Empty-room shell

Use the same constrained shell for empty and populated rooms: stable header, rails and compact composer, scroll confined to transcript/content regions. Verify empty, short typing and bounded multiline typing at normal and small window sizes. Preserve attachments, keyboard send, popover, and populated-room behavior. Capture geometry and screenshots, not only DOM presence.

### Single-room move

Before any mutation, confirm: `<agent> is currently connected to <source room>. Move it to <target room>?` Names are presentation only.

Cancel must leave memberships, sessions, identity and credential unchanged. Confirm must release the old active session before connecting the new room, retain the principal/runtime identity and credential, and publish the old-room state change immediately. Do not call the new room Connected before authenticated `session.ready`. Test failure/retry and stale session behavior. This is a move, not simultaneous participation or new-agent creation.

## Final gates

- Full TypeScript typecheck/build and main tests against a newly created disposable database.
- Full discovered browser inventory, including attachment regression and new layout/move/preview cases, against a separate disposable database.
- Full Swift suite including actual native PDF rendering and helper/startup checks.
- Rebuild bundled helper from current compiled output and execute isolated onboarding/startup exercise.
- Receive and reconcile all delegated work and security review before committing.
- Audit staged files, credentials/artifacts and paused WIP preservation.
- Report exact new commit, each root cause and evidence boundary, exact suite counts, Render and app/DMG requirements. Do not equate automated host evidence with physical MacBook Air acceptance.
