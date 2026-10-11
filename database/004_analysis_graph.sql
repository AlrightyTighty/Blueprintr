-- 004_analysis_graph: one analysis run = one immutable snapshot of the graph, pinned to a commit.

CREATE TYPE run_status       AS ENUM ('pending', 'running', 'succeeded', 'failed');
CREATE TYPE node_kind        AS ENUM ('resource', 'code_file', 'code_function', 'unmanaged_resource', 'unresolved_ref');
CREATE TYPE edge_relation    AS ENUM (
  'references', 'depends_on', 'assumes_role', 'grants_access', 'runs_code',
  'reads', 'writes', 'publishes', 'invokes', 'routes_to'
);
-- The four ways code gets linked to infrastructure (see CLAUDE.md).
CREATE TYPE link_method      AS ENUM ('declared_reference', 'env_var', 'code_mapping', 'gemini_inference');
CREATE TYPE confidence_level AS ENUM ('certain', 'high', 'inferred');
CREATE TYPE finding_kind     AS ENUM ('permission_gap', 'over_broad_iam', 'unmanaged_resource', 'unresolved_reference');
CREATE TYPE finding_severity AS ENUM ('info', 'low', 'medium', 'high', 'critical');

-- Re-running the same commit is allowed (e.g. after a parser upgrade), so commit_sha is not unique.
-- commit_sha is NULL only for runs that did not come from git (e.g. an uploaded folder).
CREATE TABLE analysis_runs (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  repository_id  uuid        REFERENCES repositories (id) ON DELETE SET NULL,
  root_path      text        NOT NULL DEFAULT '',
  commit_sha     text        CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  branch         text,
  status         run_status  NOT NULL DEFAULT 'pending',
  error          text,
  parser_version text        NOT NULL,
  stats          jsonb       NOT NULL DEFAULT '{}',
  started_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);

CREATE INDEX analysis_runs_project_commit_idx ON analysis_runs (project_id, repository_id, commit_sha);
CREATE INDEX analysis_runs_project_created_idx ON analysis_runs (project_id, created_at DESC);

ALTER TABLE projects
  ADD CONSTRAINT projects_current_run_id_fkey
  FOREIGN KEY (current_run_id) REFERENCES analysis_runs (id) ON DELETE SET NULL;

CREATE TABLE graph_nodes (
  id             uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid      NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE,
  kind           node_kind NOT NULL,
  -- Terraform address ("aws_dynamodb_table.orders") or code location ("src/api.py::get_order").
  address        text      NOT NULL,
  name           text      NOT NULL,
  -- Joined to resource_types for name/icon. Deliberately not a FK: Terraform types outside
  -- the supported catalog still become nodes (with a generic icon).
  terraform_type text,
  parent_node_id uuid      REFERENCES graph_nodes (id) ON DELETE SET NULL, -- function -> file
  file_path      text,     -- pointers only; no file contents are stored
  line_start     integer,
  line_end       integer,
  attributes     jsonb     NOT NULL DEFAULT '{}', -- non-secret config only
  UNIQUE (run_id, address)
);

CREATE INDEX graph_nodes_run_kind_idx ON graph_nodes (run_id, kind);
CREATE INDEX graph_nodes_terraform_type_idx ON graph_nodes (terraform_type);

CREATE TABLE graph_edges (
  id          uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid             NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE,
  source_id   uuid             NOT NULL REFERENCES graph_nodes (id)   ON DELETE CASCADE,
  target_id   uuid             NOT NULL REFERENCES graph_nodes (id)   ON DELETE CASCADE,
  relation    edge_relation    NOT NULL,
  link_method link_method      NOT NULL,
  confidence  confidence_level NOT NULL,
  evidence    jsonb            NOT NULL DEFAULT '{}', -- e.g. {"env_var":"TABLE_NAME","file":"src/api.py","line":12}
  explanation text,                                    -- Gemini's reasoning for inferred links
  CHECK (source_id <> target_id),
  -- Confidence is determined by the linking method.
  CHECK (confidence = CASE link_method
    WHEN 'declared_reference' THEN 'certain'::confidence_level
    WHEN 'gemini_inference'   THEN 'inferred'::confidence_level
    ELSE 'high'::confidence_level
  END),
  UNIQUE (run_id, source_id, target_id, relation, link_method)
);

-- Both traversal directions (code -> resource, resource -> code) and recursive graph queries.
CREATE INDEX graph_edges_source_idx ON graph_edges (run_id, source_id);
CREATE INDEX graph_edges_target_idx ON graph_edges (run_id, target_id);

CREATE TABLE findings (
  id              uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid             NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE,
  kind            finding_kind     NOT NULL,
  severity        finding_severity NOT NULL,
  title           text             NOT NULL,
  detail          text,
  node_id         uuid             REFERENCES graph_nodes (id) ON DELETE CASCADE,
  related_node_id uuid             REFERENCES graph_nodes (id) ON DELETE CASCADE,
  evidence        jsonb            NOT NULL DEFAULT '{}',
  -- Stable hash of (kind, subject address, key detail) so a dismissal can carry over to later runs.
  fingerprint     text             NOT NULL,
  dismissed_at    timestamptz,
  dismissed_by    uuid             REFERENCES users (id) ON DELETE SET NULL,
  UNIQUE (run_id, fingerprint)
);

CREATE INDEX findings_run_kind_idx ON findings (run_id, kind);
