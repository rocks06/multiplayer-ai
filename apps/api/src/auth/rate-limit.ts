import type { DbPool } from "../db.js";

/**
 * Keeping the public sign-in routes from being used as an email relay.
 *
 * Both routes send real mail to an address the caller chose, so without a limit anyone can point
 * the service at a stranger's inbox and hold the button down — and the sender domain's reputation
 * is spent long before anybody notices. Two buckets, because they stop different things: one
 * address cannot be mailed repeatedly, and one caller cannot walk through many addresses.
 *
 * The count is kept in Postgres rather than in each process. An in-memory counter multiplies the
 * allowance by however many instances are running, which is the wrong number and one that changes
 * without anybody deciding it.
 */
export interface RateLimitStore {
  /** Record a hit against a bucket and return how many are now in the current window. */
  hit(bucket: string, windowSeconds: number): Promise<number>;
}

export interface Allowance {
  /** How many requests one bucket may make inside a window. */
  limit: number;
  windowSeconds: number;
}

/** What the two routes allow. Generous enough that no real person meets them. */
export const AUTH_LIMITS = {
  perEmail: { limit: 5, windowSeconds: 3600 } as Allowance,
  perClient: { limit: 20, windowSeconds: 3600 } as Allowance,
};

/**
 * Whether this hit is over the line. Pure, and deliberately not told anything about the address
 * beyond the count: a limiter that consulted the users table would answer differently for an
 * address that has an account, which is the one thing these routes exist to keep quiet about.
 */
export const overLimit = (count: number, allowance: Allowance): boolean => count > allowance.limit;

/** Buckets are namespaced so an address can never collide with an address-shaped client id. */
export const emailBucket = (email: string) => `email:${email.trim().toLowerCase()}`;
export const clientBucket = (client: string) => `client:${client}`;

export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly pool: DbPool) {}

  async hit(bucket: string, windowSeconds: number): Promise<number> {
    /* One statement, so two requests arriving together cannot both read a stale count and both
       decide they are under the limit. The window rolls forward only when it has actually
       elapsed, which makes this a fixed window rather than a sliding one — simpler, and errs
       towards allowing rather than trapping somebody just past a boundary. */
    const result = await this.pool.query<{ count: number }>(
      `INSERT INTO auth_rate_limits(bucket,window_start,count) VALUES($1,now(),1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start = CASE WHEN auth_rate_limits.window_start < now() - ($2||' seconds')::interval
                             THEN now() ELSE auth_rate_limits.window_start END,
         count = CASE WHEN auth_rate_limits.window_start < now() - ($2||' seconds')::interval
                      THEN 1 ELSE auth_rate_limits.count + 1 END
       RETURNING count`,
      [bucket, String(windowSeconds)],
    );
    return Number(result.rows[0]?.count ?? 1);
  }
}

/** For tests, and for a development server that should not need a table to boot. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  async hit(bucket: string, windowSeconds: number): Promise<number> {
    const at = this.now();
    const held = this.buckets.get(bucket);
    if (!held || at - held.start >= windowSeconds * 1000) {
      this.buckets.set(bucket, { start: at, count: 1 });
      return 1;
    }
    held.count += 1;
    return held.count;
  }
}

/** A store that never refuses. Used where a limit would only get in the way of a test. */
export class UnlimitedRateLimitStore implements RateLimitStore {
  async hit(): Promise<number> { return 0; }
}
