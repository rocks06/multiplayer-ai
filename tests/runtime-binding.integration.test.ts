import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for runtime-binding tests");

/**
 * One runtime is one agent, and one agent has one live binding.
 *
 * Opening a session used to insert a row and retire nothing, and minting a credential did the
 * same. Every presence query resolves duplicates with `ORDER BY last_seen_at DESC LIMIT 1`, so
 * the answer depended on whichever heartbeat landed last: an agent flickered between connected
 * and absent with nothing wrong with the connection, and a reconnect storm — fourteen in seven
 * seconds, observed on a real Mac — left fourteen rows all claiming to be live.
 */
describe("one live binding per agent", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    pool = new Pool({ connectionString });
    await truncateAll(pool);
    app = buildApp(pool, { pollIntervalMs: 20 }, { allowHeaderPrincipal: true });
  });
  afterEach(async () => { await app.close(); });

  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  async function fixture() {
    const company = await seedCompany(pool, "Binding Co");
    const owner = await seedHuman(pool, company.id, `owner-${crypto.randomUUID()}@example.com`, "Owner");
    const head = { "x-principal-id": owner.principal_id };
    const project = (await call("POST", `/v1/companies/${company.id}/projects`,
      { name: "P", objective: "O" }, head)).json();
    const room = (roomName: string) => call("POST", `/v1/companies/${company.id}/projects/${project.id}/rooms`,
      { name: roomName }, head).then(r => r.json());
    const roomA = await room("Room A"), roomB = await room("Room B");
    const agent = (await call("POST", `/v1/companies/${company.id}/agents`, { name: "JJ" }, head)).json();
    for (const r of [roomA, roomB]) {
      await call("POST", `/v1/companies/${company.id}/rooms/${r.id}/members`,
        { principal_id: agent.principal_id, role: "worker_agent", responsibilities: "" },
        { ...head, "idempotency-key": `m-${r.id}` });
    }
    return { company, owner, head, agent, roomA, roomB };
  }

  const mint = async (f: any, label = "JJ's Mac") =>
    (await call("POST", `/v1/companies/${f.company.id}/agents/${f.agent.principal_id}/gateway-credentials`,
      { label }, f.head)).json();

  const openSession = (token: string, roomId: string) =>
    call("POST", "/v1/agent-gateway/v1/sessions", { room_id: roomId },
      { authorization: `Bearer ${token}` });

  const liveSessions = async (f: any) => (await pool.query(
    `SELECT id,room_id,status FROM external_agent_sessions
     WHERE agent_principal_id=$1 AND status='connected'`, [f.agent.principal_id])).rows;
  const activeCredentials = async (f: any) => (await pool.query(
    `SELECT id,status FROM external_agent_credentials
     WHERE agent_principal_id=$1 AND status='active'`, [f.agent.principal_id])).rows;
  const principals = async (f: any) => (await pool.query(
    `SELECT id FROM principals WHERE company_id=$1 AND kind='agent'`, [f.company.id])).rows;

  /**
   * The failure this was reported as: JJ connects, works for a few seconds, then the Mac says its
   * access was removed while the room goes on showing it connected and working.
   *
   * Minting a credential retires the one before it, and `authenticateSession` requires the owning
   * credential to be active — so every session of the replaced credential was refused from that
   * instant. Nothing wrote that down. The rows still said 'connected', so Home reported a live
   * agent that could not make a single authenticated call, and the two surfaces disagreed for as
   * long as anyone cared to look.
   */
  it("ends the sessions a replaced credential was running", async () => {
    const f = await fixture();
    const first = await mint(f);
    const session = (await openSession(first.credential_token, f.roomA.id)).json();
    expect((await call("POST", `/v1/agent-gateway/v1/sessions/${session.session_id}/heartbeat`,
      { runtime_status: "working" }, { authorization: `Bearer ${session.session_token}` })).statusCode).toBe(200);

    await mint(f);   // a second bind, for the same agent on the same Mac

    // The session is refused...
    const refused = await call("GET", `/v1/agent-gateway/v1/sessions/${session.session_id}`,
      undefined, { authorization: `Bearer ${session.session_token}` });
    expect(refused.statusCode).toBe(401);
    // ...so it must not still be claiming to be live.
    const row = (await pool.query(`SELECT status FROM external_agent_sessions WHERE id=$1`, [session.session_id])).rows[0];
    expect(row.status).toBe("superseded");
    expect(await liveSessions(f)).toHaveLength(0);
  });

  /** The same rule on the enrollment-code path, which mints a credential just as surely. */
  it("ends the sessions a redeemed enrollment code replaces", async () => {
    const f = await fixture();
    const first = await mint(f);
    const session = (await openSession(first.credential_token, f.roomA.id)).json();

    const code = (await call("POST", `/v1/companies/${f.company.id}/agents/${f.agent.principal_id}/enrollments`,
      { label: "JJ's Mac", room_id: f.roomA.id }, f.head)).json();
    expect((await call("POST", "/v1/agent-gateway/v1/enroll",
      { code: code.enrollment_code, device_label: "Air" })).statusCode).toBe(200);

    const row = (await pool.query(`SELECT status FROM external_agent_sessions WHERE id=$1`, [session.session_id])).rows[0];
    expect(row.status).toBe("superseded");
  });

  it("survives a reconnect storm with exactly one live session", async () => {
    const f = await fixture();
    const credential = await mint(f);
    // Fourteen, because that is what a person mashing Reconnect actually produced.
    for (let i = 0; i < 14; i++) {
      expect((await openSession(credential.credential_token, f.roomA.id)).statusCode).toBe(200);
    }
    expect(await liveSessions(f)).toHaveLength(1);
    // The rest are superseded — not revoked, which a person did, and not offline, which a
    // network did. Neither would be true.
    const superseded = await pool.query(
      `SELECT count(*)::int n FROM external_agent_sessions WHERE agent_principal_id=$1 AND status='superseded'`,
      [f.agent.principal_id]);
    expect(superseded.rows[0].n).toBe(13);
  });

  it("lets only one of two simultaneous opens win", async () => {
    const f = await fixture();
    const credential = await mint(f);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => openSession(credential.credential_token, f.roomA.id)));
    const accepted = results.filter(r => r.status === "fulfilled" && (r.value as any).statusCode === 200);
    expect(accepted.length).toBeGreaterThan(0);
    expect(await liveSessions(f)).toHaveLength(1);
  });

  it("keeps one active credential however often the agent is re-enrolled", async () => {
    const f = await fixture();
    const first = await mint(f);
    const second = await mint(f);
    expect(await activeCredentials(f)).toHaveLength(1);
    expect((await activeCredentials(f))[0].id).toBe(second.id);

    // The retired key stops working, which is the point of retiring it.
    expect((await openSession(first.credential_token, f.roomA.id)).statusCode).toBe(401);
    expect((await openSession(second.credential_token, f.roomA.id)).statusCode).toBe(200);
  });

  /** Moving rooms is the same machine, so it must not become a second agent. */
  it("moves an agent between rooms without creating a second identity", async () => {
    const f = await fixture();
    const before = await principals(f);

    const inA = await mint(f);
    expect((await openSession(inA.credential_token, f.roomA.id)).statusCode).toBe(200);
    expect((await liveSessions(f))[0].room_id).toBe(f.roomA.id);

    // The move: a fresh room-scoped credential for the same principal.
    const inB = await mint(f, "JJ's Mac (Room B)");
    expect((await openSession(inB.credential_token, f.roomB.id)).statusCode).toBe(200);

    const live = await liveSessions(f);
    expect(live).toHaveLength(1);
    expect(live[0].room_id).toBe(f.roomB.id);
    expect(await activeCredentials(f)).toHaveLength(1);
    // Same agent throughout. This is the class of bug that produced several JJs.
    expect(await principals(f)).toEqual(before);
  });

  it("refuses a stale session token once a newer one has superseded it", async () => {
    const f = await fixture();
    const credential = await mint(f);
    const first = (await openSession(credential.credential_token, f.roomA.id)).json();
    const second = (await openSession(credential.credential_token, f.roomA.id)).json();
    expect(first.session_id).not.toBe(second.session_id);
    expect(second.superseded).toContain(first.session_id);

    const stale = await call("POST", `/v1/agent-gateway/v1/sessions/${first.session_id}/heartbeat`,
      { runtime_status: "idle" }, { authorization: `Bearer ${first.session_token}` });
    expect(stale.statusCode).toBe(401);

    const live = await call("POST", `/v1/agent-gateway/v1/sessions/${second.session_id}/heartbeat`,
      { runtime_status: "idle" }, { authorization: `Bearer ${second.session_token}` });
    expect(live.statusCode).toBe(200);
  });

  /**
   * The guarantee is in the database, not only in the service. A future caller that forgets to
   * retire the previous binding must fail rather than quietly create the state this fixes.
   */
  it("cannot represent two live bindings even when written to directly", async () => {
    const f = await fixture();
    const credential = await mint(f);
    const session = (await openSession(credential.credential_token, f.roomA.id)).json();

    await expect(pool.query(
      `INSERT INTO external_agent_sessions(id,credential_id,company_id,agent_principal_id,room_id,session_token_hash,status)
       VALUES($1,$2,$3,$4,$5,repeat('a',64),'connected')`,
      [crypto.randomUUID(), credential.id, f.company.id, f.agent.principal_id, f.roomA.id]),
    ).rejects.toThrow(/external_agent_sessions_one_live|duplicate key/);

    await expect(pool.query(
      `INSERT INTO external_agent_credentials(id,company_id,agent_principal_id,token_hash,token_prefix,label,created_by_principal_id,status)
       VALUES($1,$2,$3,repeat('b',64),'bbbb','second',$4,'active')`,
      [crypto.randomUUID(), f.company.id, f.agent.principal_id, f.owner.principal_id]),
    ).rejects.toThrow(/external_agent_credentials_one_active|duplicate key/);

    expect(session.status).toBe("connected");
  });
});
