ALTER TABLE issue_snapshot_reconciliation_requests
  ADD COLUMN last_dispatched_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

CREATE INDEX issue_snapshot_reconciliation_dispatch_idx
  ON issue_snapshot_reconciliation_requests(last_dispatched_at, repository_id);
