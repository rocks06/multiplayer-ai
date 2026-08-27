CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_users (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  owner_user_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, owner_user_id) REFERENCES company_users(company_id, user_id)
);

CREATE TABLE IF NOT EXISTS principals (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('human','agent','system')),
  user_id uuid,
  agent_id uuid,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind='human' AND user_id IS NOT NULL AND agent_id IS NULL) OR
    (kind='agent' AND user_id IS NULL AND agent_id IS NOT NULL) OR
    (kind='system' AND user_id IS NULL AND agent_id IS NULL)
  ),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, user_id) REFERENCES company_users(company_id, user_id),
  FOREIGN KEY (company_id, agent_id) REFERENCES agents(company_id, id)
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  objective text NOT NULL,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, created_by_principal_id) REFERENCES principals(company_id, id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL,
  name text NOT NULL,
  last_event_seq bigint NOT NULL DEFAULT 0,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id),
  FOREIGN KEY (company_id, created_by_principal_id) REFERENCES principals(company_id, id)
);

CREATE TABLE IF NOT EXISTS room_members (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('manager','contributor','worker_agent')),
  responsibilities text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, principal_id) REFERENCES principals(company_id, id),
  UNIQUE (room_id, principal_id),
  UNIQUE (company_id, room_id, principal_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','awaiting_decision','completed','cancelled')),
  created_by_principal_id uuid NOT NULL,
  assignee_principal_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  dependency_override_at timestamptz,
  dependency_override_by_principal_id uuid,
  CHECK ((dependency_override_at IS NULL) = (dependency_override_by_principal_id IS NULL)),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, created_by_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, assignee_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, dependency_override_by_principal_id) REFERENCES principals(company_id, id),
  UNIQUE (company_id, room_id, id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (company_id, room_id, task_id) REFERENCES tasks(company_id, room_id, id),
  FOREIGN KEY (company_id, room_id, depends_on_task_id) REFERENCES tasks(company_id, room_id, id),
  FOREIGN KEY (company_id, created_by_principal_id) REFERENCES principals(company_id, id)
);
CREATE INDEX IF NOT EXISTS task_dependencies_blocking_idx ON task_dependencies(company_id, depends_on_task_id);
CREATE INDEX IF NOT EXISTS tasks_room_status_idx ON tasks(room_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  sender_principal_id uuid NOT NULL,
  addressed_principal_id uuid,
  body_text text NOT NULL,
  task_id uuid,
  in_reply_to_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, room_id, id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, sender_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, addressed_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, room_id, task_id) REFERENCES tasks(company_id, room_id, id),
  FOREIGN KEY (company_id, room_id, in_reply_to_message_id) REFERENCES messages(company_id, room_id, id)
);
CREATE INDEX IF NOT EXISTS messages_in_reply_to_idx ON messages(company_id, room_id, in_reply_to_message_id);
CREATE INDEX IF NOT EXISTS messages_room_created_idx ON messages(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS room_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  room_seq bigint NOT NULL,
  event_type text NOT NULL,
  actor_principal_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_display_name text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  command_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, actor_principal_id) REFERENCES principals(company_id, id),
  UNIQUE (room_id, room_seq)
);
CREATE INDEX IF NOT EXISTS room_events_replay_idx ON room_events(room_id, room_seq);

CREATE TABLE IF NOT EXISTS command_receipts (
  command_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  room_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_digest text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,room_id) REFERENCES rooms(company_id,id),
  FOREIGN KEY (company_id,principal_id) REFERENCES principals(company_id,id),
  UNIQUE (company_id,room_id,principal_id,command_type,idempotency_key)
);

