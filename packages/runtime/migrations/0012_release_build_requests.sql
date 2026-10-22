CREATE TABLE release_build_requests (
  request_key TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  target_tag TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL
);
CREATE UNIQUE INDEX release_initial_build_slot ON release_build_requests(repository_id,target_tag)
WHERE json_extract(record_json,'$.request.mode')='initial';
