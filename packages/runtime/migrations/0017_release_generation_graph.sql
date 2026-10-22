CREATE TABLE release_generation_graphs (
  repository_id INTEGER NOT NULL,
  target_tag TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  policy_sha TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  root_node TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  max_runs INTEGER NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  run_calls INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  mutation_nonce TEXT,
  ticket_digest TEXT,
  ticket_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repository_id,target_tag,graph_digest)
);
CREATE TABLE release_generation_nodes (
  repository_id INTEGER NOT NULL,
  target_tag TEXT NOT NULL,
  graph_digest TEXT NOT NULL,
  node_id TEXT NOT NULL,
  input_digest TEXT,
  children_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  reservation TEXT,
  reserved_ticket TEXT,
  output_digest TEXT,
  diagnostic_digest TEXT,
  PRIMARY KEY(repository_id,target_tag,graph_digest,node_id)
);
