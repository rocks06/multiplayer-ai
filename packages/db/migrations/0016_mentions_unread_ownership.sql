-- Mentions, ownership and read position.
--
-- A mention is structure, not text: the message says "@Name", and this row says which room
-- participant that is, so routing and notification never parse a display name. Offsets are UTF-16
-- code units, the unit browser selection and JavaScript strings use.
CREATE TABLE IF NOT EXISTS message_mentions (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  message_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  PRIMARY KEY (company_id, message_id, start_offset),
  -- The message's own room: a mention can never point into a different room than its message.
  FOREIGN KEY (company_id, room_id, message_id) REFERENCES messages(company_id, room_id, id),
  FOREIGN KEY (company_id, principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id)
);
CREATE INDEX IF NOT EXISTS message_mentions_recipient_idx ON message_mentions(company_id, principal_id, room_id);

-- Which person an agent belongs to, recorded rather than inferred from a name, so "someone's agent"
-- can be resolved generically. A person may own any number of agents and an agent may have more
-- than one owner; ownership says nothing about which rooms either is in.
CREATE TABLE IF NOT EXISTS agent_human_relationships (
  company_id uuid NOT NULL,
  human_principal_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  relationship text NOT NULL DEFAULT 'owner' CHECK (relationship IN ('owner')),
  created_by_principal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, human_principal_id, agent_principal_id),
  FOREIGN KEY (company_id, human_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, agent_principal_id) REFERENCES principals(company_id, id)
);
CREATE INDEX IF NOT EXISTS agent_human_relationships_agent_idx ON agent_human_relationships(company_id, agent_principal_id);

-- Owners already on record: the user an agent was created for, and the person who connected its runtime.
INSERT INTO agent_human_relationships(company_id, human_principal_id, agent_principal_id)
  SELECT DISTINCT ap.company_id, hp.id, ap.id
    FROM agents a
    JOIN principals ap ON ap.company_id = a.company_id AND ap.agent_id = a.id AND ap.kind = 'agent'
    JOIN principals hp ON hp.company_id = a.company_id AND hp.user_id = a.owner_user_id AND hp.kind = 'human'
   WHERE a.owner_user_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO agent_human_relationships(company_id, human_principal_id, agent_principal_id)
  SELECT DISTINCT b.company_id, b.created_by_principal_id, b.agent_principal_id
    FROM agent_runtime_bindings b
    JOIN principals h ON h.company_id = b.company_id AND h.id = b.created_by_principal_id AND h.kind = 'human'
ON CONFLICT DO NOTHING;

-- How far each person has read each room. Unread is everything meaningful after this, and nothing
-- from before they joined; there is no row until they first read, so no backfill is needed.
CREATE TABLE IF NOT EXISTS room_read_cursors (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, room_id, principal_id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, principal_id) REFERENCES principals(company_id, id)
);

-- Notifications are read from the event log in time order, per room.
CREATE INDEX IF NOT EXISTS room_events_room_created_idx ON room_events(room_id, created_at);
