CREATE TABLE pages_completion_dispatches (
    repository_id INTEGER NOT NULL,
    workflow_id INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    controller_sha TEXT NOT NULL,
    reserved_at TEXT NOT NULL,
    run_created_at TEXT NOT NULL,
    central_run_id INTEGER,
    PRIMARY KEY (repository_id, workflow_id, run_id, attempt)
) WITHOUT ROWID;
