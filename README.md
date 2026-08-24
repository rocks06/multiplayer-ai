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
DATABASE_URL=postgres://postgres:***@127.0.0.1:55432/multiplayer_ai pnpm start
```

Advanced OIDC, agent execution, decisions/approval/resume, provider adapters, and the product UI remain subsequent slices.
