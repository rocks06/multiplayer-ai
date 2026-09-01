import { describe, expect, it } from "vitest";
import {
  ProductionConfigurationError,
  assertProductionSafe,
  isProduction,
  productionProblems,
} from "../apps/api/src/production-guard.js";
import {
  AUTH_LIMITS,
  MemoryRateLimitStore,
  clientBucket,
  emailBucket,
  overLimit,
} from "../apps/api/src/auth/rate-limit.js";

/**
 * Settings that are correct on a laptop and a total failure on the internet.
 *
 * Each is one character in an environment variable, and a deployment that got one wrong would
 * look entirely healthy — it serves, it signs people in, the tests pass — while being open. The
 * point of checking at startup is that the mistake is a refusal to boot rather than something
 * discovered afterwards by somebody else.
 */
describe("refusing to start a public origin with a development setting on", () => {
  const production = { DEPLOYMENT_ENV: "production" };

  it("says nothing at all outside production", () => {
    expect(productionProblems({ ALLOW_HEADER_PRINCIPAL: "1", AUTH_COOKIE_SECURE: "0" })).toEqual([]);
    expect(isProduction({})).toBe(false);
    expect(isProduction({ DEPLOYMENT_ENV: "Production" })).toBe(true);
  });

  /**
   * The one that matters most. It accepts a caller-supplied x-principal-id *and* re-opens the
   * unauthenticated company and human bootstrap routes — on a public origin that is not a
   * weakened check, it is no check at all.
   */
  it.each(["1", "true", "TRUE"])("refuses ALLOW_HEADER_PRINCIPAL=%s", value => {
    const problems = productionProblems({ ...production, ALLOW_HEADER_PRINCIPAL: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ALLOW_HEADER_PRINCIPAL");
    expect(() => assertProductionSafe({ ...production, ALLOW_HEADER_PRINCIPAL: value }))
      .toThrow(ProductionConfigurationError);
  });

  it("refuses a session cookie that would not be marked Secure", () => {
    const problems = productionProblems({ ...production, AUTH_COOKIE_SECURE: "0" });
    expect(problems[0]).toContain("AUTH_COOKIE_SECURE");
  });

  /** Both at once, named together: one at a time is a worse way to learn what a deployment needs. */
  it("names every problem rather than the first", () => {
    const problems = productionProblems({
      ...production, ALLOW_HEADER_PRINCIPAL: "1", AUTH_COOKIE_SECURE: "0" });
    expect(problems).toHaveLength(2);
  });

  it("is satisfied by a correctly configured production environment", () => {
    expect(productionProblems({ DEPLOYMENT_ENV: "production" })).toEqual([]);
    expect(() => assertProductionSafe({ DEPLOYMENT_ENV: "production", AUTH_COOKIE_SECURE: "1" })).not.toThrow();
  });
});

/**
 * The sign-in routes send real mail to an address the caller chose. Unlimited, they are a relay
 * anyone can point at a stranger's inbox — and the sender domain's reputation is spent long
 * before anybody notices.
 */
describe("rate limiting the routes that send email", () => {
  it("allows a normal person and stops the one holding the button down", async () => {
    const store = new MemoryRateLimitStore();
    const bucket = emailBucket("someone@example.com");
    const counts: number[] = [];
    for (let i = 0; i < AUTH_LIMITS.perEmail.limit + 2; i++) {
      counts.push(await store.hit(bucket, AUTH_LIMITS.perEmail.windowSeconds));
    }
    // Everything up to the limit is allowed; what comes after is not.
    expect(counts.slice(0, AUTH_LIMITS.perEmail.limit).every(c => !overLimit(c, AUTH_LIMITS.perEmail))).toBe(true);
    expect(counts.slice(AUTH_LIMITS.perEmail.limit).every(c => overLimit(c, AUTH_LIMITS.perEmail))).toBe(true);
  });

  /** Two buckets, because they stop different things. */
  it("counts an address and a caller separately", () => {
    expect(emailBucket("a@b.c")).not.toBe(clientBucket("a@b.c"));
    expect(emailBucket("A@B.c")).toBe(emailBucket(" a@b.c "));
  });

  it("forgets a window once it has passed", async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(() => now);
    for (let i = 0; i < 10; i++) await store.hit("email:x", 60);
    now += 61_000;
    expect(await store.hit("email:x", 60)).toBe(1);
  });

  /**
   * The limiter is never told whether the address has an account. One that consulted the users
   * table would answer differently for an address that does, which is the single thing these
   * routes exist to keep quiet about.
   */
  it("decides from the count alone", () => {
    expect(overLimit(AUTH_LIMITS.perEmail.limit, AUTH_LIMITS.perEmail)).toBe(false);
    expect(overLimit(AUTH_LIMITS.perEmail.limit + 1, AUTH_LIMITS.perEmail)).toBe(true);
  });
});

/**
 * A service that reports itself healthy while nothing works.
 *
 * /health answers from the process alone. A deployment whose database was unreachable or
 * unmigrated therefore passed its host's health check and served 500s from every route that
 * touches data — which is precisely what happened, and could only be diagnosed by guessing from
 * outside. Readiness asks the database the two questions that actually decide it.
 */
describe("readiness", () => {
  it("is a different question from liveness", async () => {
    const { buildApp } = await import("../apps/api/src/app.js");
    const pg = await import("pg");
    const app = buildApp(new pg.default.Pool({ connectionString: process.env.DATABASE_URL }),
      { pollIntervalMs: 50 }, { allowHeaderPrincipal: false, environment: { SIGN_IN_DELIVERY: "silent" } });

    const live = await app.inject({ method: "GET", url: "/health" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready", migrations: "complete" });
    await app.close();
  });

  it("reports an unreachable database rather than claiming to be fine", async () => {
    const { buildApp } = await import("../apps/api/src/app.js");
    const pg = await import("pg");
    // A port nothing listens on: the shape of a misconfigured DATABASE_URL.
    const app = buildApp(new pg.default.Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none" }),
      { pollIntervalMs: 50 }, { allowHeaderPrincipal: false, environment: { SIGN_IN_DELIVERY: "silent" } });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: "unavailable", database: "unreachable" });
    // Never says where the database is or how to reach it.
    expect(JSON.stringify(ready.json())).not.toContain("127.0.0.1");
    await app.close();
  });
});
