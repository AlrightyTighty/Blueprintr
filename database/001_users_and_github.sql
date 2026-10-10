-- 001_users_and_github: accounts, one-time auth tokens, linked GitHub accounts, repo metadata.

-- Every user has a username, email and password. Signing up with GitHub pre-fills
-- username/email from the profile, but the account is only created once all three exist.
-- An unverified email is allowed (email_verified_at IS NULL).
CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username          citext      NOT NULL CHECK (username::text ~ '^[A-Za-z0-9_-]{3,39}$'),
  email             citext      NOT NULL CHECK (length(email) <= 254 AND position('@' IN email) > 1),
  email_verified_at timestamptz,
  password_hash     text        NOT NULL CHECK (length(password_hash) > 0), -- argon2id/bcrypt, hashed in the backend
  display_name      text,
  avatar_url        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz                                             -- soft delete
);

-- Partial so a username/email can be reused after the account is soft-deleted.
CREATE UNIQUE INDEX users_username_key ON users (username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_key    ON users (email)    WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE auth_token_purpose AS ENUM ('email_verify', 'password_reset');

-- Single-use, expiring tokens. Only a hash is stored; the raw token goes in the email link.
CREATE TABLE auth_tokens (
  id         uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid               NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    auth_token_purpose NOT NULL,
  token_hash text               NOT NULL UNIQUE,
  expires_at timestamptz        NOT NULL,
  used_at    timestamptz,
  created_at timestamptz        NOT NULL DEFAULT now()
);

CREATE INDEX auth_tokens_user_id_idx ON auth_tokens (user_id, purpose);

-- A user may link several GitHub accounts (user_id is not unique), but a GitHub account
-- belongs to exactly one user (github_user_id is unique). That unique column is also the
-- "Sign in with GitHub" lookup. Tokens are ciphertext only; encryption (KMS) is done in the
-- backend. Rows should be deleted when a user is soft-deleted so the GitHub account is freed.
CREATE TABLE github_connections (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  github_user_id           bigint      NOT NULL UNIQUE,
  github_login             text        NOT NULL,
  access_token_ciphertext  bytea       NOT NULL,
  refresh_token_ciphertext bytea,
  scopes                   text[]      NOT NULL DEFAULT '{}',
  token_expires_at         timestamptz,
  installation_id          bigint,     -- reserved for a future GitHub App install
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_connections_user_id_idx ON github_connections (user_id);

CREATE TRIGGER github_connections_set_updated_at BEFORE UPDATE ON github_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Shared metadata cache for GitHub repositories. Never holds code.
CREATE TABLE repositories (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id      bigint      NOT NULL UNIQUE,
  full_name      text        NOT NULL, -- "owner/name"; refreshed on rename
  default_branch text        NOT NULL DEFAULT 'main',
  html_url       text        NOT NULL,
  is_private     boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX repositories_full_name_idx ON repositories (full_name);

CREATE TRIGGER repositories_set_updated_at BEFORE UPDATE ON repositories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
