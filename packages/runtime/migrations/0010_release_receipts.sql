-- Additive: historical body/issue tables and migrations remain untouched.
CREATE TABLE release_receipts (
  repository_id INTEGER NOT NULL,
  target_tag TEXT NOT NULL,
  revision INTEGER NOT NULL,
  version INTEGER NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  record_json TEXT NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  dispatch_after INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, target_tag, revision)
);
CREATE UNIQUE INDEX release_receipts_current ON release_receipts(repository_id, target_tag) WHERE current = 1;
CREATE TABLE release_evidence_chunks (
  repository_id INTEGER NOT NULL,
  digest TEXT NOT NULL,
  part INTEGER NOT NULL,
  total INTEGER NOT NULL,
  bytes_base64 TEXT NOT NULL,
  PRIMARY KEY (repository_id, digest, part)
);
