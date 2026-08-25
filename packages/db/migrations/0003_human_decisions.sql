-- Slice 4: structured human decisions and durable agent resume.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN ('queued','running','retry_wait','waiting_for_decision','completed','failed','cancelled'));
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS waiting_decision_id uuid;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS context_event_seq bigint;

DROP INDEX IF EXISTS agent_runs_queue_idx;
CREATE INDEX agent_runs_queue_idx ON agent_runs(status,available_at,created_at) WHERE status IN ('queued','running','retry_wait');
DROP INDEX IF EXISTS agent_runs_one_active_agent_room_idx;
CREATE UNIQUE INDEX agent_runs_one_active_agent_room_idx ON agent_runs(company_id,room_id,agent_id) WHERE status IN ('queued','running','retry_wait','waiting_for_decision');

CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  run_id uuid NOT NULL,
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
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
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
