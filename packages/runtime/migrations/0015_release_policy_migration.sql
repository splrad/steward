-- Explicit policy migration preserves accepted build records and historical receipts.
ALTER TABLE release_build_requests ADD COLUMN policy_archived INTEGER NOT NULL DEFAULT 0 CHECK(policy_archived IN (0,1));
DROP INDEX release_initial_build_slot;
CREATE UNIQUE INDEX release_initial_build_slot ON release_build_requests(repository_id,target_tag) WHERE json_extract(record_json,'$.request.mode')='initial' AND json_extract(record_json,'$.status')!='superseded' AND policy_archived=0;
CREATE TABLE release_policy_migrations (
 repository_id INTEGER NOT NULL, target_tag TEXT NOT NULL, revision INTEGER NOT NULL,
 policy_sha TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(repository_id,target_tag,revision)
);
