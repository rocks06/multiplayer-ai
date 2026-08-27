import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { readFile } from "node:fs/promises";
import { buildApp } from "../apps/api/src/app.js";
import { SilentSignInLinkDelivery, type SignInLink, type SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for auth integration tests");

/** Captures what a real transport would have sent, without an email provider existing. */
class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  async deliver(link: SignInLink) { this.delivered.push(link); }
}

describe("Human authentication", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, delivery: CapturingDelivery;

  // The escape hatch is OFF for every test here: this is the production path.
  const start = () => { delivery = new CapturingDelivery(); app = buildApp(pool, { pollIntervalMs: 50 }, { allowHeaderPrincipal: false, cookieSecure: true, signInDelivery: delivery }); };
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: method as any, url, payload: payload as any, headers });
  const sessionCookie = (response: any) => {
    const raw = response.headers["set-cookie"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return String(value).split(";")[0] ?? "";
  };

  async function company(name = "Auth Co") {
    const created = (await call("POST", "/v1/companies", { name })).json();
    const owner = (await call("POST", `/v1/companies/${created.id}/humans`, { email: `owner-${crypto.randomUUID()}@example.com`, display_name: "Owner" })).json();
    return { id: created.id, owner };
  }
  async function signIn(userId: string, email: string) {
    expect((await call("POST", "/v1/auth/sign-in-links", { email })).statusCode).toBe(200);
    // Always the newest link for this user; earlier ones are consumed.
    const link = delivery.delivered.filter(item => item.user_id === userId).at(-1);
    expect(link).toBeDefined();
    const session = await call("POST", "/v1/auth/sessions", { token: link!.token });
    expect(session.statusCode).toBe(200);
    return { cookie: sessionCookie(session), token: link!.token };
  }

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await bootstrap.query(await readFile("packages/db/schema.sql", "utf8"));
    await bootstrap.query(`TRUNCATE user_sessions,user_auth_tokens,agent_enrollment_tokens,external_agent_sessions,external_agent_credentials,decisions,agent_tool_calls,agent_runs,command_receipts,room_events,messages,tasks,room_members,rooms,projects,principals,agents,company_users,users,companies CASCADE`);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    start();
  });
  afterEach(async () => { await app.close(); });

  it("signs a human in through a single-use link and resolves their principal from the session", async () => {
    const f = await company();
    const { cookie } = await signIn(f.owner.user_id, (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email);

    const me = await call("GET", "/v1/auth/me", undefined, { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().companies).toEqual([expect.objectContaining({ company_id: f.id, principal_id: f.owner.principal_id })]);

    // Acting in the room works without the client ever naming a principal.
    const project = (await call("POST", `/v1/companies/${f.id}/projects`, { name: "P", objective: "O" }, { cookie })).json();
    const room = (await call("POST", `/v1/companies/${f.id}/projects/${project.id}/rooms`, { name: "R", responsibilities: "Own it" }, { cookie })).json();
    const created = await call("POST", `/v1/companies/${f.id}/rooms/${room.id}/messages`, { body: "hello" }, { cookie, "idempotency-key": crypto.randomUUID() });
    expect(created.statusCode).toBe(200);

    const attributed = await pool.query(`SELECT sender_principal_id FROM messages WHERE room_id=$1`, [room.id]);
    expect(attributed.rows[0].sender_principal_id).toBe(f.owner.principal_id);
  });

  it("stores only digests and never returns a raw token twice", async () => {
    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    const { cookie, token } = await signIn(f.owner.user_id, email);

    const stored = await pool.query(`SELECT token_hash,status FROM user_auth_tokens WHERE user_id=$1`, [f.owner.user_id]);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toContain(token);
    expect(stored.rows[0].status).toBe("consumed");

    const sessions = await pool.query(`SELECT token_hash FROM user_sessions WHERE user_id=$1`, [f.owner.user_id]);
    expect(sessions.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).toContain("mpai_session=");
    expect(sessions.rows[0].token_hash).not.toContain(cookie.split("=")[1] ?? "");
  });

  it("refuses replayed, expired, and revoked credentials", async () => {
    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;

    const { cookie, token } = await signIn(f.owner.user_id, email);
    // A consumed link can never be redeemed twice.
    expect((await call("POST", "/v1/auth/sessions", { token })).statusCode).toBe(401);

    await call("POST", "/v1/auth/sign-in-links", { email });
    const stale = delivery.delivered.at(-1)!;
    await pool.query(`UPDATE user_auth_tokens SET expires_at=now()-interval '1 minute' WHERE status='pending'`);
    expect((await call("POST", "/v1/auth/sessions", { token: stale.token })).statusCode).toBe(401);

    expect((await call("GET", "/v1/auth/me", undefined, { cookie })).statusCode).toBe(200);
    expect((await call("DELETE", "/v1/auth/sessions/current", undefined, { cookie })).statusCode).toBe(200);
    expect((await call("GET", "/v1/auth/me", undefined, { cookie })).statusCode).toBe(401);

    const { cookie: second } = await signIn(f.owner.user_id, email);
    await pool.query(`UPDATE user_sessions SET expires_at=now()-interval '1 minute' WHERE status='active'`);
    expect((await call("GET", "/v1/auth/me", undefined, { cookie: second })).statusCode).toBe(401);
  });

  it("does not accept a client-supplied identity in the production path", async () => {
    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    const { cookie } = await signIn(f.owner.user_id, email);
    const project = (await call("POST", `/v1/companies/${f.id}/projects`, { name: "P", objective: "O" }, { cookie })).json();

    // Knowing a principal id grants nothing without a session.
    expect((await call("POST", `/v1/companies/${f.id}/projects/${project.id}/rooms`, { name: "R", responsibilities: "x" }, { "x-principal-id": f.owner.principal_id })).statusCode).toBe(401);
    expect((await call("GET", `/v1/companies/${f.id}/rooms/${crypto.randomUUID()}/snapshot`)).statusCode).toBe(401);
  });

  it("keeps a session inside the companies its user belongs to", async () => {
    const a = await company("A"), b = await company("B");
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [a.owner.user_id])).rows[0].email;
    const { cookie } = await signIn(a.owner.user_id, email);
    // A valid session for company A cannot act in company B.
    expect((await call("POST", `/v1/companies/${b.id}/projects`, { name: "P", objective: "O" }, { cookie })).statusCode).toBe(403);
  });

  it("does not reveal whether an address has an account", async () => {
    const unknown = await call("POST", "/v1/auth/sign-in-links", { email: "nobody@example.com" });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ status: "accepted" });
    expect(delivery.delivered).toEqual([]);

    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    const known = await call("POST", "/v1/auth/sign-in-links", { email });
    expect(known.json()).toEqual(unknown.json());
    expect(delivery.delivered).toHaveLength(1);
  });

  it("lets an authorized company member issue a link for a colleague, and no one else", async () => {
    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    const { cookie } = await signIn(f.owner.user_id, email);

    const colleague = (await call("POST", `/v1/companies/${f.id}/humans`, { email: `mate-${crypto.randomUUID()}@example.com`, display_name: "Mate" })).json();
    const issued = await call("POST", `/v1/companies/${f.id}/users/${colleague.user_id}/sign-in-links`, {}, { cookie });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().token).toMatch(/^mpsi_/);

    // The colleague can use it, which proves the link is real and not merely displayed.
    const theirs = await call("POST", "/v1/auth/sessions", { token: issued.json().token });
    expect(theirs.statusCode).toBe(200);

    // An unauthenticated caller cannot mint links for anyone.
    expect((await call("POST", `/v1/companies/${f.id}/users/${colleague.user_id}/sign-in-links`, {})).statusCode).toBe(401);

    // Nor can a member of a different company.
    const other = await company("Other");
    const otherEmail = (await pool.query(`SELECT email FROM users WHERE id=$1`, [other.owner.user_id])).rows[0].email;
    const { cookie: otherCookie } = await signIn(other.owner.user_id, otherEmail);
    expect((await call("POST", `/v1/companies/${f.id}/users/${colleague.user_id}/sign-in-links`, {}, { cookie: otherCookie })).statusCode).toBe(403);
  });

  it("marks the session cookie httpOnly and same-site, and secure when configured", async () => {
    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    await call("POST", "/v1/auth/sign-in-links", { email });
    const response = await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token });
    const raw = String(response.headers["set-cookie"]);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Secure");
    expect(raw).toContain("Path=/");
  });

  it("keeps the header escape hatch available only when explicitly enabled", async () => {
    const f = await company();
    const permissive = buildApp(new Pool({ connectionString }), { pollIntervalMs: 50 }, { allowHeaderPrincipal: true, signInDelivery: new SilentSignInLinkDelivery() });
    try {
      const allowed = await permissive.inject({ method: "POST", url: `/v1/companies/${f.id}/projects`, payload: { name: "P", objective: "O" }, headers: { "x-principal-id": f.owner.principal_id } });
      expect(allowed.statusCode).toBe(200);
      // The same call is rejected by the default app, where the hatch is off.
      expect((await call("POST", `/v1/companies/${f.id}/projects`, { name: "P2", objective: "O" }, { "x-principal-id": f.owner.principal_id })).statusCode).toBe(401);
    } finally { await permissive.close(); }
  });
});
