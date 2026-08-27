# Multiplayer AI — Room Engine

Phase 1A is being implemented as incremental, runnable vertical slices.

## Implemented slices

### Slice 1 — Durable room foundation

- separate company, human, agent, and principal identities;
- project/room creation and explicit room membership;
- manager, contributor, and worker-agent permissions;
- first-class room and agent-addressed conversation;
- tasks with assignment, statuses, optimistic versions, and idempotent commands;
- immutable per-room ordered events;
- authorized snapshot and event replay endpoints;
- normalized project briefing for joining/resuming participants.

### Slice 2 — Realtime room synchronization

- authorized WebSocket room subscriptions;
- snapshot bootstrap for a new client;
- durable replay after `after_seq` for a reconnecting client;
- ordered event delivery from PostgreSQL `room_events`;
- client acknowledgements using the highest applied contiguous room sequence;
- duplicate filtering and sequence-gap detection;
- PostgreSQL `LISTEN/NOTIFY` wakeups with polling fallback;
- stale/future cursor and slow-client `resync_required` behavior;
- active membership revocation and connection cleanup;
- concurrent room isolation.

PostgreSQL remains the source of truth. Notifications only wake the realtime gateway; every delivery/recovery pump reads the durable room event stream after the connection's last sent contiguous sequence. HTTP remains the command channel and no mutation exists only in WebSocket memory.

### Slice 3 — Durable agent runtime

- durable PostgreSQL `agent_runs` queue, checkpoints, attempts, leases, and terminal status;
- independent worker process with renewable leases and expired-lease recovery;
- bounded fake-provider retries and durable retry status;
- run-local cancellation generations plus agent-wide pause generations;
- a Phase 1A scheduler-only one-active-run-per-agent/per-room partial index;
- normalized briefing and authorized room snapshot context assembly;
- deterministic scripted fake provider with controlled barriers and failures;
- `room.send_message`, `task.get`, `task.list_eligible`, `task.update_status`, and `task.complete` tools only;
- tool execution through `RoomService` under the agent principal, never its human owner;
- in-transaction lease, generation, status, and membership fencing on every room mutation;
- stable per-run tool idempotency keys and durable `agent_tool_calls` records;
- durable run queued/started/resumed/retry/completed/failed/cancelled events.

The worker does not mutate `messages`, `tasks`, or other room domain tables directly. Mutating tools use the same permissioned, optimistic, idempotent application commands used by human principals. The deterministic provider and its scripted input are development/test infrastructure for Phase 1A—not a general provider API or production model integration.

### Slice 4 — Human decision and agent resume workflow

- structured, room-scoped decisions with `pending`, `approved`, `rejected`, `cancelled`, and `expired` states;
- immutable proposed actions protected by a canonical SHA-256 digest;
- durable `waiting_for_decision` agent runs with released leases and persisted checkpoints/context cursors;
- `decision.request` and `decision.get` agent tools through the runtime authority boundary;
- human-only approval/rejection under the resolving human's own principal and current manager permission;
- optional human notes/instructions and optional decision expiry timestamps;
- optimistic decision versions and idempotent create/approve/reject/cancel commands;
- automatic durable requeue after approval or rejection, with one-time resume under normal lease/generation fencing;
- resumed context containing the original request, exact proposed action, human resolution/note, and authorized room events since the pause;
- cancellation propagation for manager cancellation, agent pause, membership loss, principal/agent invalidation, and expiry;
- correctly attributed `decision.*`, `agent.run_waiting_for_decision`, and `agent.run_resumed` room events;
- scoped HTTP create/read/list/approve/reject/cancel endpoints.

A waiting run remains active for the Phase 1A same-agent/room scheduler constraint. Resolution verifies the exact proposed-action digest and expected decision version transactionally before requeueing the run. An agent cannot inherit a supervising human's authority and cannot approve or reject decisions.

### Slice 5 — External Agent Gateway v0.1

