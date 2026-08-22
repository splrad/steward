CREATE TABLE issue_snapshots (
  repository_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  source_updated_at TEXT NOT NULL,
  comments_count INTEGER NOT NULL CHECK (comments_count >= 0),
  content_digest TEXT NOT NULL,
  validators_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  last_delivery_id TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, issue_number)
);

CREATE INDEX issue_snapshots_open
ON issue_snapshots(repository_id, state, issue_number);

CREATE TABLE issue_snapshot_repositories (
  repository_id INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  sync_state TEXT NOT NULL CHECK (sync_state IN ('uninitialized', 'scanning', 'ready', 'degraded')),
  open_set_digest TEXT NOT NULL,
  last_full_scan_at TEXT,
  updated_at TEXT NOT NULL
);
