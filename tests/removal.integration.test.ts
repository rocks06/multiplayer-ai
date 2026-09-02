import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import type { SignInLink, SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for removal tests");

class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  async deliver(link: SignInLink) { this.delivered.push(link); }
}

/**
 * Taking things away.
 *
 * Two-Mac testing left a workspace nobody could tidy: test rooms that could not be deleted and
 * stale agents that could not be removed. Both need to revoke what they retire — a removed agent
 * holding a live credential is still connected — while leaving the history alone. What an agent
 * did happened, and deleting the agent does not unhappen it.
 */
describe("removing rooms and agents", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, delivery: CapturingDelivery;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  async function signedInUser(displayName: string) {
    const email = `user-${crypto.randomUUID()}@example.com`;
    const seed = await seedCompany(pool, "seed");
    await seedHuman(pool, seed.id, email, displayName);
    await call("POST", "/v1/auth/sign-in-links", { email });
    const session = await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token });
    const raw = session.headers["set-cookie"];
    return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] ?? "" };
  }

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    delivery = new CapturingDelivery();
    app = buildApp(pool, { pollIntervalMs: 20 }, { allowHeaderPrincipal: false, signInDelivery: delivery });
  });
  afterEach(async () => { await app.close(); });

  /** A workspace with a room and an agent connected in it, which is what needs tidying up. */
  async function fixture() {
    const me = await signedInUser("Rocco");
    const company = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();
    const head = { cookie: me.cookie };
    const project = (await call("POST", `/v1/companies/${company.company_id}/projects`,
      { name: "P", objective: "O" }, head)).json();
    const room = (await call("POST", `/v1/companies/${company.company_id}/projects/${project.id}/rooms`,
      { name: "TESTING #1" }, head)).json();
    const agent = (await call("POST", `/v1/companies/${company.company_id}/agents`, { name: "JJ" }, head)).json();
    await call("POST", `/v1/companies/${company.company_id}/rooms/${room.id}/members`,
      { principal_id: agent.principal_id, role: "worker_agent", responsibilities: "" },
      { ...head, "idempotency-key": crypto.randomUUID() });
    const credential = (await call("POST",
      `/v1/companies/${company.company_id}/agents/${agent.principal_id}/gateway-credentials`,
      { label: "JJ on Air" }, head)).json();
    const session = (await call("POST", "/v1/agent-gateway/v1/sessions", { room_id: room.id },
      { authorization: `Bearer ${credential.credential_token}` })).json();
    return { me, head, companyId: company.company_id, room, agent, credential, session };
  }

  const countOf = async (sql: string, params: unknown[]) =>
    Number((await pool.query(`SELECT count(*)::int n FROM ${sql}`, params)).rows[0].n);

  describe("an agent", () => {
    it("is removed, revoked, and taken out of its rooms, without erasing what it did", async () => {
      const f = await fixture();
      // It said something, so there is history that must survive it.
      const said = await call("POST", `/v1/agent-gateway/v1/sessions/${f.session.session_id}/messages`,
        { body: "On it" }, { authorization: `Bearer ${f.session.session_token}`, "idempotency-key": crypto.randomUUID() });
      expect(said.statusCode).toBe(200);
      const before = await countOf(`room_events WHERE actor_principal_id=$1`, [f.agent.principal_id]);
      expect(before).toBeGreaterThan(0);

      const removed = await call("DELETE", `/v1/companies/${f.companyId}/agents/${f.agent.principal_id}`,
        undefined, f.head);
      expect(removed.statusCode).toBe(200);

      // Nothing it held is still usable.
      expect(await countOf(`external_agent_credentials WHERE agent_principal_id=$1 AND status='active'`, [f.agent.principal_id])).toBe(0);
      expect(await countOf(`external_agent_sessions WHERE agent_principal_id=$1 AND status='connected'`, [f.agent.principal_id])).toBe(0);
      expect(await countOf(`room_members WHERE principal_id=$1 AND status='active'`, [f.agent.principal_id])).toBe(0);
      expect((await call("POST", "/v1/agent-gateway/v1/sessions", { room_id: f.room.id },
        { authorization: `Bearer ${f.credential.credential_token}` })).statusCode).toBe(401);

      // And what it did is still there.
      expect(await countOf(`room_events WHERE actor_principal_id=$1`, [f.agent.principal_id])).toBe(before);
      expect(await countOf(`room_events WHERE room_id=$1 AND event_type='message.sent'`, [f.room.id])).toBe(1);
      // It is gone from the workspace list, which is the question the person actually asked.
      const agents = (await call("GET", `/v1/companies/${f.companyId}/agents`, undefined, f.head)).json();
      expect(agents.agents.find((a: any) => a.principal_id === f.agent.principal_id)).toBeUndefined();
    });

    it("cannot be removed by someone outside the workspace", async () => {
      const f = await fixture();
      const stranger = await signedInUser("Stranger");
      const refused = await call("DELETE", `/v1/companies/${f.companyId}/agents/${f.agent.principal_id}`,
        undefined, { cookie: stranger.cookie });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(await countOf(`external_agent_credentials WHERE agent_principal_id=$1 AND status='active'`, [f.agent.principal_id])).toBe(1);
    });
  });

  describe("a room", () => {
    it("is deleted, its agents cut loose, and its history kept", async () => {
      const f = await fixture();
      const said = await call("POST", `/v1/agent-gateway/v1/sessions/${f.session.session_id}/messages`,
        { body: "On it" }, { authorization: `Bearer ${f.session.session_token}`, "idempotency-key": crypto.randomUUID() });
      expect(said.statusCode).toBe(200);
      const before = await countOf(`room_events WHERE room_id=$1`, [f.room.id]);

      const deleted = await call("DELETE", `/v1/companies/${f.companyId}/rooms/${f.room.id}`, undefined, f.head);
      expect(deleted.statusCode).toBe(200);

      expect((await pool.query(`SELECT status FROM rooms WHERE id=$1`, [f.room.id])).rows[0].status).toBe("deleted");
      expect(await countOf(`external_agent_sessions WHERE room_id=$1 AND status='connected'`, [f.room.id])).toBe(0);
      expect(await countOf(`room_members WHERE room_id=$1 AND status='active'`, [f.room.id])).toBe(0);
      // Deleting is itself something that happened, so the room gains an event rather than losing
      // any: everything said before it is still readable afterwards.
      expect(await countOf(`room_events WHERE room_id=$1`, [f.room.id])).toBeGreaterThanOrEqual(before);
      expect(await countOf(`room_events WHERE room_id=$1 AND event_type='message.sent'`, [f.room.id])).toBe(1);

      // It stops being offered, rather than lingering as something that half works.
      const rooms = (await call("GET", `/v1/companies/${f.companyId}/rooms`, undefined, f.head)).json();
      expect(rooms.rooms.find((r: any) => r.room_id === f.room.id)).toBeUndefined();
    });

    it("cannot be deleted by someone who is not its manager", async () => {
      const f = await fixture();
      const stranger = await signedInUser("Stranger");
      const refused = await call("DELETE", `/v1/companies/${f.companyId}/rooms/${f.room.id}`,
        undefined, { cookie: stranger.cookie });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query(`SELECT status FROM rooms WHERE id=$1`, [f.room.id])).rows[0].status).toBe("active");
    });
  });
});
