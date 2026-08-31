import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { readFile } from "node:fs/promises";
import { buildApp } from "../apps/api/src/app.js";
import { SilentSignInLinkDelivery, type SignInLink, type SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";
import { truncateAll } from "./support/database.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

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
    const created = (await seedCompany(pool, ({ name }).name));
    const owner = (await seedHuman(pool, created.id, ({ email: `owner-${crypto.randomUUID()}@example.com`, display_name: "Owner" }).email, ({ email: `owner-${crypto.randomUUID()}@example.com`, display_name: "Owner" }).display_name));
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
    await truncateAll(bootstrap);
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

  /**
   * With a real provider, sending is the only thing that happens for a known address and does not
   * happen for an unknown one — so a provider outage would turn this route into an account
   * oracle: 500 for addresses that exist, 200 for addresses that do not. The failure is recorded
   * server-side and the answer stays identical.
   */
  it("stays indistinguishable when the email provider is failing", async () => {
    const failures: unknown[] = [];
    const exploding = { async deliver() { throw new Error("provider unavailable") } };
    const failingApp = buildApp(new Pool({ connectionString }), { pollIntervalMs: 50 },
      { allowHeaderPrincipal: false, cookieSecure: true, signInDelivery: exploding });
    const ask = (email: string) =>
      failingApp.inject({ method: "POST", url: "/v1/auth/sign-in-links", payload: { email } });

    const f = await company("Outage Co");
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;

    const known = await ask(email);
    const unknown = await ask("nobody-at-all@example.com");
    expect(known.statusCode).toBe(200);
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual({ status: "accepted" });
    expect(known.json()).toEqual(unknown.json());

    // Signing up is the same route into delivery and must behave the same way.
    const signUp = await failingApp.inject({ method: "POST", url: "/v1/auth/sign-up",
      payload: { name: "New", email: `fresh-${crypto.randomUUID()}@example.com` } });
    expect(signUp.statusCode).toBe(200);
    expect(signUp.json()).toEqual({ status: "accepted" });
    void failures;
    await failingApp.close();
  });

  /** A link that could not be delivered is still a link that was minted, and still single-use. */
  it("keeps a token single-use and short-lived however it was delivered", async () => {
    const f = await company("Semantics Co");
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    expect((await call("POST", "/v1/auth/sign-in-links", { email })).statusCode).toBe(200);
    const link = delivery.delivered.at(-1)!;

    // Fifteen minutes, decided by the server and not by whoever sends the mail.
    const minutes = (Date.parse(link.expires_at) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThanOrEqual(15);

    const first = await call("POST", "/v1/auth/sessions", { token: link.token });
    expect(first.statusCode).toBe(200);
    const replay = await call("POST", "/v1/auth/sessions", { token: link.token });
    expect(replay.statusCode).toBe(401);

    // And only the digest was ever stored.
    const stored = await pool.query(`SELECT token_hash FROM user_auth_tokens WHERE user_id=$1`, [link.user_id]);
    for (const row of stored.rows) expect(row.token_hash).not.toContain(link.token);
  });

  it("says how sign-in links are delivered, so the product can say the right thing", async () => {
    const configured = buildApp(new Pool({ connectionString }), { pollIntervalMs: 50 },
      { allowHeaderPrincipal: false, environment: { SIGN_IN_DELIVERY: "logging" } });
    const answer = await configured.inject({ method: "GET", url: "/v1/app-config" });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ sign_in_delivery: "logging" });
    await configured.close();
  });

  /**
   * The limit has to hold on the live route, not only in the counter. And it has to stay silent
   * about accounts: a 429 for a known address and a 200 for an unknown one would answer the
   * question these routes exist to refuse.
   */
  it("stops the sign-in route being used as an email relay, without saying who has an account", async () => {
    const limited = buildApp(new Pool({ connectionString }), { pollIntervalMs: 50 },
      { allowHeaderPrincipal: false, cookieSecure: true, signInDelivery: new SilentSignInLinkDelivery() });
    const ask = (email: string) =>
      limited.inject({ method: "POST", url: "/v1/auth/sign-in-links", payload: { email } });

    const f = await company("Relay Co");
    const known = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    const unknown = `nobody-${crypto.randomUUID()}@example.com`;

    const knownCodes: number[] = [];
    const unknownCodes: number[] = [];
    for (let i = 0; i < 7; i++) knownCodes.push((await ask(known)).statusCode);
    for (let i = 0; i < 7; i++) unknownCodes.push((await ask(unknown)).statusCode);

    // Somewhere in there the door closes...
    expect(knownCodes).toContain(429);
    // ...and it closes at exactly the same point for an address that does not exist.
    expect(knownCodes).toEqual(unknownCodes);
    expect(knownCodes[0]).toBe(200);
    await limited.close();
  });

  it("lets an authorized company member issue a link for a colleague, and no one else", async () => {
    const f = await company();
    const email = (await pool.query(`SELECT email FROM users WHERE id=$1`, [f.owner.user_id])).rows[0].email;
    const { cookie } = await signIn(f.owner.user_id, email);

    const colleague = (await seedHuman(pool, f.id, ({ email: `mate-${crypto.randomUUID()}@example.com`, display_name: "Mate" }).email, ({ email: `mate-${crypto.randomUUID()}@example.com`, display_name: "Mate" }).display_name));
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
