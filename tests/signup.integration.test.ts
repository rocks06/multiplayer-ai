import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import type { SignInLink, SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for signup tests");

class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  async deliver(link: SignInLink) { this.delivered.push(link); }
}

/**
 * Creating an account, and the two doors that used to be open beside it.
 *
 * Signing up has to work for someone nobody has heard of, and it must not become a way to find
 * out who else has an account.
 */
describe("Creating an account", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, delivery: CapturingDelivery;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    delivery = new CapturingDelivery();
    // Production shape: no header escape hatch, no bootstrap routes.
    app = buildApp(pool, { pollIntervalMs: 50 }, { allowHeaderPrincipal: false, signInDelivery: delivery });
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it("takes somebody nobody has heard of all the way to a workspace", async () => {
    const email = `new-${crypto.randomUUID()}@example.com`;
    const created = await call("POST", "/v1/auth/sign-up", { name: "Priya Raman", email });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ status: "accepted" });

    // The link they were sent is the same single-use link signing in uses.
    const session = await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token });
    expect(session.statusCode).toBe(200);
    const cookie = String(session.headers["set-cookie"]).split(";")[0]!;

    const me = (await call("GET", "/v1/auth/me", undefined, { cookie })).json();
    expect(me.user.display_name).toBe("Priya Raman");
    // Signing up creates a person, not a company: naming the workspace is the next, signed-in step.
    expect(me.companies).toEqual([]);

    const workspace = (await call("POST", "/v1/workspaces", { name: "Northwind" }, { cookie })).json();
    expect(workspace.name).toBe("Northwind");
  });

  it("says exactly the same thing whether or not the address is known", async () => {
    const email = `known-${crypto.randomUUID()}@example.com`;
    const first = await call("POST", "/v1/auth/sign-up", { name: "Priya", email });
    const second = await call("POST", "/v1/auth/sign-up", { name: "Someone Else", email });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());

    // The second attempt neither creates a second account nor renames the first.
    const users = await pool.query(`SELECT display_name FROM users WHERE lower(email)=lower($1)`, [email]);
    expect(users.rowCount).toBe(1);
    expect(users.rows[0]!.display_name).toBe("Priya");
  });

  it("treats an address as the same address however it was typed", async () => {
    const email = `Case-${crypto.randomUUID()}@Example.COM`;
    await call("POST", "/v1/auth/sign-up", { name: "Priya", email });
    await call("POST", "/v1/auth/sign-up", { name: "Priya", email: email.toLowerCase() });
    const users = await pool.query(`SELECT count(*)::int AS n FROM users WHERE lower(email)=lower($1)`, [email]);
    expect(users.rows[0]!.n).toBe(1);
  });

  it("refuses a request that is not an account", async () => {
    expect((await call("POST", "/v1/auth/sign-up", { name: "", email: "a@b.com" })).statusCode).toBe(400);
    expect((await call("POST", "/v1/auth/sign-up", { name: "Priya", email: "not-an-address" })).statusCode).toBe(400);
  });

  it("closes the doors that used to let anyone create a company or a person", async () => {
    // These were the developer-beta bootstrap routes. In production configuration they are gone,
    // so signing up is the only way in.
    expect((await call("POST", "/v1/companies", { name: "Intruder Co" })).statusCode).toBe(404);
    expect((await call("POST", `/v1/companies/${crypto.randomUUID()}/humans`,
      { email: "intruder@example.com", display_name: "Intruder" })).statusCode).toBe(404);

    const companies = await pool.query(`SELECT count(*)::int AS n FROM companies`);
    expect(companies.rows[0]!.n).toBe(0);
  });
});
