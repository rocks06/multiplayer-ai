-- Slice 10: an explicit reply relationship between messages. Adjacency plus an addressed
-- principal is a heuristic; one interleaved message and it links the wrong pair.
ALTER TABLE messages ADD CONSTRAINT messages_company_room_id_key UNIQUE (company_id, room_id, id);
ALTER TABLE messages ADD COLUMN in_reply_to_message_id uuid;
ALTER TABLE messages ADD FOREIGN KEY (company_id, room_id, in_reply_to_message_id)
  REFERENCES messages(company_id, room_id, id);
CREATE INDEX messages_in_reply_to_idx ON messages(company_id, room_id, in_reply_to_message_id);
