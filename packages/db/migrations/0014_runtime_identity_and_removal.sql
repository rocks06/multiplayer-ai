-- A physical runtime installation is not an agent credential, session, display name, connector
-- process, or room membership. This durable identity survives all of those changing.
CREATE TABLE IF NOT EXISTS runtime_installations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  runtime_type text NOT NULL,
  external_runtime_id uuid NOT NULL,
  connector_installation_id uuid NOT NULL,
  endpoint text NOT NULL,
  runtime_version text,
  probe_status text NOT NULL CHECK (probe_status IN ('healthy','unreachable')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id,runtime_type,external_runtime_id),
  UNIQUE (company_id,id)
);
CREATE INDEX IF NOT EXISTS runtime_installations_connector_idx
  ON runtime_installations(company_id,connector_installation_id);

CREATE TABLE IF NOT EXISTS agent_runtime_bindings (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  runtime_installation_id uuid NOT NULL,
  agent_principal_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced','removed')),
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  FOREIGN KEY (company_id,runtime_installation_id) REFERENCES runtime_installations(company_id,id),
  FOREIGN KEY (company_id,agent_principal_id) REFERENCES principals(company_id,id),
  FOREIGN KEY (company_id,created_by_principal_id) REFERENCES principals(company_id,id),
  UNIQUE (company_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_bindings_one_active_runtime
  ON agent_runtime_bindings(company_id,runtime_installation_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS agent_runtime_bindings_agent_idx
  ON agent_runtime_bindings(company_id,agent_principal_id,status);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- Guarded, because a migration the repair pass re-applies must survive meeting its own work.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rooms_status_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_status_check CHECK (status IN ('active','deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rooms_deleted_at_check') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_deleted_at_check
      CHECK ((status='active' AND deleted_at IS NULL) OR (status='deleted' AND deleted_at IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS rooms_active_idx ON rooms(company_id,status,created_at);
