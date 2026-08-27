-- Slice 8: real human authentication. Identity stops being a client-supplied header.
-- Both tables follow the enrollment pattern: hash-only storage, single-use where applicable,
-- short expiry, explicit revocation.
CREATE TABLE user_auth_tokens (
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
CREATE INDEX user_auth_tokens_user_idx ON user_auth_tokens(user_id,status,expires_at DESC);

CREATE TABLE user_sessions (
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
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id,status,expires_at DESC);
