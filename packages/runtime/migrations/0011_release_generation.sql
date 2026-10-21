CREATE TABLE release_generation (
  repository_id INTEGER NOT NULL,
  target_tag TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL,
  ticket_digest TEXT,
  ticket_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repository_id, target_tag)
);
