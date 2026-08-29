import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import type { SignInLink, SignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for agent registration tests");

class CapturingDelivery implements SignInLinkDelivery {
  readonly delivered: SignInLink[] = [];
  async deliver(link: SignInLink) { this.delivered.push(link); }
}

/**
 * Multiplayer AI does not make agents. A person brings one they already run, and this records an
 * identity for it and puts that identity in a room. Nothing may appear anywhere until they have
 * done both, which is what these hold in place.
 */
describe("Bringing your own agents", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, delivery: CapturingDelivery;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  async function signedInUser(displayName = "Priya") {
    const email = `user-${crypto.randomUUID()}@example.com`;
    // The real thing a new person does: sign up, then redeem the link they are sent.
    await call("POST", "/v1/auth/sign-up", { name: displayName, email });
    const session = await call("POST", "/v1/auth/sessions", { token: delivery.delivered.at(-1)!.token });
    const raw = session.headers["set-cookie"];
    return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0] ?? "";
  }

  /** Everything a person does here, done the way the product does it. */
  async function workspace(cookie: string, name = "Northwind") {
    const company = (await call("POST", "/v1/workspaces", { name }, { cookie })).json();
    return company.company_id as string;
  }
  const makeRoom = async (cookie: string, companyId: string, name: string) => {
    const project = (await call("POST", `/v1/companies/${companyId}/projects`, { name, objective: "Ship it" }, { cookie })).json();
    return (await call("POST", `/v1/companies/${companyId}/projects/${project.id}/rooms`, { name }, { cookie })).json();
  };
  const registerAgent = async (cookie: string, companyId: string, name: string) =>
    (await call("POST", `/v1/companies/${companyId}/agents`, { name }, { cookie })).json();
  const addToRoom = (cookie: string, companyId: string, roomId: string, principalId: string) =>
    call("POST", `/v1/companies/${companyId}/rooms/${roomId}/members`,
      { principal_id: principalId, role: "worker_agent", responsibilities: "" },
      { cookie, "idempotency-key": crypto.randomUUID() });
  const agentsIn = async (cookie: string, companyId: string, roomId: string) =>
    ((await call("GET", `/v1/companies/${companyId}/rooms/${roomId}/snapshot`, undefined, { cookie })).json()
      .members as Array<{ kind: string; display_name: string }>)
      .filter(member => member.kind === "agent").map(member => member.display_name);

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    delivery = new CapturingDelivery();
    app = buildApp(pool, { pollIntervalMs: 50 }, { allowHeaderPrincipal: false, signInDelivery: delivery });
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it("gives a new workspace no agents at all", async () => {
    const cookie = await signedInUser();
    const companyId = await workspace(cookie);
    expect((await call("GET", `/v1/companies/${companyId}/agents`, undefined, { cookie })).json().agents).toEqual([]);
  });

  it("gives a new room no agents until someone puts one there", async () => {
    const cookie = await signedInUser();
    const companyId = await workspace(cookie);
    const room = await makeRoom(cookie, companyId, "Room 1");
    expect(await agentsIn(cookie, companyId, room.id)).toEqual([]);
  });

  it("registers only the agent the person named, and puts it nowhere on its own", async () => {
    const cookie = await signedInUser();
    const companyId = await workspace(cookie);
    const room = await makeRoom(cookie, companyId, "Room 1");

    const agentA = await registerAgent(cookie, companyId, "Agent A");
    const registered = (await call("GET", `/v1/companies/${companyId}/agents`, undefined, { cookie })).json().agents;
    expect(registered.map((a: any) => a.display_name)).toEqual(["Agent A"]);
    // Registering an identity is not joining a room.
    expect(await agentsIn(cookie, companyId, room.id)).toEqual([]);

    await addToRoom(cookie, companyId, room.id, agentA.principal_id);
    expect(await agentsIn(cookie, companyId, room.id)).toEqual(["Agent A"]);
  });

  it("keeps a second agent out of a room it was never added to", async () => {
    const cookie = await signedInUser();
    const companyId = await workspace(cookie);
    const roomOne = await makeRoom(cookie, companyId, "Room 1");
    const roomTwo = await makeRoom(cookie, companyId, "Room 2");

    const agentA = await registerAgent(cookie, companyId, "Agent A");
    const agentB = await registerAgent(cookie, companyId, "Agent B");
    await addToRoom(cookie, companyId, roomOne.id, agentA.principal_id);

    expect(await agentsIn(cookie, companyId, roomOne.id)).toEqual(["Agent A"]);
    expect(await agentsIn(cookie, companyId, roomTwo.id)).toEqual([]);

    await addToRoom(cookie, companyId, roomTwo.id, agentB.principal_id);
    expect(await agentsIn(cookie, companyId, roomOne.id)).toEqual(["Agent A"]);
    expect(await agentsIn(cookie, companyId, roomTwo.id)).toEqual(["Agent B"]);
  });

  it("will not let work, messages, or presence reach an agent that is not in the room", async () => {
    const cookie = await signedInUser();
    const companyId = await workspace(cookie);
    const room = await makeRoom(cookie, companyId, "Room 1");
    const outsider = await registerAgent(cookie, companyId, "Agent B");

    // Presence comes from membership, so it is not there.
    expect(await agentsIn(cookie, companyId, room.id)).toEqual([]);

    const assigned = await call("POST", `/v1/companies/${companyId}/rooms/${room.id}/tasks`,
      { title: "Investigate", description: "", assignee_principal_id: outsider.principal_id },
      { cookie, "idempotency-key": crypto.randomUUID() });
    expect(assigned.statusCode).toBeGreaterThanOrEqual(400);

    const addressed = await call("POST", `/v1/companies/${companyId}/rooms/${room.id}/messages`,
      { body: "Are you there?", addressed_principal_id: outsider.principal_id },
      { cookie, "idempotency-key": crypto.randomUUID() });
    expect(addressed.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("refuses to spend a connection code on an agent that belongs to no room", async () => {
    const cookie = await signedInUser();
    const companyId = await workspace(cookie);
    const agent = await registerAgent(cookie, companyId, "Agent A");

    const issued = (await call("POST", `/v1/companies/${companyId}/agents/${agent.principal_id}/enrollments`,
      { label: "A Mac" }, { cookie })).json();
    const refused = await call("POST", "/v1/agent-gateway/v1/enroll", { code: issued.enrollment_code });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("enrollment_room_required");

    // And the code is still good once the agent has somewhere to be.
    const room = await makeRoom(cookie, companyId, "Room 1");
    await addToRoom(cookie, companyId, room.id, agent.principal_id);
    const accepted = await call("POST", "/v1/agent-gateway/v1/enroll", { code: issued.enrollment_code });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().agent_display_name).toBe("Agent A");
  });
});

/**
 * The product ships no agents of its own, and asks nobody to open a terminal. Both are
 * properties of the source, so they are checked against the source.
 */
describe("What the product ships", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shipping = [
    "apps/web/src", "apps/marketing/src",
    "apps/connector-macos/Sources", "apps/connector-macos/sidecar",
    "packages/connector-core/src", "packages/connector-hermes/src",
    "apps/api/src",
  ];
  const sourceFiles = (dir: string): string[] => {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full, { withFileTypes: true }).flatMap(entry => {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(child);
      return /\.(ts|tsx|mjs|swift|css)$/.test(entry.name) ? [child] : [];
    });
  };

  it("carries no built-in agent identities", () => {
    const offenders = shipping.flatMap(sourceFiles).filter(file =>
      /\bColeman\b|\bJJ\b/.test(fs.readFileSync(path.join(root, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never asks a person to run a command to connect an agent", () => {
    // The Connector exists precisely so that none of this is anybody's problem.
    const shell = /\b(npm install|npm run|chmod \+x|sudo |launchctl |\.env file|open a terminal|in Terminal)\b/i;
    const facing = [...sourceFiles("apps/web/src"), ...sourceFiles("apps/connector-macos/Sources")];
    const offenders = facing.filter(file => shell.test(fs.readFileSync(path.join(root, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
