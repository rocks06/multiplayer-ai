-- Slice 9: the many-to-many task dependency model specified in the Phase 1A architecture but
-- never implemented. Room-scoped foreign keys keep a dependency inside one room.
CREATE TABLE task_dependencies (
  company_id uuid NOT NULL,
  room_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_by_principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id),
  FOREIGN KEY (company_id, room_id, task_id) REFERENCES tasks(company_id, room_id, id),
  FOREIGN KEY (company_id, room_id, depends_on_task_id) REFERENCES tasks(company_id, room_id, id),
  FOREIGN KEY (company_id, created_by_principal_id) REFERENCES principals(company_id, id)
);
CREATE INDEX task_dependencies_blocking_idx ON task_dependencies(company_id, depends_on_task_id);

-- A manager may deliberately proceed despite incomplete dependencies. The override is a
-- recorded fact on the task, granted by its own audited command, never a request parameter.
ALTER TABLE tasks ADD COLUMN dependency_override_at timestamptz;
ALTER TABLE tasks ADD COLUMN dependency_override_by_principal_id uuid;
ALTER TABLE tasks ADD CONSTRAINT tasks_dependency_override_pair
  CHECK ((dependency_override_at IS NULL) = (dependency_override_by_principal_id IS NULL));
ALTER TABLE tasks ADD FOREIGN KEY (company_id, dependency_override_by_principal_id)
  REFERENCES principals(company_id, id);
