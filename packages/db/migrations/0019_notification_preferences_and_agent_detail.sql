-- How much a person wants to be told about one room, and what an agent's card can say about itself.
--
-- A preference belongs to a person and a room together: two people in the same room are not asking
-- to be interrupted by the same things, and the same person wants different things from different
-- rooms. It governs native notifications only — unread state is what the room contains and is not a
-- matter of preference, so it is deliberately not read from here.
CREATE TABLE IF NOT EXISTS room_notification_preferences (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  -- all: everything the room considers notable. direct_mentions: sent to them, naming them, or
  -- needing them. mentions: only being named. important: only what needs a person. off: nothing.
  level text NOT NULL CHECK (level IN ('all','direct_mentions','mentions','important','off')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, room_id, user_id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id)
);

-- What a person needs to identify one agent's Mac: which local profile it runs, and which machine
-- that is. Both are what the connector reports about itself — shown, never trusted, and never used
-- to authorize anything.
ALTER TABLE runtime_installations ADD COLUMN IF NOT EXISTS runtime_profile text;
ALTER TABLE runtime_installations ADD COLUMN IF NOT EXISTS device_label text;
