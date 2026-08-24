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
  agent_id uuid REFERENCES agents(id),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind='human' AND user_id IS NOT NULL AND agent_id IS NULL) OR
    (kind='agent' AND user_id IS NULL AND agent_id IS NOT NULL) OR
    (kind='system' AND user_id IS NULL AND agent_id IS NULL)
  ),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, user_id) REFERENCES company_users(company_id, user_id)
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
  UNIQUE (room_id, principal_id)
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
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, created_by_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, assignee_principal_id) REFERENCES principals(company_id, id),
  UNIQUE (company_id, room_id, id)
);
CREATE INDEX IF NOT EXISTS tasks_room_status_idx ON tasks(room_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  sender_principal_id uuid NOT NULL,
  addressed_principal_id uuid,
  body_text text NOT NULL,
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, sender_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, addressed_principal_id) REFERENCES principals(company_id, id),
  FOREIGN KEY (company_id, room_id, task_id) REFERENCES tasks(company_id, room_id, id)
);
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
  principal_id uuid NOT NULL REFERENCES principals(id),
  idempotency_key text NOT NULL,
  command_type text NOT NULL,
  request_digest text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, principal_id, idempotency_key)
);
