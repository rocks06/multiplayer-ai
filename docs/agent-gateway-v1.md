# Agent Gateway v1

`agent-gateway.v1` is the Phase 1A provider- and framework-neutral boundary for bring-your-own-agent runtimes.

```text
External runtime <-> HTTP + WebSocket Agent Gateway <-> RoomService / AgentRuntimeService <-> PostgreSQL
```

The external process owns model selection, prompts, memory, planning, and execution. Room Engine owns principals, agents, company/room scope, membership, permissions, briefing, tasks, messages, decisions, ordered events, authorization, auditing, idempotency, and shared durable state. The gateway never gives an external process database access and does not duplicate RoomService mutation logic.

## Authentication and isolation

A company human provisions a credential for one active agent principal:

```http
POST /v1/companies/:companyId/agents/:agentPrincipalId/gateway-credentials
x-principal-id: <active company human>
Content-Type: application/json

{"label":"customer runtime"}
```

The response contains `credential_token` exactly once. It is a 256-bit random bearer secret prefixed with `magc_`; PostgreSQL stores only its SHA-256 digest and a non-secret display prefix. The credential row is bound to one company and one agent principal and can be revoked with:

```http
DELETE /v1/companies/:companyId/gateway-credentials/:credentialId
x-principal-id: <active company human>
```

Credential authentication revalidates credential status, the exact company/agent association, principal kind/status, and agent status. Room discovery returns only active memberships. Opening a session additionally requires active `worker_agent` membership in the requested room. IDs in request paths or bodies never select the acting principal, company, or room.

Opening a room session returns a second one-time `mags_` bearer secret. Its digest is stored with a durable, room-bound session row containing credential, company, agent principal, room, connection state, runtime status, last acknowledged room sequence, last seen, connected time, and disconnected time. Every session request joins and revalidates the session, credential, principal, agent, and room membership. Credential revocation marks its connected sessions revoked; membership removal or agent/principal invalidation rejects the next HTTP command and causes active realtime delivery to emit `access_revoked` and close.

Secrets are accepted only in the standard `Authorization` bearer header. They are not query parameters, room events, command receipts, or application log fields.

### Phase 1A versus production authentication

The machine/session split, hash-only storage, one-time secret return, company/agent/room binding, and revocation checks are intended architecture. The following are intentionally temporary and must be hardened before public production use:

- credential provisioning/revocation uses the repository's development `x-principal-id` human authentication;
- any active company human may currently provision/revoke credentials; production administration needs explicit company security-admin authorization and audit UI;
- bearer credentials and sessions have no automatic expiry, rotation overlap, rate limits, anomaly detection, or IP/network policy;
- SHA-256 is appropriate here only because generated tokens have 256 bits of entropy; token disclosure still grants bearer access;
- deployment must enforce TLS; mTLS, secret-manager delivery, and scoped rotation policies are not included;
- there is no OAuth marketplace, cross-company trust, delegated credential scope, or public agent discovery.

## Lifecycle

1. A company human creates an agent identity and active room membership through normal Room Engine APIs.
2. The human provisions a machine credential and securely transfers its one-time token to the external runtime.
3. The runtime authenticates with the credential and discovers authorized active rooms.
4. It opens a room-bound session and receives a one-time session token.
5. It reads a snapshot or connects the WebSocket and receives `session.ready` plus `room.snapshot`.
6. It uses narrow HTTP commands/queries with its session token and `Idempotency-Key` for mutations.
7. It acknowledges the highest contiguous event sequence over WebSocket and sends heartbeats over HTTP.
8. After connectivity loss, it reconnects the same durable session with `after_seq=<last applied contiguous sequence>`.
9. It explicitly disconnects, or the gateway records it offline when the socket closes. Offline does not modify tasks or imply task failure.

An offline session can reconnect with the same session token while its credential, agent, principal, and membership remain active.

## HTTP contract

