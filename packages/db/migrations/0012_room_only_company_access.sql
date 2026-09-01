-- Room invitations create a company-scoped principal only because room membership references one.
-- That principal must not silently become a workspace administrator. Existing memberships retain
-- their historical workspace access; invite-created memberships are explicitly room-only.
ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS access_scope text NOT NULL DEFAULT 'workspace'
  CHECK (access_scope IN ('workspace','room_only'));

-- Human room invitations are deliberately contributor-only. Manager promotion is a separate,
-- authenticated room-manager action and cannot be smuggled into an invitation record.
ALTER TABLE room_invites DROP CONSTRAINT IF EXISTS room_invites_role_check;
UPDATE room_invites SET role='contributor' WHERE role<>'contributor';
ALTER TABLE room_invites
  ADD CONSTRAINT room_invites_role_check CHECK (role='contributor');
