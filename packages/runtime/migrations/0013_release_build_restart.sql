-- Retain archived requests and their run identities; reserve one active initial request.
DROP INDEX release_initial_build_slot;
CREATE UNIQUE INDEX release_initial_build_slot ON release_build_requests(repository_id,target_tag)
WHERE json_extract(record_json,'$.request.mode')='initial'
  AND json_extract(record_json,'$.status')!='superseded';
CREATE INDEX release_build_restart_history ON release_build_requests(repository_id,target_tag,version);
