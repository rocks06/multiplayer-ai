-- Bounded agent-to-agent collaboration.
--
-- When an agent hands work to another agent (or a person mentions several agents at once), the
-- agents involved may keep working together without a person pinging each turn. That is state, not
-- a habit of the prompt: who is in it, how many turns it has used, and whether it is still going.
-- Every turn is still an ordinary persisted message; this row only decides whom each one wakes, and
-- it stops — completed, out of turns, idle, or waiting for a person — rather than looping.
CREATE TABLE IF NOT EXISTS agent_collaborations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  started_by_principal_id uuid NOT NULL,
  started_message_id uuid NOT NULL,
  participant_principal_ids uuid[] NOT NULL CHECK (cardinality(participant_principal_ids) BETWEEN 1 AND 20),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','waiting_for_human','completed','exhausted','expired')),
  turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  max_turns integer NOT NULL CHECK (max_turns BETWEEN 1 AND 50),
  ended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, started_by_principal_id) REFERENCES principals(company_id, id)
);
CREATE INDEX IF NOT EXISTS agent_collaborations_room_status_idx ON agent_collaborations(company_id, room_id, status, updated_at);
