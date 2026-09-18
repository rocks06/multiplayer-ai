-- What each agent may do in each room, and a durable record of what was allowed and refused.
--
-- A capability row exists only where a person changed something: granted beyond the room
-- defaults, or revoked one of them. No row means the platform default for that capability, which
-- is deny for everything outside the small set that taking part in a room requires. Rows are
-- never deleted; revoking is a state, so what an agent could do at any moment stays answerable.
CREATE TABLE IF NOT EXISTS agent_capabilities (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  capability text NOT NULL,
  status text NOT NULL CHECK (status IN ('granted','revoked')),
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by_principal_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (company_id, room_id, agent_principal_id, capability),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, agent_principal_id) REFERENCES principals(company_id, id)
);

-- Security-relevant facts, append-only. No foreign keys on purpose: the record of what happened
-- must outlive the room, the agent or the person it is about, and must never block their removal.
-- Nothing secret is ever written here: identifiers, decisions and reasons only.
CREATE TABLE IF NOT EXISTS security_audit_events (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  company_id uuid,
  room_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','agent','system','anonymous')),
  actor_principal_id uuid,
  actor_user_id uuid,
  action text NOT NULL,
  capability text,
  decision text NOT NULL CHECK (decision IN ('allowed','denied','approval_required','recorded')),
  reason text,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS security_audit_events_company_idx ON security_audit_events(company_id, at DESC);
CREATE INDEX IF NOT EXISTS security_audit_events_actor_idx ON security_audit_events(actor_principal_id, at DESC);

-- An audit log that can be edited is a story, not a record.
CREATE OR REPLACE FUNCTION security_audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'security_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS security_audit_events_no_change ON security_audit_events;
CREATE TRIGGER security_audit_events_no_change BEFORE UPDATE OR DELETE ON security_audit_events
  FOR EACH ROW EXECUTE FUNCTION security_audit_events_append_only();
