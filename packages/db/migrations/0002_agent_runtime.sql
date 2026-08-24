-- Slice 3: durable agent runtime. Safe to apply after the accepted Slice 1/2 schema.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS run_generation integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Bind command idempotency to its tenant, room, principal, and command surface.
ALTER TABLE command_receipts ADD COLUMN IF NOT EXISTS room_id uuid;
UPDATE command_receipts cr SET room_id=re.room_id FROM room_events re WHERE re.company_id=cr.company_id AND re.command_id=cr.command_id AND cr.room_id IS NULL;
ALTER TABLE command_receipts ALTER COLUMN room_id SET NOT NULL;
ALTER TABLE command_receipts DROP CONSTRAINT IF EXISTS command_receipts_company_id_principal_id_idempotency_key_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='command_receipts_company_room_fk') THEN
    ALTER TABLE command_receipts ADD CONSTRAINT command_receipts_company_room_fk FOREIGN KEY(company_id,room_id) REFERENCES rooms(company_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='command_receipts_company_principal_fk') THEN
    ALTER TABLE command_receipts ADD CONSTRAINT command_receipts_company_principal_fk FOREIGN KEY(company_id,principal_id) REFERENCES principals(company_id,id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS command_receipts_scoped_idempotency_idx ON command_receipts(company_id,room_id,principal_id,command_type,idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS room_members_company_room_principal_idx ON room_members(company_id,room_id,principal_id);

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
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','completed','failed','cancelled')),
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
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_agent_room_idx ON agent_runs(company_id,room_id,agent_id) WHERE status IN ('queued','running','retry_wait');

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
