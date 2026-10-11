# Ripplemap database

PostgreSQL schema for Ripplemap, kept as plain numbered `.sql` files. Target: an RDS Postgres
instance (tested on Postgres 16).

## Principles

- **Analysis only.** The database holds the *result* of analyzing a codebase (graph nodes, edges,
  findings), never the code. Code is referenced by file path and line range only.
- **No secrets in the clear.** GitHub tokens are stored as ciphertext (encrypted by the backend,
  e.g. with KMS). Passwords and one-time tokens are stored as hashes. Terraform plan JSON is never
  stored, because it embeds attribute values, including sensitive ones.
- **GitHub only.** Tables are GitHub-specific on purpose. Supporting another host later means a
  migration plus a backend adapter, not a rewrite of the analysis tables.
- **Identity and GitHub are independent.** A user signs up with email + password, or via GitHub,
  and can link GitHub accounts later. Either way an account always has a username, email and
  password.
- **Immutable analyses.** Each analysis run is a snapshot tied to a commit SHA. Old runs are kept,
  so one project can hold analyses of many versions.
- **Authorization lives in the backend** (see the role matrix below). There is no Postgres RLS.

## Files

| File | What it creates |
|---|---|
| `000_init.sql` | `citext` extension, `set_updated_at()` trigger function |
| `001_users_and_github.sql` | `users`, `auth_tokens`, `github_connections`, `repositories` |
| `002_projects_and_sharing.sql` | `projects`, `project_members`, `project_invites`, `project_repositories` |
| `003_resource_types.sql` | `resource_types` catalog, seeded with the supported AWS types |
| `004_analysis_graph.sql` | `analysis_runs`, `graph_nodes`, `graph_edges`, `findings` |
| `005_plans.sql` | `plan_analyses`, `plan_changes` |
| `006_activity_log.sql` | `activity_log` |
| `007_resource_types_sns.sql` | adds the SNS topic to the resource catalog |
| `009_endpoints.sql` | the `calls` edge relation, and catalog rows for REST API resources/methods and Lambda function URLs |
| `migrate.sh` | applies unapplied files in order; tracks them in `schema_migrations` |
| `smoke_test.sql` | assertions over the constraints; runs in a rolled-back transaction |

## Relationships

```
users ──< github_connections                       users ──< auth_tokens
  │             │ (linked_by)
  │             ▼
  ├──< project_members >── projects ──< project_repositories >── repositories
  │                          │  │
  │                          │  └──< project_invites
  │                          │
  │                          ├──< analysis_runs ──< graph_nodes ──< graph_edges
  │                          │         │  ▲                │
  │                          │         │  └─ current_run_id│ (projects → one run)
  │                          │         ├──< findings ──────┘ (node_id, related_node_id)
  │                          │         └──< plan_analyses ──< plan_changes ─ node_id
  │                          └──< plan_analyses
  └──< activity_log >── projects      (both links are SET NULL, rows are kept)

graph_nodes.terraform_type  ··>  resource_types.terraform_type   (name/icon lookup, not a FK)
```

## Tables

### Accounts
- **users**: `username`, `email`, `password_hash` are all `NOT NULL`. Username and email are
  `citext` (case-insensitive) and unique among non-deleted users, so they can be reused after a
  soft delete. `email_verified_at IS NULL` means unverified, which is allowed. When someone signs
  up with GitHub, the backend pre-fills username and email from the profile, asks them to confirm
  and set a password, and only then inserts the row.
- **auth_tokens**: single-use hashed tokens for `email_verify` and `password_reset`.
- **github_connections**: linked GitHub accounts. `user_id` is not unique (a user can link
  several accounts); `github_user_id` is unique (one GitHub account belongs to one user, which is
  also the "Sign in with GitHub" lookup). Tokens are ciphertext. When soft-deleting a user, delete
  their connections too so the GitHub account is freed.
- **repositories**: shared metadata cache, keyed by `github_id` so renames don't create duplicates.

