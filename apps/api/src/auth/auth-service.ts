import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { DomainError } from "../../../../packages/domain/src/index.js";
import type { DbPool } from "../db.js";

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

const SIGN_IN_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;

export interface SignInLink {
  user_id: string;
  email: string;
  /** The raw single-use token. Held only long enough to deliver; never stored. */
  token: string;
  expires_at: string;
}

/**
 * How a sign-in link reaches a person. Kept behind an interface so an email provider can be
 * added later without touching authentication semantics — the token, its TTL, its single-use
 * consumption, and the session it produces are all independent of delivery.
 */
export interface SignInLinkDelivery {
  deliver(link: SignInLink): Promise<void>;
}

/** Developer beta: no email provider. The operator reads the link from the server log. */
export class LoggingSignInLinkDelivery implements SignInLinkDelivery {
  constructor(private readonly write: (line: string) => void = line => console.log(line)) {}
  async deliver(link: SignInLink) {
    this.write(`[auth] sign-in token for ${link.email} (expires ${new Date(link.expires_at).toISOString()}): ${link.token}`);
  }
}

/** For tests and for callers that surface the link themselves through an authorized path. */
export class SilentSignInLinkDelivery implements SignInLinkDelivery {
  async deliver() {}
}

export interface SessionIdentity {
  sessionId: string;
  userId: string;
}

export class AuthService {
  constructor(
    private readonly pool: DbPool,
    private readonly delivery: SignInLinkDelivery = new LoggingSignInLinkDelivery(),
  ) {}

  private async mintToken(userId: string, email: string): Promise<SignInLink> {
    const id = uuidv7(), token = secret("mpsi");
    const row = await this.pool.query<{ expires_at: string }>(
      `INSERT INTO user_auth_tokens(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+($4||' minutes')::interval) RETURNING expires_at`,
      [id, userId, hash(token), String(SIGN_IN_TTL_MINUTES)],
    );
    return { user_id: userId, email, token, expires_at: row.rows[0]!.expires_at };
  }

  /**
   * Public entry point. Always reports the same result whether or not the address exists, so
   * this cannot be used to discover who has an account.
   */
  async requestSignInLink(email: string) {
    const user = await this.pool.query<{ id: string; email: string }>(`SELECT id,email FROM users WHERE lower(email)=lower($1)`, [email]);
    if (user.rowCount) await this.delivery.deliver(await this.mintToken(user.rows[0]!.id, user.rows[0]!.email));
    return { status: "accepted" as const };
  }

  /**
   * Creating an account, which is the only way a person can arrive here without already existing.
   *
   * A brand-new address gets a user record; a known one gets nothing new. Either way a sign-in
   * link is delivered and the caller is told exactly the same thing, so this cannot be used to
   * discover whether an address has an account. No company is created — naming a workspace is an
   * authenticated act that belongs to onboarding, after the link is redeemed.
   */
  async signUp(input: { name: string; email: string }) {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    const existing = await this.pool.query<{ id: string; email: string }>(
      `SELECT id,email FROM users WHERE lower(email)=lower($1)`, [email]);

    if (existing.rowCount) {
      // Already an account: behave exactly as asking for a sign-in link does.
      await this.delivery.deliver(await this.mintToken(existing.rows[0]!.id, existing.rows[0]!.email));
      return { status: "accepted" as const };
    }

    const userId = uuidv7();
    // A race between two signups for the same address must not create two users; the unique
    // index on email decides it, and the loser simply signs in as the winner's account.
    const inserted = await this.pool.query<{ id: string; email: string }>(
      `INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)
       ON CONFLICT (email) DO NOTHING RETURNING id,email`, [userId, email, name]);
    const user = inserted.rowCount
      ? inserted.rows[0]!
      : (await this.pool.query<{ id: string; email: string }>(`SELECT id,email FROM users WHERE lower(email)=lower($1)`, [email])).rows[0]!;

    await this.delivery.deliver(await this.mintToken(user.id, user.email));
    return { status: "accepted" as const };
  }

