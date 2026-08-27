-- Slice 7: short-lived, single-use enrollment codes so a machine credential is never pasted
-- by hand. The code names the agent principal, so an enrolling client cannot choose one.
CREATE TABLE agent_enrollment_tokens (
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
CREATE INDEX agent_enrollment_tokens_agent_idx ON agent_enrollment_tokens(company_id,agent_principal_id,status,expires_at DESC);
