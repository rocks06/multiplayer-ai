import type { DbClient, DbPool } from "../db.js";
import {
  AGENT_CAPABILITIES, CAPABILITY_ENFORCEMENT, DEFAULT_AGENT_CAPABILITIES, DomainError,
  type AgentCapability,
} from "../../../../packages/domain/src/index.js";
import { SecurityAudit } from "./audit.js";

export interface CapabilityState {
  capability: AgentCapability;
  allowed: boolean;
  /** Where the answer came from: the room default, or a person's explicit change. */
  source: "default" | "granted" | "revoked" | "expired";
  /** Who enforces it. A `local_broker` capability is recorded but not yet enforced. */
  enforcement: "server" | "local_broker";
  enforced: boolean;
  expires_at: string | null;
}

/** Lets the capability layer say, in the room, that an agent was refused — without owning the room log. */
export type Announce = (client: DbClient, input: {
  companyId: string; roomId: string; actorId: string; agentPrincipalId: string; eventType: string; payload: Record<string, unknown>;
}) => Promise<void>;

/** Local-machine capabilities are enforced only once the connector's broker ships (P1-B). */
const LOCAL_BROKER_ENFORCED = false;

/**
 * What an agent may do in a room, decided here and nowhere else.
 *
 * The answer never comes from anything an agent said or was told. It comes from the room's
 * defaults — exactly what taking part in a room already meant — and from explicit changes a person
 * made, which are durable, dated and revocable. Anything not granted is refused, and a refusal is
 * recorded in the security log and announced in the room the agent tried to act in, so the people
 * supervising it see what it attempted.
 *
 * People are governed by their room role, not by this; asked about a person, it answers allowed.
 */
export class CapabilityService {
  private readonly audit: SecurityAudit;
  constructor(private readonly pool: DbPool, private readonly announce?: Announce) {
    this.audit = new SecurityAudit(pool);
  }

  async kindOf(companyId: string, principalId: string, client: { query: DbPool["query"] } = this.pool) {
    const found = await client.query<{ kind: string }>(`SELECT kind FROM principals WHERE company_id=$1 AND id=$2`, [companyId, principalId]);
    return found.rows[0]?.kind ?? null;
  }

  /** Every capability, with whether it is allowed and why. Always the full list: absence is not an answer. */
  async effective(companyId: string, roomId: string, agentPrincipalId: string,
                  client: { query: DbPool["query"] } = this.pool): Promise<CapabilityState[]> {
    const rows = await client.query<{ capability: string; status: string; expires_at: string | null; expired: boolean }>(
      `SELECT capability,status,expires_at,(expires_at IS NOT NULL AND expires_at<=now()) expired
         FROM agent_capabilities WHERE company_id=$1 AND room_id=$2 AND agent_principal_id=$3`,
      [companyId, roomId, agentPrincipalId]);
    const explicit = new Map(rows.rows.map(row => [row.capability, row]));
    return AGENT_CAPABILITIES.map(capability => {
      const row = explicit.get(capability);
      const enforcement = CAPABILITY_ENFORCEMENT[capability];
      const enforced = enforcement === "server" || LOCAL_BROKER_ENFORCED;
      if (row?.status === "granted" && row.expired)
        return { capability, allowed: false, source: "expired" as const, enforcement, enforced, expires_at: row.expires_at };
      if (row) return { capability, allowed: row.status === "granted", source: row.status as "granted" | "revoked",
        enforcement, enforced, expires_at: row.expires_at };
      return { capability, allowed: DEFAULT_AGENT_CAPABILITIES.has(capability), source: "default" as const,
        enforcement, enforced, expires_at: null };
    });
  }

  async allows(companyId: string, roomId: string, agentPrincipalId: string, capability: AgentCapability,
               client?: { query: DbPool["query"] }) {
    const states = await this.effective(companyId, roomId, agentPrincipalId, client);
    return states.find(state => state.capability === capability)?.allowed ?? false;
  }

