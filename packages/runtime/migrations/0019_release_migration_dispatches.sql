CREATE TABLE release_migration_dispatches (
 dispatch_key TEXT PRIMARY KEY,
 payload_json TEXT NOT NULL,
 confirmed INTEGER NOT NULL DEFAULT 0
);
