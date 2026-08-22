CREATE TABLE issue_snapshot_issue_tombstones (
  repository_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, issue_number)
);

CREATE TABLE issue_snapshot_reconciliation_requests (
  repository_id INTEGER PRIMARY KEY,
  requested_generation INTEGER NOT NULL CHECK (requested_generation >= 0),
  requested_at TEXT NOT NULL
);
