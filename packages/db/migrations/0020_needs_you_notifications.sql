-- "Important" asked the product to judge what matters. "Needs you" does not: it is the set of
-- events that cannot proceed without a person — a decision to make, an agent blocked waiting for
-- human input, and a run that has failed for good, including one that failed for a missing
-- permission, credential or input. Nothing else qualifies, and nothing infers.
ALTER TABLE room_notification_preferences DROP CONSTRAINT IF EXISTS room_notification_preferences_level_check;
UPDATE room_notification_preferences SET level='needs_you' WHERE level='important';
ALTER TABLE room_notification_preferences ADD CONSTRAINT room_notification_preferences_level_check
  CHECK (level IN ('all','direct_mentions','mentions','needs_you','off'));