  /**
   * Authorized issuance for the developer beta, where there is no email transport: an active
   * member of the company mints a link for another member of the same company and reads it
   * once from the response. The raw token is never persisted.
   */
  async issueSignInLinkFor(input: { companyId: string; actorUserId: string; userId: string }) {
    const actor = await this.pool.query(`SELECT 1 FROM company_users WHERE company_id=$1 AND user_id=$2 AND status='active'`, [input.companyId, input.actorUserId]);
    if (!actor.rowCount) throw new DomainError("forbidden", "You do not have access to this company", 403);
    const target = await this.pool.query<{ id: string; email: string }>(
      `SELECT u.id,u.email FROM users u JOIN company_users cu ON cu.user_id=u.id AND cu.company_id=$1 AND cu.status='active' WHERE u.id=$2`,
      [input.companyId, input.userId],
    );
    if (!target.rowCount) throw new DomainError("user_not_found", "Active company member not found", 404);
    const link = await this.mintToken(target.rows[0]!.id, target.rows[0]!.email);
    await this.delivery.deliver(link);
    return link;
  }

  /**
   * Redeem a sign-in token for a session. Consuming and validating in one statement is what
   * makes a link single-use under concurrent redemption.
   */
  async createSession(token: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const claimed = await c.query<{ user_id: string }>(
        `UPDATE user_auth_tokens SET status='consumed',consumed_at=now() WHERE token_hash=$1 AND status='pending' AND purpose='sign_in' AND expires_at>now() RETURNING user_id`,
        [hash(token)],
      );
      if (!claimed.rowCount) throw new DomainError("sign_in_invalid", "Sign-in link is invalid, already used, or expired", 401);
      const userId = claimed.rows[0]!.user_id;
      const id = uuidv7(), sessionToken = secret("mpss");
      await c.query(`INSERT INTO user_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+($4||' days')::interval)`, [id, userId, hash(sessionToken), String(SESSION_TTL_DAYS)]);
      await c.query("COMMIT");
      return { session_id: id, session_token: sessionToken, user_id: userId };
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  async resolveSession(token: string | undefined): Promise<SessionIdentity> {
    if (!token) throw new DomainError("unauthenticated", "Sign in to continue", 401);
    const result = await this.pool.query<{ id: string; user_id: string }>(
      `SELECT id,user_id FROM user_sessions WHERE token_hash=$1 AND status='active' AND expires_at>now()`,
      [hash(token)],
    );
    if (!result.rowCount) throw new DomainError("unauthenticated", "Session is invalid or expired", 401);
    await this.pool.query(`UPDATE user_sessions SET last_seen_at=now() WHERE id=$1`, [result.rows[0]!.id]);
    return { sessionId: result.rows[0]!.id, userId: result.rows[0]!.user_id };
  }

  async revokeSession(token: string | undefined) {
    if (!token) return { status: "revoked" as const };
    await this.pool.query(`UPDATE user_sessions SET status='revoked',revoked_at=now() WHERE token_hash=$1 AND status='active'`, [hash(token)]);
    return { status: "revoked" as const };
  }

  /**
   * The acting principal is derived from the session and the addressed company. It is never
   * accepted from the client, so knowing a principal id grants nothing.
   */
  async principalFor(userId: string, companyId: string) {
    const result = await this.pool.query<{ id: string }>(
      `SELECT p.id FROM principals p JOIN company_users cu ON cu.company_id=p.company_id AND cu.user_id=p.user_id AND cu.status='active' WHERE p.company_id=$1 AND p.user_id=$2 AND p.kind='human' AND p.status='active'`,
      [companyId, userId],
    );
    if (!result.rowCount) throw new DomainError("forbidden", "You do not have access to this company", 403);
    return result.rows[0]!.id;
  }

  /** Who am I, and which companies can I act in? */
  async identity(userId: string) {
    const user = await this.pool.query<{ id: string; email: string; display_name: string }>(`SELECT id,email,display_name FROM users WHERE id=$1`, [userId]);
    if (!user.rowCount) throw new DomainError("unauthenticated", "Session is invalid or expired", 401);
    const companies = await this.pool.query(
      `SELECT c.id company_id,c.name company_name,p.id principal_id,p.display_name FROM company_users cu JOIN companies c ON c.id=cu.company_id JOIN principals p ON p.company_id=cu.company_id AND p.user_id=cu.user_id AND p.kind='human' AND p.status='active' WHERE cu.user_id=$1 AND cu.status='active' ORDER BY c.name`,
      [userId],
    );
    return { user: user.rows[0], companies: companies.rows };
  }
}
