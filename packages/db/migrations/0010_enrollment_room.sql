-- Which room an enrollment code is for.
--
-- The code carried a company and an agent but no room, so redemption had to guess: it returned
-- every room the agent belonged to, oldest membership first, and the connecting Mac took the
-- first one. Pressing Connect inside a room therefore bound the agent to whichever room it had
-- joined earliest — silently, and with every screen afterwards reporting success.
--
-- Nullable because codes issued before this column existed have no answer, and inventing one for
-- them would repeat the original mistake in a new place.
ALTER TABLE agent_enrollment_tokens ADD COLUMN IF NOT EXISTS room_id uuid;

ALTER TABLE agent_enrollment_tokens
  ADD CONSTRAINT agent_enrollment_tokens_room_fk
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id);
