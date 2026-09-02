-- One live binding per agent, made structurally impossible to violate.
--
-- Opening a session inserted a row and retired nothing, and minting a credential did the same, so
-- an agent could hold several of each at once. Every presence query resolves the ambiguity with
-- `ORDER BY last_seen_at DESC LIMIT 1`, which means the answer depended on whichever heartbeat
-- landed last: an agent appeared connected, then not, then connected again, with nothing wrong
-- with the connection. A reconnect storm — fourteen in seven seconds, observed — left fourteen
-- rows all claiming to be live.
--
-- Superseded is its own state on purpose. A binding that a newer one replaced was neither revoked
-- by a person nor dropped by a network, and saying either would be untrue.

ALTER TABLE external_agent_sessions DROP CONSTRAINT external_agent_sessions_status_check;
ALTER TABLE external_agent_sessions ADD CONSTRAINT external_agent_sessions_status_check
  CHECK (status IN ('connected','offline','revoked','superseded'));

ALTER TABLE external_agent_credentials DROP CONSTRAINT external_agent_credentials_status_check;
ALTER TABLE external_agent_credentials ADD CONSTRAINT external_agent_credentials_status_check
  CHECK (status IN ('active','revoked','superseded'));

-- Existing duplicates are retired newest-wins, which is the same rule every presence query was
-- already applying implicitly. Nothing is deleted: the history of who was connected when is the
-- record these tables exist to keep.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY company_id, agent_principal_id
    ORDER BY last_seen_at DESC, connected_at DESC, id DESC) AS rank
  FROM external_agent_sessions WHERE status = 'connected'
)
UPDATE external_agent_sessions s
   SET status = 'superseded', disconnected_at = COALESCE(s.disconnected_at, now())
  FROM ranked WHERE s.id = ranked.id AND ranked.rank > 1;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY company_id, agent_principal_id
    ORDER BY created_at DESC, id DESC) AS rank
  FROM external_agent_credentials WHERE status = 'active'
)
UPDATE external_agent_credentials c
   SET status = 'superseded', revoked_at = COALESCE(c.revoked_at, now())
  FROM ranked WHERE c.id = ranked.id AND ranked.rank > 1;

-- The guarantee itself. With these in place a second live binding cannot be written at all, so
-- the service cannot forget to retire one and no race can slip between a check and an insert.
CREATE UNIQUE INDEX IF NOT EXISTS external_agent_sessions_one_live
  ON external_agent_sessions (company_id, agent_principal_id) WHERE status = 'connected';

CREATE UNIQUE INDEX IF NOT EXISTS external_agent_credentials_one_active
  ON external_agent_credentials (company_id, agent_principal_id) WHERE status = 'active';
