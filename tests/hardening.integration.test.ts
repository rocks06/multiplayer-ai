import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { MemoryRateLimitStore } from "../apps/api/src/auth/rate-limit.js";
import { SilentSignInLinkDelivery } from "../apps/api/src/auth/auth-service.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";
import { truncateAll } from "./support/database.js";

/**
 * What a browser is told about our responses, and what one principal may do in a minute.
 *
 * Neither is a product feature; both are the difference between a mistake somewhere else being
 * survivable or not. Every name here is a fixture.
 */
const connectionString = process.env.DATABASE_URL!;
let pool: pg.Pool, app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  const bootstrap = new pg.Pool({ connectionString }); await truncateAll(bootstrap); await bootstrap.end();
  pool = new pg.Pool({ connectionString });
  app = buildApp(pool, { pollIntervalMs: 50 }, { allowHeaderPrincipal: true, signInDelivery: new SilentSignInLinkDelivery() });
  await app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => { await app.close(); });

const as = (principalId: string, extra: Record<string, string> = {}) => ({ "x-principal-id": principalId, ...extra });
let keys = 0;
const call = (method: string, url: string, principalId: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any,
    headers: as(principalId, method === "GET" ? {} : { "idempotency-key": `k-${++keys}` }) });

async function room() {
  const company = await seedCompany(pool, "Fixture Workspace");
  const owner = await seedHuman(pool, company.id, `${crypto.randomUUID()}@example.test`, "Fixture Owner");
  const project = (await call("POST", `/v1/companies/${company.id}/projects`, owner.principal_id, { name: "P", objective: "O" })).json();
  const created = (await call("POST", `/v1/companies/${company.id}/projects/${project.id}/rooms`, owner.principal_id, { name: "Fixture Room" })).json();
  return { company, owner, room: created };
}

describe("what a browser is allowed to do with what we send", () => {
  it("carries a content policy, refuses framing, and never lets a signed-in answer be cached", async () => {
    const f = await room();
    const answer = await call("GET", `/v1/companies/${f.company.id}/rooms`, f.owner.principal_id);
    const policy = String(answer.headers["content-security-policy"]);
    // Script from here and nowhere else is the half that matters; inline styles are React's.
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    // A PDF is previewed from a blob rather than handed to a third party, so that much is allowed.
    expect(policy).toContain("frame-src 'self' blob:");
    expect(answer.headers["x-frame-options"]).toBe("DENY");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["cache-control"]).toBe("no-store");
    // Not promised where there is no TLS in front of us.
    expect(answer.headers["strict-transport-security"]).toBeUndefined();
  });

  it("promises transport security only on a production origin", async () => {
    const hosted = buildApp(new pg.Pool({ connectionString }), { pollIntervalMs: 50 },
      { allowHeaderPrincipal: false, environment: { DEPLOYMENT_ENV: "production" } as any,
        signInDelivery: new SilentSignInLinkDelivery(), artifactStorage: {
          name: "fixture", async put(){}, async signedUrl(){return "https://fixture.invalid"},
          async remove(){}, async verify(){},
        } });
    try {
      await hosted.listen({ host: "127.0.0.1", port: 0 });
      const answer = await hosted.inject({ method: "GET", url: "/health" });
      expect(answer.headers["strict-transport-security"]).toContain("max-age=31536000");
    } finally { await hosted.close(); }
  });
});

describe("what one principal may do in a short time", () => {
  /** A store that allows two of anything, so the refusal is reached without sending hundreds. */
  const tight = () => new MemoryRateLimitStore();

  it("refuses a flood of messages, uploads and sockets from one principal, and says so", async () => {
    const limited = buildApp(new pg.Pool({ connectionString }), { pollIntervalMs: 50 },
      { allowHeaderPrincipal: true, signInDelivery: new SilentSignInLinkDelivery(), rateLimits: tight() });
    try {
      await limited.listen({ host: "127.0.0.1", port: 0 });
      const f = await room();
      const send = (n: number) => limited.inject({ method: "POST",
        url: `/v1/companies/${f.company.id}/rooms/${f.room.id}/messages`,
        payload: { body: `message ${n}` }, headers: as(f.owner.principal_id, { "idempotency-key": `flood-${n}` }) });

      // Well inside the allowance: the room works exactly as it did.
      for (const n of [1, 2, 3]) expect((await send(n)).statusCode).toBe(200);

      // Past it: refused with a status a client can act on, and nothing is written.
      const before = (await pool.query(`SELECT count(*)::int n FROM messages WHERE room_id=$1`, [f.room.id])).rows[0].n;
      const results: number[] = [];
      for (let n = 4; n <= 245; n++) results.push((await send(n)).statusCode);
      expect(results).toContain(429);
      const refused = results.filter(status => status === 429).length;
      expect(refused).toBeGreaterThan(0);
      const after = (await pool.query(`SELECT count(*)::int n FROM messages WHERE room_id=$1`, [f.room.id])).rows[0].n;
      expect(after - before).toBe(results.length - refused);
    } finally { await limited.close(); }
  }, 60_000);

  it("leaves an ordinary conversation alone", async () => {
    const f = await room();
    for (let n = 0; n < 20; n++) {
      const sent = await call("POST", `/v1/companies/${f.company.id}/rooms/${f.room.id}/messages`, f.owner.principal_id, { body: `ordinary ${n}` });
      expect(sent.statusCode).toBe(200);
    }
  });
});
