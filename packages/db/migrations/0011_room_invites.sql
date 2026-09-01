CREATE TABLE IF NOT EXISTS room_invites (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL,
  role text NOT NULL DEFAULT 'contributor' CHECK (role IN ('manager','contributor')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','revoked')),
  created_by_principal_id uuid NOT NULL,
  consumed_by_user_id uuid REFERENCES users(id),
  consumed_by_principal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (company_id,room_id) REFERENCES rooms(company_id,id),
  FOREIGN KEY (company_id,created_by_principal_id) REFERENCES principals(company_id,id),
  FOREIGN KEY (company_id,consumed_by_principal_id) REFERENCES principals(company_id,id),
  CHECK (
    (status='pending' AND consumed_at IS NULL AND revoked_at IS NULL AND consumed_by_user_id IS NULL AND consumed_by_principal_id IS NULL) OR
    (status='consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL AND consumed_by_user_id IS NOT NULL AND consumed_by_principal_id IS NOT NULL) OR
    (status='revoked' AND consumed_at IS NULL AND revoked_at IS NOT NULL AND consumed_by_user_id IS NULL AND consumed_by_principal_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS room_invites_room_status_idx ON room_invites(company_id,room_id,status,expires_at DESC);
