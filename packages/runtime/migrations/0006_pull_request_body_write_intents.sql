CREATE TABLE pull_request_body_write_intents (
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  region_kind TEXT NOT NULL CHECK (region_kind IN ('managed-pr', 'issue-links')),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  issue_generation INTEGER NOT NULL DEFAULT 0 CHECK (issue_generation >= 0),
  before_body_digest TEXT NOT NULL,
  outside_body_digest TEXT NOT NULL,
  target_block TEXT,
  target_body_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'patched', 'compensating', 'confirmed', 'blocked')),
  compensation_generation INTEGER NOT NULL DEFAULT 0 CHECK (compensation_generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  delivery_proven INTEGER NOT NULL DEFAULT 0 CHECK (delivery_proven IN (0, 1)),
  last_delivery_id TEXT,
  redrive_required INTEGER NOT NULL DEFAULT 0 CHECK (redrive_required IN (0, 1)),
  redrive_dispatched INTEGER NOT NULL DEFAULT 0 CHECK (redrive_dispatched IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  blocked_reason TEXT,
  PRIMARY KEY (repository_id, pull_request_number),
  UNIQUE (write_id)
);

CREATE INDEX pull_request_body_write_intents_pending
  ON pull_request_body_write_intents (status, expires_at, updated_at);

CREATE INDEX pull_request_body_write_intents_redrive
  ON pull_request_body_write_intents (redrive_required, redrive_dispatched, updated_at);

CREATE TABLE pull_request_body_write_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('processing', 'ignored', 'proven', 'compensated', 'blocked')),
  processed_at TEXT NOT NULL
);

CREATE INDEX pull_request_body_write_deliveries_intent
  ON pull_request_body_write_deliveries (repository_id, pull_request_number, write_id);