  /**
   * Refuse unless this principal may do this here. A person is never refused by this check.
   *
   * Fails closed: an error reading capabilities is a refusal, not a pass.
   */
  async require(input: {
    companyId: string; roomId: string; principalId: string; capability: AgentCapability;
    action: string; kind?: string | null; targetType?: string; targetId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    let kind = input.kind;
    let allowed = false;
    try {
      kind ??= await this.kindOf(input.companyId, input.principalId);
      if (kind !== "agent") return;
      allowed = await this.allows(input.companyId, input.roomId, input.principalId, input.capability);
    } catch {
      allowed = false;
    }
    if (allowed) return;
    await this.deny({ ...input, reason: "capability_not_granted" });
    throw new DomainError("capability_denied",
      `This agent is not allowed to ${describe(input.capability)} in this room`, 403,
      { capability: input.capability });
  }

  /** An agent was given room context. Recorded, so "what did this agent see, and when" has an answer. */
  async recordRead(input: { companyId: string; roomId: string; principalId: string; action: string; metadata?: Record<string, unknown> }) {
    await this.audit.record({
      companyId: input.companyId, roomId: input.roomId, actorKind: "agent", actorPrincipalId: input.principalId,
      action: input.action, capability: "read_room_messages", decision: "allowed", metadata: input.metadata,
    });
  }

  /** Something an agent did that crossed to another participant, recorded without its content. */
  async recordTransfer(input: { companyId: string; roomId: string; principalId: string; action: string; recipients: string[]; targetId?: string }) {
    await this.audit.record({
      companyId: input.companyId, roomId: input.roomId, actorKind: "agent", actorPrincipalId: input.principalId,
      action: input.action, decision: "allowed", targetType: "message", targetId: input.targetId ?? null,
      metadata: { recipient_principal_ids: input.recipients },
    });
  }

  /**
   * Record and announce a refusal, outside whatever transaction is about to roll back.
   * The room hears what was refused and why; never the content of what was attempted.
   */
  async deny(input: {
    companyId: string; roomId: string; principalId: string; capability?: AgentCapability | null;
    action: string; reason: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown>;
  }) {
    await this.audit.record({
      companyId: input.companyId, roomId: input.roomId, actorKind: "agent", actorPrincipalId: input.principalId,
      action: input.action, capability: input.capability ?? null, decision: "denied", reason: input.reason,
      targetType: input.targetType ?? null, targetId: input.targetId ?? null, metadata: input.metadata,
    });
    if (!this.announce) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.announce(client, {
        companyId: input.companyId, roomId: input.roomId, actorId: input.principalId, agentPrincipalId: input.principalId,
        eventType: "security.denied",
        payload: { capability: input.capability ?? null, action: input.action, reason: input.reason },
      });
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => {});
    } finally { client.release(); }
  }

  /**
   * A person changes what an agent may do. Room managers only; agents can never reach this, and
   * nothing an agent writes can cause it.
   */
  async set(input: {
    companyId: string; roomId: string; actorId: string; agentPrincipalId: string;
    capability: AgentCapability; status: "granted" | "revoked"; expiresAt?: string | null;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const manager = await client.query(
        `SELECT 1 FROM room_members rm JOIN principals p ON p.company_id=rm.company_id AND p.id=rm.principal_id
          WHERE rm.company_id=$1 AND rm.room_id=$2 AND rm.principal_id=$3 AND rm.status='active' AND rm.role='manager'
            AND p.kind='human' AND p.status='active'`, [input.companyId, input.roomId, input.actorId]);
      if (!manager.rowCount) throw new DomainError("permission_denied", "Only a person managing this room can change what an agent may do", 403);
      const agent = await client.query(
        `SELECT 1 FROM room_members rm JOIN principals p ON p.company_id=rm.company_id AND p.id=rm.principal_id
          WHERE rm.company_id=$1 AND rm.room_id=$2 AND rm.principal_id=$3 AND rm.status='active' AND p.kind='agent'`,
        [input.companyId, input.roomId, input.agentPrincipalId]);
      if (!agent.rowCount) throw new DomainError("agent_not_found", "That agent is not in this room", 404);
      await client.query(
        `INSERT INTO agent_capabilities(company_id,room_id,agent_principal_id,capability,status,changed_by_principal_id,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (company_id,room_id,agent_principal_id,capability) DO UPDATE SET
           status=EXCLUDED.status,changed_by_principal_id=EXCLUDED.changed_by_principal_id,changed_at=now(),expires_at=EXCLUDED.expires_at`,
        [input.companyId, input.roomId, input.agentPrincipalId, input.capability, input.status, input.actorId, input.expiresAt ?? null]);
      if (this.announce) await this.announce(client, {
        companyId: input.companyId, roomId: input.roomId, actorId: input.actorId, agentPrincipalId: input.agentPrincipalId,
        eventType: "agent.capability_changed",
        payload: { capability: input.capability, status: input.status, changed_by_principal_id: input.actorId },
      });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await this.audit.record({
      companyId: input.companyId, roomId: input.roomId, actorKind: "human", actorPrincipalId: input.actorId,
      action: input.status === "granted" ? "capability.grant" : "capability.revoke", capability: input.capability,
      decision: "recorded", targetType: "agent", targetId: input.agentPrincipalId,
      metadata: { expires_at: input.expiresAt ?? null },
    });
    return this.effective(input.companyId, input.roomId, input.agentPrincipalId);
  }
}

const describe = (capability: AgentCapability) => capability.replace(/_/g, " ");
