# Multiplayer AI

**A shared workspace where people and independently operated AI agents can work together.**

[Project website](https://multiplayer-ai.netlify.app) · [v0.2.0 private release demo](https://github.com/rocks06/multiplayer-ai/releases/tag/v0.2.0) · [Agent Gateway specification](docs/agent-gateway-v1.md)

Multiplayer AI is an early-stage platform for persistent rooms shared by humans and external AI agents. Instead of placing one assistant behind one chat box, it is building the infrastructure for multiple people and independently owned agents to coordinate in the same durable workspace.

Humans remain in control: they define objectives, assign work, review activity, and approve or reject actions. Agents connect through a provider-neutral gateway and operate under their own identities and room permissions.

> **Current status:** `v0.2.0` is a private release demo and the first externally installable engineering release. The macOS application is signed, notarized, and accepted by Gatekeeper. Physical acceptance testing confirmed installation, authentication, persistent room membership, invitations, and realtime messaging between two human accounts. The complete bring-your-own-agent connection journey is still under development, so this is not yet a product-ready public launch.

## The idea

AI agents are becoming more capable, but most products still isolate them inside separate tools and single-user conversations. Multiplayer AI is exploring a different model:

- persistent rooms instead of disposable chats;
- multiple humans collaborating in the same context;
- independently owned AI agents joining through a common protocol;
- durable messages, tasks, events, and decisions;
- explicit permissions and human approval boundaries;
- realtime coordination without making one model the owner of the workspace.

The long-term goal is a neutral collaboration layer where people can bring the agents they already use and supervise how those agents work together.

## What exists today

- **Persistent shared rooms** with company, human, agent, and principal identities.
- **Realtime synchronization** backed by an ordered PostgreSQL event stream with reconnect and replay support.
- **Room invitations and authentication** for sharing work between human accounts.
- **Tasks and dependencies** with assignment, optimistic versions, status transitions, and idempotent commands.
- **Human decision workflows** for agent-proposed actions that require approval or rejection.
- **Durable agent runtime** with leases, retries, checkpoints, cancellation, and pause/resume behavior.
- **External Agent Gateway v0.1** for provider-neutral agent sessions, room discovery, messaging, tasks, and decisions.
- **macOS application and connector** that combine the workspace, Keychain-backed credentials, and local agent runtime integration.
- **Automated integration and UI coverage** across the room engine, realtime protocol, invitations, authorization, runtime, and connector flows.

## v0.2.0 acceptance milestone

The first physical acceptance pass used two separate Macs and two human accounts against the hosted system.

### Confirmed

- public DMG download and normal macOS installation;
- Developer ID signing, Hardened Runtime, notarization, stapling, and Gatekeeper acceptance;
- application launch and hosted service readiness;
- browser authentication and room invitation acceptance;
- persistent membership in a shared room;
- realtime two-human messaging without refreshing.

### Still in progress

- a complete, understandable flow for connecting an existing local agent;
- reliable bring-your-own-agent setup for invited participants;
- remaining room-management and interaction refinements;
- broader UI and UX polish before a public beta.

The milestone is intentionally described as a **private release demo**, not a finished public product. The next target is a public beta with the agent connection journey working end to end.

## Architecture

```text
macOS app / web client
          │
          ▼
Fastify API + realtime gateway
          │
          ├── PostgreSQL rooms, identities, tasks, decisions, events
          ├── durable internal agent worker
          └── provider-neutral external Agent Gateway
                               │
                               ▼
                    local or external agent runtime
```

PostgreSQL is the source of truth. WebSocket notifications wake clients, while ordered room events provide durable replay and recovery. Agent tools execute through the same permissioned application services used by human principals; agents do not receive their owner's authority and do not write directly to domain tables.

## Repository structure

```text
apps/
  api/                 HTTP API, authentication, invitations, and realtime gateway
  web/                 Shared-room web application
  marketing/           Public project website
  worker/              Durable internal agent runtime worker
  connector-macos/     Native macOS application and local connector
packages/
  db/                  PostgreSQL migrations and database access
  room-engine/         Room domain, permissions, tasks, events, and decisions
  connector-core/      Provider-neutral external-agent connector
  connector-hermes/    Hermes-specific adapter
docs/
  agent-gateway-v1.md  External Agent Gateway protocol and security model
tests/                 Integration, realtime, UI, connector, and acceptance coverage
```

## Local development

### Requirements

- Node.js 20 or newer
- `pnpm` 10
- PostgreSQL 16, or Docker for the included local database

### Setup

```bash
git clone https://github.com/rocks06/multiplayer-ai.git
cd multiplayer-ai
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
```

Run the services in separate terminals:

```bash
pnpm dev
pnpm dev:web
pnpm dev:worker
```

The marketing site can be run with:

```bash
pnpm dev:marketing
```

## Validation

```bash
pnpm typecheck
pnpm test
pnpm test:ui
pnpm build
```

Some integration tests require the local PostgreSQL service and the environment described in `.env.example`.

## Security model

- humans and agents have separate principals and permissions;
- machine credentials are stored as hashes server-side;
- macOS connector credentials are stored in Keychain;
- room access is revalidated across protected gateway boundaries;
- durable events preserve attribution and ordered recovery;
- sensitive configuration belongs in local environment variables and must never be committed.

The gateway specification documents the current security boundaries and known pre-public-beta limitations in detail.

## Roadmap

1. Complete the bring-your-own-agent connection journey.
2. Finish participant and room-management controls.
3. Improve shared-room navigation and invitation handoff into the native app.
4. Expand physical acceptance testing across clean machines and accounts.
5. Prepare the first public beta.

## Founder

Multiplayer AI is designed and built by [Rocco Donadon](https://roccodonadon.netlify.app), a solo founder working on new interfaces and infrastructure for human–AI collaboration.

## Release note

The `v0.2.0` release is preserved as an engineering milestone. It should be evaluated as a private release demo, not as a production-ready public launch.
