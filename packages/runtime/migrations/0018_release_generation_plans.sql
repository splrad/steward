CREATE TABLE release_generation_plans (
 repository_id INTEGER NOT NULL,
 target_tag TEXT NOT NULL,
 source_digest TEXT NOT NULL,
 policy_sha TEXT NOT NULL,
 graph_digest TEXT NOT NULL,
 PRIMARY KEY(repository_id,target_tag,source_digest,policy_sha)
);
