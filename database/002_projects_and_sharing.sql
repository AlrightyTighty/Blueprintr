-- 002_projects_and_sharing: projects (analysis only, never code), membership and invites.

CREATE TYPE project_role       AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE project_visibility AS ENUM ('private', 'link_view');

CREATE TABLE projects (
  id             uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text               NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description    text,
  visibility     project_visibility NOT NULL DEFAULT 'private',
  -- Random secret for the read-only public link. Anyone holding it can view, so treat like a password.
  share_token    text               UNIQUE,
  -- Default run to display. FK to analysis_runs is added in 004 (circular dependency).
  current_run_id uuid,
  created_by     uuid               REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz        NOT NULL DEFAULT now(),
  updated_at     timestamptz        NOT NULL DEFAULT now(),
  archived_at    timestamptz,       -- hidden from lists, still viewable/restorable
  deleted_at     timestamptz,       -- trash; a later purge hard-deletes and cascades
  CHECK (visibility <> 'link_view' OR share_token IS NOT NULL)
);

CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_members (
  project_id     uuid         NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id        uuid         NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  role           project_role NOT NULL,
  added_by       uuid         REFERENCES users (id) ON DELETE SET NULL,
  last_opened_at timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Exactly one owner per project (a project is created with its owner in one transaction).
-- To transfer ownership, demote the current owner first, then promote the new one.
CREATE UNIQUE INDEX project_members_one_owner ON project_members (project_id) WHERE role = 'owner';
CREATE INDEX project_members_user_id_idx ON project_members (user_id);

CREATE TABLE project_invites (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid         NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  email       citext       NOT NULL,
  role        project_role NOT NULL CHECK (role <> 'owner'),
  token_hash  text         NOT NULL UNIQUE,
  invited_by  uuid         REFERENCES users (id) ON DELETE SET NULL,
  expires_at  timestamptz  NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- One pending invite per (project, email).
CREATE UNIQUE INDEX project_invites_pending_key ON project_invites (project_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Which repositories (and subfolders) feed a project. A project can link several, e.g. a
-- Terraform repo plus an app repo, or two folders of a monorepo. root_path '' means repo root.
CREATE TABLE project_repositories (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid        NOT NULL REFERENCES projects (id)     ON DELETE CASCADE,
  repository_id           uuid        NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  branch                  text        NOT NULL,
  root_path               text        NOT NULL DEFAULT '',
  -- Connection used to fetch the repo. Viewers never need git access to see analysis.
  linked_by_connection_id uuid        REFERENCES github_connections (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, repository_id, root_path)
);

CREATE INDEX project_repositories_repository_id_idx ON project_repositories (repository_id);
