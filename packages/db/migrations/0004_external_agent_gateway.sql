-- Slice 5: scoped external-agent machine credentials and durable gateway sessions.
ALTER TABLE decisions ALTER COLUMN run_id DROP NOT NULL;

CREATE TABLE external_agent_credentials (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (company_id,agent_principal_id) REFERENCES principals(company_id,id),
  FOREIGN KEY (company_id,created_by_principal_id) REFERENCES principals(company_id,id),
  UNIQUE (company_id,id)
);
CREATE INDEX external_agent_credentials_agent_idx ON external_agent_credentials(company_id,agent_principal_id,status);

CREATE TABLE external_agent_sessions (
  id uuid PRIMARY KEY,
  credential_id uuid NOT NULL REFERENCES external_agent_credentials(id),
  company_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  room_id uuid NOT NULL,
  session_token_hash text NOT NULL UNIQUE CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','offline','revoked')),
  runtime_status text NOT NULL DEFAULT 'idle' CHECK (runtime_status IN ('idle','working')),
  last_ack_room_seq bigint NOT NULL DEFAULT 0 CHECK (last_ack_room_seq >= 0),
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  FOREIGN KEY (company_id,agent_principal_id) REFERENCES principals(company_id,id),
  FOREIGN KEY (company_id,room_id,agent_principal_id) REFERENCES room_members(company_id,room_id,principal_id),
  UNIQUE (company_id,id)
);
CREATE INDEX external_agent_sessions_active_idx ON external_agent_sessions(company_id,agent_principal_id,room_id,status,last_seen_at DESC);
