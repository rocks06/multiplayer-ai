-- Who caused a sign-in token to exist.
--
-- A token minted for somebody else used to be indistinguishable from one they asked for
-- themselves, so an operator-issued link — and any abuse of that path — left no trace worth
-- reading. Recorded from now on. Deliberately not backfilled: what happened before this column
-- existed is unknown, and writing a guess into an audit column is worse than an empty one.
ALTER TABLE user_auth_tokens ADD COLUMN IF NOT EXISTS issued_by_principal_id uuid;
ALTER TABLE user_auth_tokens ADD COLUMN IF NOT EXISTS issue_reason text;
