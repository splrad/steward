ALTER TABLE issue_snapshot_reconciliation_requests
ADD COLUMN requested_state_revision INTEGER NOT NULL DEFAULT 0 CHECK (requested_state_revision >= 0);
