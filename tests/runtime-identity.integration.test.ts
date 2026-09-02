import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import type { SignInLink, SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for runtime identity tests");

class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  async deliver(link: SignInLink) { this.delivered.push(link); }
}

/**
 * Which of these six things is "the agent", and which are not.
 *
 * A human-created agent principal is a name in a workspace. A credential is a key, replaced on
 * every rebind. A session is one live connection. A room membership is where it works. A connector
 * installation is an app on a Mac. None of those is the runtime, and all of them change while the
 * runtime stays exactly what it was — which is why enrolling the same Hermes three times produced
 * JJ, JJ, and JJ2. The runtime identifies itself, once, and keeps the principal it already had.
 */
describe("one agent principal per physical runtime", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, delivery: CapturingDelivery;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  async function signedInUser(displayName = "Rocco") {
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

  /** The same physical Hermes, described exactly as the Mac would describe it. */
  const hermes = {
    runtime_type: "hermes",
    external_runtime_id: "01a06020-0000-7000-8000-00000000aaaa",
    connector_installation_id: "01a06020-0000-7000-8000-00000000bbbb",
    endpoint: "http://127.0.0.1:8181",
    runtime_version: "0.19.1",
    probe_status: "healthy" as const,
  };

  const workspace = async (cookie: string) =>
    (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie })).json();
  const connect = (companyId: string, cookie: string, body: Record<string, unknown>) =>
    call("POST", `/v1/companies/${companyId}/runtime-connections`, body, { cookie });

  it("hands the same runtime back the principal it already had", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);

    const first = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });
    expect(first.statusCode).toBe(200);
    expect(first.json().reused).toBe(false);

    // The same Mac connecting again — a reinstall, a restart, a second attempt.
    const again = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });
    expect(again.json().reused).toBe(true);
    expect(again.json().principal_id).toBe(first.json().principal_id);

    const agents = (await call("GET", `/v1/companies/${company.company_id}/agents`, undefined, { cookie: me.cookie })).json();
    expect(agents.agents).toHaveLength(1);
  });

  /** Identity is not the display name: the same runtime under a new name is the same runtime. */
  it("is not fooled by a different name", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const first = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });
    const renamed = await connect(company.company_id, me.cookie, { name: "JJ2", ...hermes });

    expect(renamed.json().reused).toBe(true);
    expect(renamed.json().principal_id).toBe(first.json().principal_id);
    // And it did not quietly rename the agent behind the person's back either.
    expect(renamed.json().display_name).toBe("JJ");
    expect((await call("GET", `/v1/companies/${company.company_id}/agents`, undefined, { cookie: me.cookie })).json().agents).toHaveLength(1);
  });

  /** A genuinely different machine is a genuinely different agent. */
  it("gives a different runtime its own principal", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const air = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });
    const mini = await connect(company.company_id, me.cookie, {
      name: "Coleman", ...hermes, external_runtime_id: "01a06020-0000-7000-8000-00000000cccc" });

    expect(mini.json().reused).toBe(false);
    expect(mini.json().principal_id).not.toBe(air.json().principal_id);
  });

  /** A second agent on one runtime is possible, but only because somebody asked for it. */
  it("creates a second agent only when explicitly chosen", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const first = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });
    const deliberate = await connect(company.company_id, me.cookie, { name: "JJ research", ...hermes, create_as_new: true });

    expect(deliberate.json().reused).toBe(false);
    expect(deliberate.json().principal_id).not.toBe(first.json().principal_id);
    // The runtime now answers as the new agent, and the old key cannot still be live.
    const live = await pool.query(
      `SELECT count(*)::int n FROM external_agent_credentials WHERE agent_principal_id=$1 AND status='active'`,
      [first.json().principal_id]);
    expect(live.rows[0].n).toBe(0);
  });

  it("reports the runtime it knows about beside the agent", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });

    const [entry] = (await call("GET", `/v1/companies/${company.company_id}/agents`, undefined, { cookie: me.cookie })).json().agents;
    expect(entry.runtime).toEqual({
      type: "hermes", version: "0.19.1",
      endpoint: "http://127.0.0.1:8181", probe_status: "healthy",
    });
  });
});
