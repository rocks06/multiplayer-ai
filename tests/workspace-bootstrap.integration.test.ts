import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { FakeExternalAgentClient } from "./fake-external-agent.js";
import { truncateAll } from "./support/database.js";
import type { SignInLink, SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for workspace bootstrap tests");

class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  async deliver(link: SignInLink) { this.delivered.push(link); }
}

describe("Workspace bootstrap and agent listing", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, baseUrl: string, delivery: CapturingDelivery;
  const clients = new Set<FakeExternalAgentClient>();
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  /** A signed-in user with no workspace, which is where a real person starts. */
  async function signedInUser(displayName = "Rocco") {
    const email = `user-${crypto.randomUUID()}@example.com`;
    // The unauthenticated developer bootstrap still exists; a user record is all that is needed.
    const seed = (await call("POST", "/v1/companies", { name: "seed" })).json();
    const human = (await call("POST", `/v1/companies/${seed.id}/humans`, { email, display_name: displayName })).json();
    await call("POST", "/v1/auth/sign-in-links", { email });
    const session = await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token });
    const raw = session.headers["set-cookie"];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] ?? "";
    return { email, cookie, user_id: human.user_id, seedCompanyId: seed.id };
  }

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    delivery = new CapturingDelivery();
    // The escape hatch stays off: this is the authenticated product path.
    app = buildApp(pool, { pollIntervalMs: 20 }, { allowHeaderPrincipal: false, signInDelivery: delivery });
    baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterEach(async () => { for (const c of clients) c.close(); clients.clear(); await app.close(); });

  describe("authenticated workspace creation", () => {
    it("makes the creator a member with a usable principal in one step", async () => {
      const me = await signedInUser();
      const created = await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie });
      expect(created.statusCode).toBe(200);
      const workspace = created.json();
      expect(workspace.name).toBe("Acme");
      expect(workspace.display_name).toBe("Rocco");

      // Membership and principal exist without any second client-side call.
      const membership = await pool.query(`SELECT status FROM company_users WHERE company_id=$1 AND user_id=$2`, [workspace.company_id, me.user_id]);
      expect(membership.rows[0].status).toBe("active");
      const principal = await pool.query(`SELECT id,kind,status FROM principals WHERE company_id=$1 AND user_id=$2`, [workspace.company_id, me.user_id]);
      expect(principal.rows[0]).toEqual({ id: workspace.principal_id, kind: "human", status: "active" });

      // The new workspace is immediately visible to the session that made it.
      const me2 = await call("GET", "/v1/auth/me", undefined, { cookie: me.cookie });
      expect(me2.json().companies.map((c: any) => c.company_id)).toContain(workspace.company_id);

      // And it is immediately usable: the creator can build a room and become its manager.
      const project = (await call("POST", `/v1/companies/${workspace.company_id}/projects`, { name: "P", objective: "O" }, { cookie: me.cookie })).json();
      const room = await call("POST", `/v1/companies/${workspace.company_id}/projects/${project.id}/rooms`, { name: "Launch", responsibilities: "Own it" }, { cookie: me.cookie });
      expect(room.statusCode).toBe(200);
      const role = await pool.query(`SELECT role FROM room_members WHERE room_id=$1 AND principal_id=$2`, [room.json().id, workspace.principal_id]);
      expect(role.rows[0].role).toBe("manager");
    });

    it("requires a session and leaves nothing behind when it refuses", async () => {
      const before = await pool.query(`SELECT count(*)::int n FROM companies`);
      expect((await call("POST", "/v1/workspaces", { name: "Nope" })).statusCode).toBe(401);
      expect((await call("POST", "/v1/workspaces", { name: "Nope" }, { cookie: "mpai_session=not-a-real-token" })).statusCode).toBe(401);
      // A refused request must not leave a company with no members behind.
      const after = await pool.query(`SELECT count(*)::int n FROM companies`);
      expect(after.rows[0].n).toBe(before.rows[0].n);

      const me = await signedInUser();
      expect((await call("POST", "/v1/workspaces", { name: "" }, { cookie: me.cookie })).statusCode).toBe(400);
      // No company anywhere is left without a member, by either path.
      const orphans = await pool.query(`SELECT count(*)::int n FROM companies c WHERE NOT EXISTS (SELECT 1 FROM company_users cu WHERE cu.company_id=c.id)`);
      expect(orphans.rows[0].n).toBe(0);
    });

    it("keeps workspaces isolated from one another", async () => {
      const a = await signedInUser("A"), b = await signedInUser("B");
      const mine = (await call("POST", "/v1/workspaces", { name: "Mine" }, { cookie: a.cookie })).json();
      expect((await call("POST", `/v1/companies/${mine.company_id}/projects`, { name: "P", objective: "O" }, { cookie: b.cookie })).statusCode).toBe(403);
      expect((await call("GET", `/v1/companies/${mine.company_id}/agents`, undefined, { cookie: b.cookie })).statusCode).toBe(403);
    });
  });

  describe("room listing", () => {
    /* Someone returning after sign-in, or interrupted part-way through setting up, has to be
       able to find their way back from workspace state rather than from what agents happen to
       have joined. */
    it("lists the rooms a person can open, including one with no agents in it", async () => {
      const me = await signedInUser();
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();
      const project = (await call("POST", `/v1/companies/${workspace.company_id}/projects`, { name: "Developer API", objective: "Launch it" }, { cookie: me.cookie })).json();
      const room = (await call("POST", `/v1/companies/${workspace.company_id}/projects/${project.id}/rooms`, { name: "API Launch", responsibilities: "Own it" }, { cookie: me.cookie })).json();

      const listed = await call("GET", `/v1/companies/${workspace.company_id}/rooms`, undefined, { cookie: me.cookie });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ rooms: [{ room_id: room.id, name: "API Launch", project_id: project.id, project_name: "Developer API", objective: "Launch it" }] });
    });

    it("is empty for a new workspace rather than absent", async () => {
      const me = await signedInUser();
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();
      expect((await call("GET", `/v1/companies/${workspace.company_id}/rooms`, undefined, { cookie: me.cookie })).json()).toEqual({ rooms: [] });
    });

    it("refuses an anonymous caller and a stranger to the company", async () => {
      const me = await signedInUser();
      const stranger = await signedInUser("Dana");
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();
      const project = (await call("POST", `/v1/companies/${workspace.company_id}/projects`, { name: "P", objective: "O" }, { cookie: me.cookie })).json();
      await call("POST", `/v1/companies/${workspace.company_id}/projects/${project.id}/rooms`, { name: "Launch", responsibilities: "Own it" }, { cookie: me.cookie });

      expect((await call("GET", `/v1/companies/${workspace.company_id}/rooms`)).statusCode).toBe(401);
      expect((await call("GET", `/v1/companies/${workspace.company_id}/rooms`, undefined, { cookie: stranger.cookie })).statusCode).toBe(403);
    });
  });

  describe("adding an agent", () => {
    /* Creating an agent mints a principal inside a company. It was once possible to do that
       with no session at all, naming any user as the owner; these hold that door shut. */
    it("refuses an anonymous caller", async () => {
      const me = await signedInUser();
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();

      const anonymous = await call("POST", `/v1/companies/${workspace.company_id}/agents`, { name: "Intruder" });
      expect(anonymous.statusCode).toBe(401);

      // And nothing was created on the way to being refused.
      const listed = (await call("GET", `/v1/companies/${workspace.company_id}/agents`, undefined, { cookie: me.cookie })).json();
      expect(listed.agents).toHaveLength(0);
    });

    it("will not let a caller choose someone else as the owner", async () => {
      const me = await signedInUser("Rocco");
      const other = await signedInUser("Dana");
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();

      // The old escape route: naming another user in the body. It is no longer read at all.
      const created = await call("POST", `/v1/companies/${workspace.company_id}/agents`,
        { name: "Coleman", owner_user_id: other.user_id }, { cookie: me.cookie });
      expect(created.statusCode).toBe(200);

      const [entry] = (await call("GET", `/v1/companies/${workspace.company_id}/agents`, undefined, { cookie: me.cookie })).json().agents;
      expect(entry.owner_display_name).toBe("Rocco");
    });

    it("refuses a signed-in user acting on a company that is not theirs", async () => {
      const me = await signedInUser();
      const stranger = await signedInUser("Dana");
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();

      const crossCompany = await call("POST", `/v1/companies/${workspace.company_id}/agents`, { name: "Intruder" }, { cookie: stranger.cookie });
      expect(crossCompany.statusCode).toBe(403);
      expect((await call("GET", `/v1/companies/${workspace.company_id}/agents`, undefined, { cookie: me.cookie })).json().agents).toHaveLength(0);
    });
  });

  describe("agent listing", () => {
    it("returns what the onboarding UI needs and nothing about credentials", async () => {
      const me = await signedInUser();
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();
      const project = (await call("POST", `/v1/companies/${workspace.company_id}/projects`, { name: "P", objective: "O" }, { cookie: me.cookie })).json();
      const room = (await call("POST", `/v1/companies/${workspace.company_id}/projects/${project.id}/rooms`, { name: "Launch", responsibilities: "Own it" }, { cookie: me.cookie })).json();
      const agent = (await call("POST", `/v1/companies/${workspace.company_id}/agents`, { name: "Coleman" }, { cookie: me.cookie })).json();
      await call("POST", `/v1/companies/${workspace.company_id}/rooms/${room.id}/members`, { principal_id: agent.principal_id, role: "worker_agent", responsibilities: "Research" }, { cookie: me.cookie, "idempotency-key": crypto.randomUUID() });

      const listed = await call("GET", `/v1/companies/${workspace.company_id}/agents`, undefined, { cookie: me.cookie });
      expect(listed.statusCode).toBe(200);
      const [entry] = listed.json().agents;
      expect(entry).toEqual({
        agent_id: agent.agent_id,
        principal_id: agent.principal_id,
        display_name: "Coleman",
        status: "active",
        owner_display_name: "Rocco",
        connector: { enrolled: false, presence: "never", runtime_status: null, last_seen_at: null },
        rooms: [{ room_id: room.id, name: "Launch" }],
      });

      // Nothing about how the connector authenticates may appear in a product response.
      const body = JSON.stringify(listed.json());
      for (const leak of ["token", "hash", "secret", "session_id", "credential_id", "magc_", "mags_"]) expect(body).not.toContain(leak);
    });

    it("reports truthful connector presence derived from durable session state", async () => {
      const me = await signedInUser();
      const workspace = (await call("POST", "/v1/workspaces", { name: "Acme" }, { cookie: me.cookie })).json();
      const project = (await call("POST", `/v1/companies/${workspace.company_id}/projects`, { name: "P", objective: "O" }, { cookie: me.cookie })).json();
      const room = (await call("POST", `/v1/companies/${workspace.company_id}/projects/${project.id}/rooms`, { name: "Launch", responsibilities: "Own it" }, { cookie: me.cookie })).json();
      const agent = (await call("POST", `/v1/companies/${workspace.company_id}/agents`, { name: "Coleman" }, { cookie: me.cookie })).json();
      await call("POST", `/v1/companies/${workspace.company_id}/rooms/${room.id}/members`, { principal_id: agent.principal_id, role: "worker_agent", responsibilities: "Research" }, { cookie: me.cookie, "idempotency-key": crypto.randomUUID() });

      const issued = (await call("POST", `/v1/companies/${workspace.company_id}/agents/${agent.principal_id}/enrollments`, { label: "Rocco MacBook" }, { cookie: me.cookie })).json();
      const enrolled = (await call("POST", "/v1/agent-gateway/v1/enroll", { code: issued.enrollment_code, device_label: "MacBook" })).json();
      const only = async () => (await call("GET", `/v1/companies/${workspace.company_id}/agents`, undefined, { cookie: me.cookie })).json().agents[0];

      expect((await only()).connector).toEqual({ enrolled: true, presence: "never", runtime_status: null, last_seen_at: null });

      const client = new FakeExternalAgentClient(baseUrl); clients.add(client);
      client.credentialToken = enrolled.credential_token; client.roomId = room.id;
      expect((await client.open()).status).toBe(200);
      expect((await only()).connector.presence).toBe("connected");
      await client.heartbeat("working");
      expect((await only()).connector.runtime_status).toBe("working");

      // A session the Gateway still calls connected but which stopped reporting is not live.
      await pool.query(`UPDATE external_agent_sessions SET last_seen_at=now()-interval '2 minutes' WHERE id=$1`, [client.sessionId]);
      expect((await only()).connector.presence).toBe("stale");

      await pool.query(`UPDATE external_agent_sessions SET status='offline',disconnected_at=now() WHERE id=$1`, [client.sessionId]);
      expect((await only()).connector.presence).toBe("offline");
    });
  });
});
