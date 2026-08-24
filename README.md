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

Real model providers, production authentication, decisions/approval/resume, external actions, agent memory, artifacts, and the product UI remain subsequent slices.
