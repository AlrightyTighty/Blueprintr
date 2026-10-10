-- 005_plans: Terraform plan overlays on top of an analysis run.
-- The raw `terraform show -json` output is NEVER stored: it embeds attribute values, including
-- sensitive ones. We keep only resource addresses, actions and the *names* of changed attributes.

CREATE TYPE plan_action AS ENUM ('create', 'update', 'replace', 'destroy', 'noop');
CREATE TYPE plan_impact AS ENUM ('direct', 'downstream');

CREATE TABLE plan_analyses (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid        NOT NULL REFERENCES projects (id)      ON DELETE CASCADE,
  run_id             uuid        NOT NULL REFERENCES analysis_runs (id) ON DELETE CASCADE,
  created_by         uuid        REFERENCES users (id) ON DELETE SET NULL,
  terraform_version  text,
  summary            jsonb       NOT NULL DEFAULT '{}', -- e.g. {"replace":1,"update":3,"downstream":5}
  ai_explanation     text,                              -- Gemini risk explanation
  briefing_script    text,                              -- text spoken in the voice briefing
  briefing_audio_key text,                              -- S3 key of the cached ElevenLabs audio
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plan_analyses_project_idx ON plan_analyses (project_id, created_at DESC);
CREATE INDEX plan_analyses_run_idx ON plan_analyses (run_id);

CREATE TABLE plan_changes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid        NOT NULL REFERENCES plan_analyses (id) ON DELETE CASCADE,
  node_id            uuid        REFERENCES graph_nodes (id) ON DELETE SET NULL, -- NULL if not in the graph
  address            text        NOT NULL,
  terraform_type     text,
  actions            text[]      NOT NULL DEFAULT '{}', -- raw Terraform actions, e.g. {delete,create}
  action             plan_action NOT NULL,
  impact             plan_impact NOT NULL,
  distance           integer     NOT NULL DEFAULT 0 CHECK (distance >= 0), -- hops from the nearest changed node
  changed_attributes text[]      NOT NULL DEFAULT '{}', -- names only, never values
  UNIQUE (plan_id, address),
  -- Downstream (amber) nodes are not themselves changed; a changed node is always "direct".
  CHECK (impact = 'direct' OR action = 'noop')
);

CREATE INDEX plan_changes_node_idx ON plan_changes (node_id);