-- Latest schema also contains Slice 3 runtime state. The versioned migration remains
-- available for databases created from the accepted Slice 1/2 checkpoint.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_generation integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='principals_company_principal_agent_unique') THEN
    ALTER TABLE principals ADD CONSTRAINT principals_company_principal_agent_unique UNIQUE (company_id,id,agent_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  task_id uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','waiting_for_decision','completed','failed','cancelled')),
  run_generation integer NOT NULL,
  script jsonb NOT NULL,
  checkpoint_step integer NOT NULL DEFAULT 0 CHECK (checkpoint_step >= 0),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text,
  error_message text,
  queued_by_principal_id uuid NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,room_id) REFERENCES rooms(company_id,id),
  FOREIGN KEY (company_id,agent_id) REFERENCES agents(company_id,id),
  FOREIGN KEY (company_id,agent_principal_id,agent_id) REFERENCES principals(company_id,id,agent_id),
  FOREIGN KEY (company_id,room_id,agent_principal_id) REFERENCES room_members(company_id,room_id,principal_id),
  FOREIGN KEY (company_id,room_id,task_id) REFERENCES tasks(company_id,room_id,id),
  FOREIGN KEY (company_id,queued_by_principal_id) REFERENCES principals(company_id,id)
);
CREATE INDEX IF NOT EXISTS agent_runs_queue_idx ON agent_runs(status,available_at,created_at) WHERE status IN ('queued','running','retry_wait');
-- Phase 1A scheduler constraint, deliberately not a permanent domain invariant.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_agent_room_idx ON agent_runs(company_id,room_id,agent_id) WHERE status IN ('queued','running','retry_wait','waiting_for_decision');

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  run_generation integer NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  provider_call_id text NOT NULL,
  tool_name text NOT NULL,
  arguments jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed','failed')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,room_id) REFERENCES rooms(company_id,id),
  FOREIGN KEY (company_id,agent_principal_id) REFERENCES principals(company_id,id),
  UNIQUE (run_id,provider_call_id),
  UNIQUE (company_id,agent_principal_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS agent_tool_calls_run_step_idx ON agent_tool_calls(run_id,step_index);

-- Slice 4: structured human decisions and durable agent resume.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN ('queued','running','retry_wait','waiting_for_decision','completed','failed','cancelled'));
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS waiting_decision_id uuid;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS context_event_seq bigint;
DROP INDEX IF EXISTS agent_runs_one_active_agent_room_idx;
CREATE UNIQUE INDEX agent_runs_one_active_agent_room_idx ON agent_runs(company_id,room_id,agent_id) WHERE status IN ('queued','running','retry_wait','waiting_for_decision');

CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  requested_by_principal_id uuid NOT NULL,
  title text NOT NULL,
  question text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  proposed_action jsonb NOT NULL,
  proposed_action_digest text NOT NULL CHECK (proposed_action_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  resolved_by_principal_id uuid,
  resolution_note text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  expires_at timestamptz,
  FOREIGN KEY (company_id,room_id) REFERENCES rooms(company_id,id),
  FOREIGN KEY (company_id,requested_by_principal_id) REFERENCES principals(company_id,id),
  FOREIGN KEY (company_id,resolved_by_principal_id) REFERENCES principals(company_id,id),
  UNIQUE (company_id,room_id,id),
  CHECK ((status='pending' AND resolved_by_principal_id IS NULL AND resolved_at IS NULL) OR status<>'pending')
);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_pending_run_idx ON decisions(run_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS decisions_room_status_idx ON decisions(company_id,room_id,status,requested_at DESC);
CREATE INDEX IF NOT EXISTS decisions_run_idx ON decisions(run_id,requested_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_runs_waiting_decision_fk') THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_waiting_decision_fk FOREIGN KEY(waiting_decision_id) REFERENCES decisions(id);
  END IF;
END $$;

-- Slice 5: scoped external-agent machine credentials and durable gateway sessions.
ALTER TABLE decisions ALTER COLUMN run_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS external_agent_credentials (
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
CREATE INDEX IF NOT EXISTS external_agent_credentials_agent_idx ON external_agent_credentials(company_id,agent_principal_id,status);

CREATE TABLE IF NOT EXISTS external_agent_sessions (
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
CREATE INDEX IF NOT EXISTS external_agent_sessions_active_idx ON external_agent_sessions(company_id,agent_principal_id,room_id,status,last_seen_at DESC);

CREATE TABLE IF NOT EXISTS agent_enrollment_tokens (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_prefix text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','revoked')),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  device_label text,
  credential_id uuid REFERENCES external_agent_credentials(id),
  FOREIGN KEY (company_id,agent_principal_id) REFERENCES principals(company_id,id),
  FOREIGN KEY (company_id,created_by_principal_id) REFERENCES principals(company_id,id),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  UNIQUE (company_id,id)
);
CREATE INDEX IF NOT EXISTS agent_enrollment_tokens_agent_idx ON agent_enrollment_tokens(company_id,agent_principal_id,status,expires_at DESC);

CREATE TABLE IF NOT EXISTS user_auth_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS user_auth_tokens_user_idx ON user_auth_tokens(user_id,status,expires_at DESC);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id,status,expires_at DESC);
