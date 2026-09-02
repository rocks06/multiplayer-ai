import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import { buildSignInLink } from "../apps/api/src/auth/sign-in-link.js";
import type { SignInLink, SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for web invite auth tests");

/** Captures the link exactly as it would be emailed, which is the thing under test. */
class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  constructor(private readonly publicAppUrl: string) {}
  async deliver(link: SignInLink) { this.delivered.push(link); }
  get lastUrl() {
    const link = this.delivered.at(-1)!;
    return buildSignInLink(this.publicAppUrl, link.token, link.return_to);
  }
}

/**
 * Accepting a room invitation as somebody who is not signed in yet.
 *
 * The physical failure: Account B opened /join, asked to sign in, got the email, clicked it, and
 * Safari offered to open the Mac app. After allowing it, the browser was never authenticated and
 * the invitation was never accepted. The link was built from one global PUBLIC_APP_URL — the
 * marketing origin, whose /signin page hands every token to the native app — so a browser sign-in
 * had no path through at all, and the single-use token was spent somewhere the tab never heard
 * about.
 *
 * The fix is that the request says where it began. These tests are about that context surviving
 * from the click to the joined room.
 */
describe("signing in from a room invitation", () => {
  const WEB = "https://app.example.test";
  const MARKETING = "https://marketing.example.test";
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, delivery: CapturingDelivery;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    delivery = new CapturingDelivery(MARKETING);
    app = buildApp(pool, { pollIntervalMs: 20 },
      { allowHeaderPrincipal: false, signInDelivery: delivery, webAppUrl: WEB });
  });
  afterEach(async () => { await app.close(); });

  const cookieFrom = (response: any) => {
    const raw = response.headers["set-cookie"];
    return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] ?? "";
  };

  /** Account A: a workspace, a room, and an invitation to it. */
  async function invitation() {
    const email = `owner-${crypto.randomUUID()}@example.com`;
    const seed = await seedCompany(pool, "seed");
    await seedHuman(pool, seed.id, email, "Account A");
    await call("POST", "/v1/auth/sign-in-links", { email });
    const cookie = cookieFrom(await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token }));
    const company = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie })).json();
    const project = (await call("POST", `/v1/companies/${company.company_id}/projects`,
      { name: "P", objective: "O" }, { cookie })).json();
    const room = (await call("POST", `/v1/companies/${company.company_id}/projects/${project.id}/rooms`,
      { name: "TESTING #1" }, { cookie })).json();
    const invite = (await call("POST", `/v1/companies/${company.company_id}/rooms/${room.id}/invites`,
      {}, { cookie, "idempotency-key": crypto.randomUUID() })).json();
    return { cookie, company, room, invite };
  }

  it("sends a browser back to the browser, and the Mac app to the Mac app", async () => {
    await call("POST", "/v1/auth/sign-up", { name: "B", email: "b@example.com", context: "web" });
    expect(delivery.lastUrl.startsWith(`${WEB}/signin#token=`)).toBe(true);

    await call("POST", "/v1/auth/sign-in-links", { email: "b@example.com" });
    // No context named: the long-standing native destination, unchanged.
    expect(delivery.lastUrl.startsWith(`${MARKETING}/signin#token=`)).toBe(true);
  });

  /**
   * The whole flow, in the order a person does it. Account B is signed out, follows the
   * invitation, creates an account, gets the emailed link, and ends up in the room.
   */
  it("resumes the invitation and joins the room", async () => {
    const a = await invitation();
    const preview = await call("POST", "/v1/room-invites/preview", { token: a.invite.invite_token });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().room_name).toBe("TESTING #1");

    // Signed out, from the invitation, so the link must return to the browser.
    await call("POST", "/v1/auth/sign-up",
      { name: "Account B", email: "accountb@example.com", context: "web" });
    const url = delivery.lastUrl;
    expect(url.startsWith(`${WEB}/signin#token=`)).toBe(true);

    /* The token is in the fragment, which is never sent to a server — so the browser reads it out
       of the hash and posts it. Reading only the query string was one of the reasons this failed. */
    const token = new URL(url).hash.replace(/^#/, "").split("token=")[1]!;
    const session = await call("POST", "/v1/auth/sessions", { token: decodeURIComponent(token) });
    expect(session.statusCode).toBe(200);
    const bCookie = cookieFrom(session);

    // Authenticated in the browser, the held invitation is accepted.
    const accepted = await call("POST", "/v1/room-invites/accept",
      { token: a.invite.invite_token }, { cookie: bCookie });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().room_path).toContain(a.room.id);

    // And Account B is genuinely in Account A's room.
    const members = await pool.query(
      `SELECT count(*)::int n FROM room_members WHERE room_id=$1 AND status='active'`, [a.room.id]);
    expect(members.rows[0].n).toBe(2);
  });

  /**
   * Both accounts, in one room, each seeing what the other did.
   *
   * Joining is only worth anything if the room is genuinely shared afterwards. Realtime delivery
   * between two live subscribers is covered by the realtime suite; what is new here is that the
   * second account arrived through an invitation and is a full participant of the same room.
   */
  it("leaves both accounts in one shared room, each able to read the other", async () => {
    const a = await invitation();
    await call("POST", "/v1/auth/sign-up", { name: "Account B", email: "shared@example.com", context: "web" });
    const b = cookieFrom(await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token }));
    expect((await call("POST", "/v1/room-invites/accept", { token: a.invite.invite_token }, { cookie: b })).statusCode).toBe(200);

    const said = await call("POST", `/v1/companies/${a.company.company_id}/rooms/${a.room.id}/messages`,
      { body: "Welcome in" }, { cookie: a.cookie, "idempotency-key": crypto.randomUUID() });
    expect(said.statusCode).toBe(200);

    // B reads the room it was invited to, and A's message is in it.
    const asB = await call("GET", `/v1/companies/${a.company.company_id}/rooms/${a.room.id}/snapshot`, undefined, { cookie: b });
    expect(asB.statusCode).toBe(200);
    const snapshot = asB.json();
    expect(snapshot.room.name).toBe("TESTING #1");
    expect(JSON.stringify(snapshot)).toContain("Welcome in");
    // Two humans, one room, neither of them an agent.
    expect(snapshot.members.filter((m: any) => m.kind === "human")).toHaveLength(2);
  });

  it("keeps the invitation single-use", async () => {
    const a = await invitation();
    await call("POST", "/v1/auth/sign-up", { name: "B", email: "b2@example.com", context: "web" });
    const first = cookieFrom(await call("POST", "/v1/auth/sessions",
      { token: delivery.delivered.at(-1)!.token }));
    expect((await call("POST", "/v1/room-invites/accept", { token: a.invite.invite_token }, { cookie: first })).statusCode).toBe(200);

    await call("POST", "/v1/auth/sign-up", { name: "C", email: "c@example.com", context: "web" });
    const second = cookieFrom(await call("POST", "/v1/auth/sessions",
      { token: delivery.delivered.at(-1)!.token }));
    expect((await call("POST", "/v1/room-invites/accept", { token: a.invite.invite_token }, { cookie: second })).statusCode).toBeGreaterThanOrEqual(400);
  });

  /** Asking for a link still says nothing about who has an account. */
  it("answers a web-context request the same way for a stranger", async () => {
    const known = await call("POST", "/v1/auth/sign-in-links", { email: "nobody@example.com", context: "web" });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ status: "accepted" });
  });
});
