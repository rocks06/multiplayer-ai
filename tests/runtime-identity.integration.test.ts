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

  const lookupUrl = (companyId: string, runtimeType = hermes.runtime_type, externalId = hermes.external_runtime_id) =>
    `/v1/companies/${companyId}/runtime-connections?${new URLSearchParams({runtime_type: runtimeType, external_runtime_id: externalId})}`;

  // Capture complete operational rows (including timestamps and credential hashes), not just counts.
  async function runtimeRows() {
    const tables = ['runtime_installations', 'agent_runtime_bindings', 'principals', 'agents',
      'external_agent_credentials', 'external_agent_sessions'];
    return Promise.all(tables.map(async table => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
  }

  it("fresh user enrolls without a code and restores the same identity with the saved credential", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const headers = {cookie: me.cookie, 'idempotency-key':crypto.randomUUID()};
    const project = await call('POST', `/v1/companies/${company.company_id}/projects`, {name:'Discovery project', objective:'Verify local onboarding'}, headers);
    expect(project.statusCode, project.body).toBe(200);
    const room = await call('POST', `/v1/companies/${company.company_id}/projects/${project.json().id}/rooms`, {name:'Selected room'}, headers);
    expect(room.statusCode, room.body).toBe(200);
    expect((await call('GET', lookupUrl(company.company_id), undefined, headers)).json()).toEqual({runtime:null});
    const bound = await connect(company.company_id, me.cookie, {name:'Discovered agent', ...hermes});
    expect([200,201], bound.body).toContain(bound.statusCode);
    const principal = bound.json().principal_id;
    const membership = await call('POST', `/v1/companies/${company.company_id}/rooms/${room.json().id}/members`,
      {principal_id:principal, role:'worker_agent', responsibilities:''}, {...headers,'idempotency-key':crypto.randomUUID()});
    expect([200,201], membership.body).toContain(membership.statusCode);
    const credential = await call('POST', `/v1/companies/${company.company_id}/agents/${principal}/gateway-credentials`, {label:'Isolated fresh Mac'}, headers);
    expect([200,201], credential.body).toContain(credential.statusCode);
    const machine = {authorization:`Bearer ${credential.json().credential_token}`};
    const session = () => call('POST', '/v1/agent-gateway/v1/sessions', {room_id:room.json().id, runtime_status:'idle'}, machine);
    const first = await session();
    expect([200,201], first.body).toContain(first.statusCode);
    expect(first.json().session_token).toBeTruthy();
    const known = (await call('GET', lookupUrl(company.company_id), undefined, headers)).json().runtime;
    expect(known).toEqual({principal_id:principal, display_name:'Discovered agent'});
    const restored = await session();
    expect([200,201], restored.body).toContain(restored.statusCode);
    expect(restored.json().session_id).not.toBe(first.json().session_id);
    expect((await call('GET', `/v1/companies/${company.company_id}/agents`, undefined, headers)).json().agents).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int n FROM external_agent_credentials WHERE agent_principal_id=$1 AND status='active'`,[principal])).rows[0].n).toBe(1);
  });

  it("looks up a selected stable binding before naming, with no operational writes or secrets", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const before = await runtimeRows();
    const absent = await call('GET', lookupUrl(company.company_id), undefined, {cookie: me.cookie});
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({runtime: null});
    expect(await runtimeRows()).toEqual(before);
    const first = (await connect(company.company_id, me.cookie, {name: 'Known name', ...hermes})).json();
    const bound = await runtimeRows();
    const known = await call('GET', lookupUrl(company.company_id), undefined, {cookie: me.cookie});
    expect(known.statusCode).toBe(200);
    expect(known.headers['cache-control']).toBe('no-store');
    expect(known.json()).toEqual({runtime: {principal_id: first.principal_id, display_name: 'Known name'}});
    expect((await call('GET', lookupUrl(company.company_id, 'another-adapter'), undefined, {cookie: me.cookie})).json()).toEqual({runtime: null});
    expect((await call('GET', lookupUrl(company.company_id, 'hermes', crypto.randomUUID()), undefined, {cookie: me.cookie})).json()).toEqual({runtime: null});
    expect(await runtimeRows()).toEqual(bound);
    const other = await workspace(me.cookie);
    expect((await call('GET', lookupUrl(other.company_id), undefined, {cookie: me.cookie})).json()).toEqual({runtime: null});
  });

  it("looks up only the current active binding, principal and agent", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    await connect(company.company_id, me.cookie, {name: 'Old', ...hermes});
    const next = (await connect(company.company_id, me.cookie, {name: 'Current', ...hermes, create_as_new: true})).json();
    const lookup = () => call('GET', lookupUrl(company.company_id), undefined, {cookie: me.cookie});
    expect((await lookup()).json()).toEqual({runtime: {principal_id: next.principal_id, display_name: 'Current'}});
    await pool.query(`UPDATE principals SET status='disabled' WHERE id=$1`, [next.principal_id]);
    expect((await lookup()).json()).toEqual({runtime: null});
    await pool.query(`UPDATE principals SET status='active' WHERE id=$1`, [next.principal_id]);
    await pool.query(`UPDATE agents SET status='paused' WHERE id=$1`, [next.agent_id]);
    expect((await lookup()).json()).toEqual({runtime: null});
    await pool.query(`UPDATE agents SET status='active' WHERE id=$1`, [next.agent_id]);
    await call('DELETE', `/v1/companies/${company.company_id}/agents/${next.principal_id}`, undefined, {cookie: me.cookie});
    expect((await lookup()).json()).toEqual({runtime: null});
  });

  it("denies missing sessions, outsiders, room-only users and revoked workspace access", async () => {
    const me = await signedInUser();
    const outsider = await signedInUser('Outsider');
    const company = await workspace(me.cookie);
    const known = (await connect(company.company_id, me.cookie, {name: 'Private', ...hermes})).json();
    const url = lookupUrl(company.company_id);
    const before = await runtimeRows();
    expect((await call('GET', url)).statusCode).toBe(401);
    expect((await call('GET', url, undefined, {'x-principal-id': known.principal_id})).statusCode).toBe(401);
    expect((await call('GET', url, undefined, {cookie: outsider.cookie})).statusCode).toBe(403);
    await pool.query(`UPDATE company_users SET access_scope='room_only' WHERE company_id=$1`, [company.company_id]);
    expect((await call('GET', url, undefined, {cookie: me.cookie})).statusCode).toBe(403);
    await pool.query(`UPDATE company_users SET access_scope='workspace',status='removed' WHERE company_id=$1`, [company.company_id]);
    expect((await call('GET', url, undefined, {cookie: me.cookie})).statusCode).toBe(403);
    expect(await runtimeRows()).toEqual(before);
  });

  it("denies agent principals even through the explicit development header escape hatch", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const agent = (await connect(company.company_id, me.cookie, {name: 'Agent', ...hermes})).json();
    const devApp = buildApp(new Pool({connectionString}), {}, {allowHeaderPrincipal: true, signInDelivery: delivery});
    try {
      const response = await devApp.inject({method: 'GET', url: lookupUrl(company.company_id), headers: {'x-principal-id': agent.principal_id}});
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('workspace_access_denied');
    } finally { await devApp.close(); }
  });

  it("validates the lookup key without creating any identity", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const before = await runtimeRows();
    for (const query of ['', '?runtime_type=hermes', '?runtime_type=&external_runtime_id='+hermes.external_runtime_id,
      '?runtime_type=hermes&external_runtime_id=not-a-uuid']) {
      expect((await call('GET', `/v1/companies/${company.company_id}/runtime-connections${query}`, undefined, {cookie: me.cookie})).statusCode).toBe(400);
    }
    expect(await runtimeRows()).toEqual(before);
  });

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

  /**
   * The connector is reinstalled; the machine is not.
   *
   * A connector installation id changes when the app is replaced, and the runtime id does not —
   * it is kept outside any build-specific directory for exactly this reason. Treating the
   * connector as the identity would mint a fresh agent every time the app was updated.
   */
  it("reuses the principal when the connector is reinstalled on the same runtime", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const before = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });

    const after = await connect(company.company_id, me.cookie, {
      name: "JJ", ...hermes,
      connector_installation_id: "01a06020-0000-7000-8000-00000000dddd",
    });
    expect(after.json().reused).toBe(true);
    expect(after.json().principal_id).toBe(before.json().principal_id);
    expect((await call("GET", `/v1/companies/${company.company_id}/agents`, undefined, { cookie: me.cookie })).json().agents).toHaveLength(1);
  });

  /**
   * A stale bridge left running from an earlier test must not become a second agent.
   *
   * The Air still had an old bridge process running against a previous identity file. Nothing
   * about it — its process, its arguments, the identity file it was started with — takes part in
   * deciding who this runtime is, so connecting while it runs changes nothing.
   */
  it("is unmoved by whatever else is running on the machine", async () => {
    const me = await signedInUser();
    const company = await workspace(me.cookie);
    const first = await connect(company.company_id, me.cookie, { name: "JJ", ...hermes });
    // Same runtime, different endpoint string and a different name, as a restart may well report.
    const again = await connect(company.company_id, me.cookie, {
      name: "JJ (bridge)", ...hermes, endpoint: "cli:/opt/elsewhere/hermes",
    });
    expect(again.json().reused).toBe(true);
    expect(again.json().principal_id).toBe(first.json().principal_id);
    const principals = await pool.query(
      `SELECT count(*)::int n FROM principals WHERE company_id=$1 AND kind='agent'`, [company.company_id]);
    expect(principals.rows[0].n).toBe(1);
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
