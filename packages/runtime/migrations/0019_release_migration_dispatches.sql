CREATE TABLE release_migration_dispatches (
 dispatch_key TEXT PRIMARY KEY,
 confirmed INTEGER NOT NULL DEFAULT 0
);