- provider/framework-neutral `agent-gateway.v1` over narrow HTTP queries/commands and WebSocket event transport;
- one-time, hash-only machine credentials bound to one company and one active agent principal;
- independently hashed, durable, room-bound gateway sessions with connection state, runtime status, heartbeat, last seen, and monotonic acknowledged room sequence;
- active credential, principal, agent, company, room-membership, and worker-agent-role validation at every protected gateway boundary;
- authorized room discovery, normalized snapshots/briefings, task reads/updates/completion, room and agent-addressed messages, and external decision request/read;
- the existing PostgreSQL-authoritative Slice 2 room event stream reused for ordered delivery, replay, duplicate suppression, gap recovery, access revocation, and slow-client resynchronization;
- identical RoomService permission results and event attribution for hosted and external agents;
- deterministic fake external-agent HTTP/WebSocket client and concurrent two-agent integration coverage.

External decision requests use the same durable decision model and room events but do not fabricate an internally hosted `agent_run`; the external runtime observes the resolution and owns its continuation. See [`docs/agent-gateway-v1.md`](docs/agent-gateway-v1.md) for authentication, lifecycle, complete HTTP/WebSocket contracts, reconnect semantics, parity guarantees, an adapter-ready connection flow, and explicit Phase 1A security limitations.

## Realtime protocol

Connect to:

```text
GET /v1/companies/:companyId/rooms/:roomId/stream[?after_seq=N]
```

Phase 1A local/dev identity is supplied with `x-principal-id`. A `principal_id` query parameter is also accepted temporarily for browser clients that cannot set upgrade headers.

> **Authentication technical debt:** Query-string identity is a Phase 1A development convenience only, is not the production authentication design, and must be replaced by a proper short-lived authenticated mechanism before any external deployment.

Server frames:

```json
{"type":"snapshot","room_id":"...","snapshot_seq":12,"snapshot":{}}
{"type":"resumed","room_id":"...","after_seq":12,"latest_seq":15}
{"type":"event","room_id":"...","event":{"id":"...","room_seq":13}}
{"type":"resync_required","room_id":"...","reason":"slow_client","latest_seq":15}
{"type":"access_revoked","room_id":"..."}
{"type":"protocol_error","code":"...","message":"..."}
```

Client acknowledgement:

```json
{"type":"ack","room_seq":13}
```

The client applies an event only when `room_seq === last_contiguous_seq + 1`, ignores an event at or below its contiguous sequence, and reconnects with `after_seq=last_contiguous_seq` after a gap or disconnect. A `resync_required` response means reconnect without `after_seq` to obtain a fresh snapshot.

## Run locally

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm install
DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/multiplayer_ai pnpm db:migrate
DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/multiplayer_ai pnpm test
pnpm build
DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/multiplayer_ai pnpm start
DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/multiplayer_ai pnpm start:worker
```

The API queues and controls runs; the worker claims and executes them independently. `WORKER_ID`, `AGENT_LEASE_MS`, and `AGENT_POLL_MS` may be set for local runtime testing.

## Staging blockers

These are acceptable for the local developer beta and must be closed before any
internet-accessible deployment:

- `POST /v1/companies` and `POST /v1/companies/:companyId/humans` are **unauthenticated**.
  They exist so the first account can bootstrap while there is no email transport. They must
  be authenticated or replaced before staging. The product path does not use them: a signed-in
  user creates a workspace through the authenticated `POST /v1/workspaces`, which establishes
  their membership and principal in the same transaction.
- Sign-in links are delivered by `LoggingSignInLinkDelivery`, which writes the token to the
  server log, or issued through an authorized company member. A real transport must be added
  behind `SignInLinkDelivery` before staging.
- `ALLOW_HEADER_PRINCIPAL` must remain unset in any deployed environment. It restores the
  Phase 1A `x-principal-id` / `principal_id` development identity path.
- Any active company human can still administer gateway credentials and enrollment codes;
  there is no security-administrator role.

Real model providers, production-grade human/machine authentication administration, external actions, agent memory, artifacts, SDK/framework adapters, multi-person quorum/approval chains, and the product UI remain subsequent slices.
