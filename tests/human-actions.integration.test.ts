import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { FakeExternalAgentClient } from "./fake-external-agent.js";
import { truncateAll } from "./support/database.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for human action tests");

/**
 * Consequential human commands are explicit, permissioned, idempotent and audited. Nothing
 * here is inferred from natural language: an imperative is a named command or it is a message.
 */
describe("Explicit human actions", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, baseUrl: string;
  const clients = new Set<FakeExternalAgentClient>();
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });
  const asActor = (principalId: string, key: string = crypto.randomUUID()) => ({ "x-principal-id": principalId, "idempotency-key": key });

  async function fixture() {
    const company = (await call("POST", "/v1/companies", { name: "Actions Co" })).json();
    const owner = (await call("POST", `/v1/companies/${company.id}/humans`, { email: `owner-${crypto.randomUUID()}@example.com`, display_name: "Owner" })).json();
    const worker = (await call("POST", `/v1/companies/${company.id}/humans`, { email: `worker-${crypto.randomUUID()}@example.com`, display_name: "Worker" })).json();
    const project = (await call("POST", `/v1/companies/${company.id}/projects`, { name: "P", objective: "O" }, { "x-principal-id": owner.principal_id })).json();
    const room = (await call("POST", `/v1/companies/${company.id}/projects/${project.id}/rooms`, { name: "R", responsibilities: "Own it" }, { "x-principal-id": owner.principal_id })).json();
    await call("POST", `/v1/companies/${company.id}/rooms/${room.id}/members`, { principal_id: worker.principal_id, role: "contributor", responsibilities: "Do it" }, asActor(owner.principal_id));
    const base = `/v1/companies/${company.id}/rooms/${room.id}`;
    const makeAgent = async (name: string) => {
      const agent = (await call("POST", `/v1/companies/${company.id}/agents`, { name }, { "x-principal-id": owner.principal_id })).json();
      await call("POST", `${base}/members`, { principal_id: agent.principal_id, role: "worker_agent", responsibilities: `${name} work` }, asActor(owner.principal_id));
      const credential = (await call("POST", `/v1/companies/${company.id}/agents/${agent.principal_id}/gateway-credentials`, { label: `${name} runtime` }, { "x-principal-id": owner.principal_id })).json();
      return { ...agent, credential };
    };
    return { company, owner, worker, room, base, makeAgent };
  }

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    app = buildApp(pool, { pollIntervalMs: 20 }, { allowHeaderPrincipal: true });
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterEach(async () => { for (const c of clients) c.close(); clients.clear(); await app.close(); });

  describe("resume agent", () => {
    it("restores a paused agent's authority and its Gateway access", async () => {
      const f = await fixture();
      const agent = await f.makeAgent("Agent A");

      const client = new FakeExternalAgentClient(baseUrl); clients.add(client);
      client.credentialToken = agent.credential.credential_token; client.roomId = f.room.id;
      expect((await client.open()).status).toBe(200);
      expect((await client.heartbeat("idle")).status).toBe(200);

      expect((await call("POST", `${f.base}/agents/${agent.agent_id}/pause`, {}, asActor(f.owner.principal_id))).statusCode).toBe(200);
      // Pausing withdraws authority: the credential check requires an active agent.
      expect((await client.heartbeat("idle")).status).toBe(401);
      expect((await pool.query(`SELECT status FROM agents WHERE id=$1`, [agent.agent_id])).rows[0].status).toBe("paused");

      const resumed = await call("POST", `${f.base}/agents/${agent.agent_id}/resume`, {}, asActor(f.owner.principal_id));
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().status).toBe("active");
      expect((await pool.query(`SELECT status FROM agents WHERE id=$1`, [agent.agent_id])).rows[0].status).toBe("active");

      // A fresh session works again, so the connector recovers without re-enrolling.
      const reconnected = new FakeExternalAgentClient(baseUrl); clients.add(reconnected);
      reconnected.credentialToken = agent.credential.credential_token; reconnected.roomId = f.room.id;
      expect((await reconnected.open()).status).toBe(200);
    });

    it("is idempotent, manager-only, and refuses an agent that is not paused", async () => {
      const f = await fixture();
      const agent = await f.makeAgent("Agent A");
      await call("POST", `${f.base}/agents/${agent.agent_id}/pause`, {}, asActor(f.owner.principal_id));

      // A contributor cannot restore an agent a manager withdrew.
      expect((await call("POST", `${f.base}/agents/${agent.agent_id}/resume`, {}, asActor(f.worker.principal_id))).statusCode).toBe(403);

      const key = crypto.randomUUID();
      const first = await call("POST", `${f.base}/agents/${agent.agent_id}/resume`, {}, asActor(f.owner.principal_id, key));
      const replay = await call("POST", `${f.base}/agents/${agent.agent_id}/resume`, {}, asActor(f.owner.principal_id, key));
      expect(replay.json().room_seq).toBe(first.json().room_seq);

      // Resuming an already-active agent under a new key is refused rather than silently
      // succeeding, so the audit trail never records a resume that changed nothing.
      const again = await call("POST", `${f.base}/agents/${agent.agent_id}/resume`, {}, asActor(f.owner.principal_id));
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("agent_not_paused");

      const events = await pool.query(`SELECT actor_principal_id,payload FROM room_events WHERE room_id=$1 AND event_type='agent.resumed'`, [f.room.id]);
      expect(events.rowCount).toBe(1);
      expect(events.rows[0].actor_principal_id).toBe(f.owner.principal_id);
      expect(events.rows[0].payload.agent_principal_id).toBe(agent.principal_id);
      expect((await call("POST", `${f.base}/agents/${crypto.randomUUID()}/resume`, {}, asActor(f.owner.principal_id))).statusCode).toBe(404);
    });
  });

  describe("reassign task", () => {
    it("hands work to another principal and records both ends of the move", async () => {
      const f = await fixture();
      const agentA = await f.makeAgent("Agent A"), agentB = await f.makeAgent("Agent B");
      const task = (await call("POST", `${f.base}/tasks`, { title: "Authentication investigation", description: "", assignee_principal_id: agentA.principal_id }, asActor(f.owner.principal_id))).json();

      const moved = await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: agentB.principal_id, expected_version: 1 }, asActor(f.owner.principal_id));
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toEqual(expect.objectContaining({ assignee_principal_id: agentB.principal_id, previous_assignee_principal_id: agentA.principal_id, version: 2 }));

      const stored = await pool.query(`SELECT assignee_principal_id,version,status FROM tasks WHERE id=$1`, [task.id]);
      expect(stored.rows[0]).toEqual({ assignee_principal_id: agentB.principal_id, version: 2, status: "open" });

      const event = await pool.query(`SELECT event_type,entity_version,payload FROM room_events WHERE entity_id=$1 AND event_type='task.reassigned'`, [task.id]);
      expect(event.rows[0].entity_version).toBe(2);
      expect(event.rows[0].payload.previous_assignee_principal_id).toBe(agentA.principal_id);

      // Unassigning is the same command with no principal.
      const cleared = await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: null, expected_version: 2 }, asActor(f.owner.principal_id));
      expect(cleared.json().assignee_principal_id).toBeNull();
    });

    it("keeps optimistic concurrency, membership, and terminal states", async () => {
      const f = await fixture();
      const agentA = await f.makeAgent("Agent A");
      const outsider = (await call("POST", `/v1/companies/${f.company.id}/humans`, { email: `out-${crypto.randomUUID()}@example.com`, display_name: "Outsider" })).json();
      const task = (await call("POST", `${f.base}/tasks`, { title: "Work", description: "", assignee_principal_id: agentA.principal_id }, asActor(f.owner.principal_id))).json();

      const stale = await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: f.worker.principal_id, expected_version: 99 }, asActor(f.owner.principal_id));
      expect(stale.json().error.code).toBe("version_conflict");

      // A principal who is not in the room cannot be handed its work.
      expect((await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: outsider.principal_id, expected_version: 1 }, asActor(f.owner.principal_id))).statusCode).toBe(403);

      // A contributor cannot move someone else's work.
      expect((await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: f.worker.principal_id, expected_version: 1 }, asActor(f.worker.principal_id))).statusCode).toBe(403);

      await call("PATCH", `${f.base}/tasks/${task.id}/status`, { status: "cancelled", expected_version: 1 }, asActor(f.owner.principal_id));
      const terminal = await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: f.worker.principal_id, expected_version: 2 }, asActor(f.owner.principal_id));
      expect(terminal.statusCode).toBe(422);
      expect(terminal.json().error.code).toBe("task_not_reassignable");
    });

    it("replays a reassignment under the same key without moving the task twice", async () => {
      const f = await fixture();
      const agentA = await f.makeAgent("Agent A"), agentB = await f.makeAgent("Agent B");
      const task = (await call("POST", `${f.base}/tasks`, { title: "Work", description: "", assignee_principal_id: agentA.principal_id }, asActor(f.owner.principal_id))).json();

      const key = crypto.randomUUID();
      const first = await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: agentB.principal_id, expected_version: 1 }, asActor(f.owner.principal_id, key));
      const replay = await call("PATCH", `${f.base}/tasks/${task.id}/assignee`, { assignee_principal_id: agentB.principal_id, expected_version: 1 }, asActor(f.owner.principal_id, key));
      expect(replay.json()).toEqual(first.json());

      expect((await pool.query(`SELECT version FROM tasks WHERE id=$1`, [task.id])).rows[0].version).toBe(2);
      expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE entity_id=$1 AND event_type='task.reassigned'`, [task.id])).rows[0].n).toBe(1);
    });
  });
});