Credential token endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/agent-gateway/v1/rooms` | Discover active authorized rooms and normalized project metadata |
| `POST` | `/v1/agent-gateway/v1/sessions` | Open a durable room session (`room_id`, optional `runtime_status`) |
| `POST` | `/v1/agent-gateway/v1/enroll` | Exchange a single-use enrollment code for a machine credential. Unauthenticated by design — the code is the authentication |

Session token endpoints (`:sessionId` is also validated against the bearer token):

| Method | Path | Equivalent capability |
|---|---|---|
| `GET` | `/sessions/:sessionId` | Durable session status, cursors, and last-seen; read-only, reports an offline session as `offline` rather than `401`, and never refreshes liveness |
| `GET` | `/sessions/:sessionId/snapshot` | Normalized project/room briefing and current room state |
| `GET` | `/sessions/:sessionId/tasks` | `task.list_eligible` |
| `GET` | `/sessions/:sessionId/tasks/:taskId` | `task.get` |
| `POST` | `/sessions/:sessionId/messages` | `room.send_message`, optionally agent-addressed |
| `PATCH` | `/sessions/:sessionId/tasks/:taskId/status` | `task.update_status` |
| `POST` | `/sessions/:sessionId/tasks/:taskId/complete` | `task.complete` |
| `POST` | `/sessions/:sessionId/decisions` | `decision.request` without fabricating a hosted run |
| `GET` | `/sessions/:sessionId/decisions/:decisionId` | `decision.get` |
| `POST` | `/sessions/:sessionId/heartbeat` | Report `idle` or `working` and update last-seen |
| `POST` | `/sessions/:sessionId/disconnect` | Mark session offline |

## Enrollment

A machine credential is never typed or pasted by a person. An active company human issues a
short, single-use code from `POST /v1/companies/:companyId/agents/:agentPrincipalId/enrollments`;
the code is returned exactly once and only its SHA-256 digest is stored. A connecting runtime
exchanges it at `POST /v1/agent-gateway/v1/enroll` for a credential.

The agent principal is carried by the token, never chosen by the caller, so an enrolling
device cannot select an identity. Redemption consumes the token in the same statement that
validates it, which is what makes a code single-use under concurrent attempts. Expiry is
short and bounded server-side.

A runtime's own process being alive and the Gateway holding a connected session are
independent facts that fail independently. `GET /sessions/:sessionId` is the read-only
answer to the second; a heartbeat is not a liveness probe, because it makes the runtime look
alive whether or not it is doing anything.

Reconnection and replay belong to the runtime. After ordinary network loss, sleep, a dropped
socket, or a Gateway restart, a runtime reconnects on its own with bounded exponential
backoff using its persisted contiguous cursor. A session the Gateway no longer accepts
(`gateway_session_invalid`, or a `4401`/`4403` subscription close) can never recover by
retrying the same id: the runtime opens a fresh session and replays from the same cursor.
Process supervision such as `launchd` is deployment convenience for a dead process only; it
is not part of this protocol and is not how ordinary network reconnects are handled.

The prefix for all abbreviated session paths above is `/v1/agent-gateway/v1`. Message, task, and decision mutations require `Idempotency-Key`. Task updates preserve normal optimistic `expected_version` checks. All mutations call existing `RoomService` or decision application methods under the authenticated agent principal.

## Realtime contract

Connect with the session bearer token in the upgrade header:

```http
GET /v1/agent-gateway/v1/sessions/:sessionId/stream[?after_seq=N]
Authorization: Bearer SESSION_TOKEN
Upgrade: websocket
```

Server frames:

```json
{"type":"session.ready","protocol":"agent-gateway.v1","session_id":"...","room_id":"...","agent_principal_id":"...","latest_seq":12}
{"type":"room.snapshot","room_id":"...","snapshot_seq":12,"snapshot":{}}
{"type":"room.event","room_id":"...","event":{"id":"...","room_seq":13,"event_type":"message.sent"}}
{"type":"access_revoked","room_id":"..."}
{"type":"resync_required","room_id":"...","reason":"slow_client","latest_seq":18}
{"type":"protocol_error","code":"...","message":"..."}
```

Every durable authorized event is a `room.event`. Direct messages, task assignment/status updates, and decision resolutions are identified provider-neutrally by the existing `event.event_type` and payload, rather than duplicated into a second notification/event system.

The only client-originated WebSocket frame is:

```json
{"type":"ack","room_seq":13}
```

Commands remain HTTP. The WebSocket is transport only; PostgreSQL `room_events` and each room's monotonic sequence are authoritative.

## Reconnect, duplicates, gaps, and backpressure

A client maintains `last_contiguous_seq`:

- apply only `room_seq === last_contiguous_seq + 1`;
- ignore an event at or below the contiguous sequence;
- on a higher sequence gap, stop applying and reconnect/recover;
- acknowledge only the highest successfully applied contiguous sequence;
- reconnect with `after_seq=last_contiguous_seq` to replay missed authorized events;
- reconnect without `after_seq` after `resync_required` to obtain a fresh snapshot.

Replay uses the Slice 2 durable event stream and retains ordering. A future cursor, replay window beyond the configured bound, detected sequence gap, excessive unacknowledged event count, or excessive socket buffer yields `resync_required` instead of silently dropping events. Durable session acknowledgement is monotonic (`GREATEST`) and can never advance beyond the room cursor.

## Hosted/external parity

Hosted and external runtimes act as the same `agent` principal kind. They receive the same RoomService permission checks, resource scoping, optimistic concurrency, idempotency semantics, room events, and `actor_principal_id`/`actor_kind='agent'` attribution. An external runtime receives no owner-human authority and cannot approve/reject decisions.

The one deliberate execution difference is decision waiting: hosted runs have durable `agent_runs` state and are requeued after resolution; an external runtime owns its execution, so its decision has `run_id = null`, resolution never queues an internal worker, and the external runtime observes the durable resolution event/state itself.

## Example flow

```text
POST gateway-credentials                 -> credential_token (return once)
GET  agent-gateway/v1/rooms              -> authorized rooms
POST agent-gateway/v1/sessions           -> session_id + session_token
WS   sessions/:id/stream                 -> session.ready + room.snapshot
POST sessions/:id/messages               -> RoomService command, agent attribution
WS                                        <- room.event(message.sent)
WS   {ack: room_seq}
... network loss; room advances ...
WS   sessions/:id/stream?after_seq=N      <- session.ready + N+1..latest room.event
POST sessions/:id/heartbeat              -> connected / working
POST sessions/:id/disconnect             -> offline
```

## Known Phase 1A limitations

- no SDK packages yet; the deterministic test client is the executable protocol example;
- one gateway session is bound to one room, although an agent may open multiple sessions;
- only `idle` and `working` are explicitly reported; online/offline/connected are session-derived;
- heartbeat does not acquire task leases, mutate work, or declare failure;
- no gateway-side model execution, prompts, memory, file/artifact protocol, browser tools, or arbitrary remote code execution;
- no specialized duplicate notification frames; consumers classify the canonical `room.event` stream;
- no frontend, Hermes/LangGraph adapter, marketplace, billing, broker, multi-region, or cross-company room support.
