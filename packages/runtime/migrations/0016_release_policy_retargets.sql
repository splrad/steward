CREATE TABLE release_policy_retargets (
 repository_id INTEGER NOT NULL, target_tag TEXT NOT NULL, revision INTEGER NOT NULL,
 ordinal INTEGER NOT NULL, policy_sha TEXT NOT NULL, nonce TEXT NOT NULL,
 PRIMARY KEY(repository_id,target_tag,revision,ordinal),
 UNIQUE(repository_id,target_tag,revision,policy_sha)
);
