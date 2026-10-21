ALTER TABLE release_generation ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE release_generation_history (
  repository_id INTEGER NOT NULL,
  target_tag TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  version INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY(repository_id,target_tag,plan_digest)
);