### Projects and sharing
- **projects**: name, description, `visibility` (`private` or `link_view`), and `share_token` for the
  read-only link (`link_view` requires a token). `current_run_id` is the run shown by default.
  `archived_at` hides a project from lists but keeps it viewable and restorable. `deleted_at`
  puts it in the trash until a purge job hard-deletes it, which cascades to everything below it.
- **project_members**: one row per user per project with a `role`. A partial unique index enforces
  exactly one `owner`. To transfer ownership, demote the current owner, then promote the new one,
  in one transaction. `last_opened_at` powers "recent projects".
- **project_invites**: pending invitations by email for `editor` or `viewer`. One pending invite
  per (project, email). Only a token hash is stored.
- **project_repositories**: which repositories feed a project, with `branch` and `root_path`
  (`''` = repo root; use a subfolder for monorepos). A project may link several.

#### Roles

| Action | owner | editor | viewer |
|---|:-:|:-:|:-:|
| View graph, findings, plans | ✓ | ✓ | ✓ |
| Run analysis, link repos, upload plans, dismiss findings | ✓ | ✓ | |
| Rename, change visibility / share link | ✓ | | |
| Invite, change roles, remove members | ✓ | | |
| Transfer ownership, archive, delete, restore | ✓ | | |
| Leave project | | ✓ | ✓ |

Anyone holding a `link_view` share token can view, without an account.

### Resource catalog
**resource_types**: display metadata for resource types, keyed by Terraform-style names (CloudFormation types are mapped onto them, e.g. `AWS::SQS::Queue` becomes `aws_sqs_queue`): `display_name`, `service`,
`category`, `icon_key`, `color`. `icon_key` (e.g. `aws/lambda`) names an SVG shipped with the
frontend. AWS only for now. Add a type with a plain `INSERT` (see below). Nodes whose type is not in
the catalog still work; the frontend falls back to a generic icon.

### Analysis graph
- **analysis_runs**: one analysis of one repo/folder at one `commit_sha` (NULL only for non-git
  input). Re-running the same commit is allowed. `status` moves `pending → running →
  succeeded|failed`.
