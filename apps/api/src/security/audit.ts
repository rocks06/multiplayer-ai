import { v7 as uuidv7 } from "uuid";
import type { DbPool } from "../db.js";
import { redactSecrets } from "./secrets.js";

export type AuditDecision = "allowed" | "denied" | "approval_required" | "recorded";
export type AuditActorKind = "human" | "agent" | "system" | "anonymous";

export interface AuditEvent {
  companyId?: string | null;
  roomId?: string | null;
  actorKind: AuditActorKind;
  actorPrincipalId?: string | null;
  actorUserId?: string | null;
  /** What was attempted, as a stable dotted name: `agent.session.open`, `capability.denied`. */
  action: string;
  capability?: string | null;
  decision: AuditDecision;
  /** A machine-readable reason code, never free text from a request. */
  reason?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  /** Identifiers and counts only. Strings are redacted on the way in regardless. */
  metadata?: Record<string, unknown>;
}

/** Strings that could carry a credential are redacted; nothing long is kept at all. */
const clean = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 50).map(item => clean(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      // Anything named like a secret is dropped by name, whatever it contains.
      if (/(^|_)(token|secret|password|passphrase|credential|authorization|cookie|api_?key|private_?key)$/i.test(key)) continue;
      out[key] = clean(item, depth + 1);
    }
    return out;
  }
  return value;
};

/**
 * The security record: what was allowed, refused or sent for approval, by whom, where.
 *
 * Written on its own connection by design. A refusal is usually followed by the refused command's
 * transaction rolling back, and a record written inside that transaction would roll back with it —
 * leaving exactly the attempts worth keeping unrecorded.
 */
export class SecurityAudit {
  constructor(private readonly pool: DbPool) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO security_audit_events(id,company_id,room_id,actor_kind,actor_principal_id,actor_user_id,
           action,capability,decision,reason,target_type,target_id,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [uuidv7(), event.companyId ?? null, event.roomId ?? null, event.actorKind, event.actorPrincipalId ?? null,
         event.actorUserId ?? null, event.action, event.capability ?? null, event.decision, event.reason ?? null,
         event.targetType ?? null, event.targetId ?? null, JSON.stringify(clean(event.metadata ?? {}))]);
    } catch (failure) {
      // The audit must never become the reason an allowed action fails, nor hide a refusal: the
      // caller's decision stands either way. The failure itself is reported where operators look.
      console.error(`[security-audit] could not record ${event.action}: ${(failure as Error)?.message ?? failure}`);
    }
  }
}
