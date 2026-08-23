ALTER TABLE issue_snapshot_repositories
ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0);
