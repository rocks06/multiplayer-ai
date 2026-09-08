-- Files produced or shared in a room.
--
-- One model for both: a file an agent generated and a file a person attached are the same thing to
-- everybody who later needs it, and building two systems would mean two sets of permissions to get
-- right. Bytes never live here — only where to find them and what they are — because a database is
-- a poor filing cabinet and backups should not carry gigabytes of somebody's PDFs.
--
-- Room-scoped by construction: every artifact belongs to exactly one room, and the composite keys
-- make it impossible to attach one to a message in a different room.
CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  creator_principal_id uuid NOT NULL,
  -- What a person sees. Never used to build a storage path: a filename from an agent or an upload
  -- is untrusted text, and a path built from it is a traversal waiting to happen.
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  -- Where the provider keeps it. Opaque to everything above the storage layer.
  storage_key text NOT NULL UNIQUE,
  /* An artifact exists before its bytes do: the row is written, the upload follows, and only then
     is it delivered. Anything that fails in between stays 'pending' and is never shown as though
     it arrived — which is what stops a room claiming a file it does not have. */
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  -- Page counts, dimensions, a checksum: whatever a viewer can use, without a column each.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK ((status = 'ready') = (delivered_at IS NOT NULL)),
  UNIQUE (company_id, room_id, id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms(company_id, id),
  FOREIGN KEY (company_id, creator_principal_id) REFERENCES principals(company_id, id)
);
CREATE INDEX IF NOT EXISTS artifacts_room_idx ON artifacts(company_id, room_id, created_at DESC);

-- What a message carries. A message may have several files; a file belongs to one message at most,
-- because an artifact posted twice is two deliveries and should be two rows.
CREATE TABLE IF NOT EXISTS message_artifacts (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  message_id uuid NOT NULL,
  artifact_id uuid NOT NULL UNIQUE,
  position int NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, message_id, artifact_id),
  FOREIGN KEY (company_id, room_id, message_id) REFERENCES messages(company_id, room_id, id),
  FOREIGN KEY (company_id, room_id, artifact_id) REFERENCES artifacts(company_id, room_id, id)
);
CREATE INDEX IF NOT EXISTS message_artifacts_message_idx ON message_artifacts(company_id, message_id);
