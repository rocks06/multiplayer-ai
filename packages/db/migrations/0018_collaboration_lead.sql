-- One agreed result per collaboration.
--
-- Two agents working together each delivered their own "final" file. A collaboration now has a
-- lead: the agent that started it, or the first agent a person asked. Other participants
-- contribute; when a contributor says its part is done, only the lead is woken, to produce the one
-- final result and end the collaboration.
ALTER TABLE agent_collaborations ADD COLUMN IF NOT EXISTS lead_principal_id uuid;
ALTER TABLE agent_collaborations ADD COLUMN IF NOT EXISTS finalizing boolean NOT NULL DEFAULT false;
UPDATE agent_collaborations c
   SET lead_principal_id = CASE WHEN c.started_by_principal_id = ANY(c.participant_principal_ids) THEN c.started_by_principal_id
                                ELSE c.participant_principal_ids[1] END
 WHERE c.lead_principal_id IS NULL;