- **graph_nodes**: `kind` is one of `resource` (Terraform resource, including Route 53 / CloudFront
  domain nodes), `code_file`, `code_function`, `unmanaged_resource` (e.g. a hardcoded bucket not in
  Terraform), `unresolved_ref` (a reference we couldn't resolve, shown as a labeled node).
  `address` is a Terraform address or `path::function`, unique per run.
- **graph_edges**: directed (source depends on target), with a `relation` (what the link means; `calls` is one function calling another), a `link_method` (how we found
  it) and a `confidence`. The database enforces the pairing below, so the UI can trust it:

  | link_method | Example | confidence |
  |---|---|---|
  | `declared_reference` | Lambda references its IAM role in Terraform | `certain` |
  | `env_var` | Terraform sets `TABLE_NAME`, code reads `process.env.TABLE_NAME` | `high` |
  | `code_mapping` | Lambda `source_dir` / Dockerfile context maps a folder to a resource | `high` |
  | `gemini_inference` | Gemini picks the likely resource for an SDK call | `inferred` |

  `evidence` (jsonb) records the proof (env var name, file, line); `explanation` holds Gemini's
  reasoning for inferred edges. Indexes on `(run_id, source_id)` and `(run_id, target_id)` make
  both directions of blast-radius traversal fast, including recursive CTEs.
- **findings**: permission gaps, over-broad IAM, unmanaged resources, unresolved references.
  `fingerprint` is a stable hash of the finding's subject so a dismissal can be carried over to
  later runs. Dismissal is stored on the finding (`dismissed_at`, `dismissed_by`).

### Terraform plans
- **plan_analyses**: a plan overlaid on a run, with Gemini's explanation, the spoken briefing script
  and the S3 key of the cached ElevenLabs audio.
- **plan_changes**: per-resource outcome: raw Terraform `actions`, normalized `action`, `impact`
  (`direct` = red, `downstream` = amber), `distance` in hops, and `changed_attributes` (names only,
  never values). Downstream rows must have `action = 'noop'`.

### Activity log
**activity_log** is an append-only audit trail. Updates are rejected by a trigger; the only change
allowed is Postgres nulling `project_id` / `actor_user_id` when the project or user is purged, so
history survives. Put names and emails in `metadata` as snapshots so entries stay readable. Never
put tokens, passwords or plan values there. The backend should write the log row in the same
transaction as the change it records.

`action` is dot-namespaced text (format enforced by a check), so new events don't need a migration.
Canonical events:

| Area | Actions |
|---|---|
| Project | `project.created`, `project.renamed`, `project.archived`, `project.restored`, `project.deleted`, `project.visibility_changed`, `project.share_link_rotated`, `project.ownership_transferred` |
| Members | `member.added`, `member.role_changed`, `member.removed`, `member.left`, `invite.created`, `invite.accepted`, `invite.revoked` |
| Repos | `repository.linked`, `repository.unlinked` |
| Analysis | `analysis.started`, `analysis.succeeded`, `analysis.failed`, `analysis.deleted`, `analysis.current_changed`, `plan.uploaded`, `plan.deleted`, `finding.dismissed`, `finding.restored` |
| Account (`project_id` NULL) | `github.connected`, `github.disconnected`, `user.signed_in`, `user.password_changed`, `user.deleted` |

Suggested `metadata`: `{"from":"viewer","to":"editor","user":"bob"}` for a role change,
`{"commit_sha":"…","branch":"main"}` for an analysis.

## Conventions

- Primary keys are `uuid` via `gen_random_uuid()`; the activity log uses a `bigint` identity.
- All timestamps are `timestamptz`. Tables with `updated_at` use the `set_updated_at()` trigger.
- Soft deletes use `deleted_at` (users, projects) and `archived_at` (projects). Everything under a
  project is `ON DELETE CASCADE`, which only fires on a hard purge.
- Enums are used for closed sets that code branches on (roles, node kinds, link methods).
  Open-ended sets (activity actions, Terraform types) are text. Add an enum value with
  `ALTER TYPE … ADD VALUE` in a new migration.
- Queries for "live" rows must filter `deleted_at IS NULL` (and usually `archived_at IS NULL`).

## Running migrations

Requires `psql` on the machine running the script.

```bash
DATABASE_URL=postgres://ripplemap_app:PASSWORD@HOST:5432/ripplemap ./migrate.sh
```

Already-applied files are skipped. Each file runs in a single transaction together with its
`schema_migrations` row, so a failed file leaves nothing behind. To check the constraints on a
migrated dev database: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f smoke_test.sql` (prints
`smoke test passed`, rolls everything back).

Quick local database:

```bash
docker run -d --name ripplemap-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres ./migrate.sh
```

### On the shared RDS instance

Give Ripplemap its own database and login so it can't touch your other projects. Run as the
instance's admin user:

```sql
CREATE ROLE ripplemap_app LOGIN PASSWORD '<generate a strong password>';
CREATE DATABASE ripplemap OWNER ripplemap_app;
```

The owner can create the `citext` extension itself (it is a trusted extension on PG13+).

### TLS

The server does not have to enforce TLS for the client to use it. Download the AWS RDS CA bundle
and the tools will verify the server certificate:

```bash
mkdir -p certs && curl -fsSL -o certs/global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

- `migrate.sh` automatically uses `sslmode=verify-full` with `certs/global-bundle.pem` when it exists
  (or whatever you set in `PGSSLMODE`).
- In the backend, bundle the same file and connect with `ssl: { ca, rejectUnauthorized: true }`.

## Adding things

- **Schema change:** add `007_<name>.sql` (next number), never edit an applied file, and run
  `migrate.sh`.
- **Resource type:** a new migration with
  `INSERT INTO resource_types (terraform_type, service, display_name, category, icon_key, color) VALUES (…)`,
  plus the SVG named by `icon_key` in the frontend.
- **Activity event:** just start writing the new dot-namespaced action, and add it to the table above.
