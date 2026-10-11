#!/usr/bin/env bash
# Applies any NNN_*.sql files not yet recorded in schema_migrations, in filename order.
# Each file runs in its own transaction together with its bookkeeping row.
#
#   DATABASE_URL=postgres://user:pass@host:5432/dbname ./migrate.sh
#
# TLS: if certs/global-bundle.pem exists (see README) the connection uses sslmode=verify-full
# against it, unless PGSSLMODE is already set.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL, e.g. postgres://user:pass@host:5432/dbname}"

dir="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "${PGSSLMODE:-}" && -f "$dir/certs/global-bundle.pem" ]]; then
  export PGSSLMODE=verify-full
  export PGSSLROOTCERT="$dir/certs/global-bundle.pem"
fi

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

psql_run() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

psql_run -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)"

applied=0
for file in "$dir"/[0-9][0-9][0-9]_*.sql; do
  name="$(basename "$file")"
  done_already="$(psql_run -tA -c "SELECT 1 FROM schema_migrations WHERE filename = '$name'")"
  if [[ -n "$done_already" ]]; then
    continue
  fi
  echo "applying $name"
  # -1 wraps all -f/-c items in a single transaction.
  psql_run -1 -f "$file" -c "INSERT INTO schema_migrations (filename) VALUES ('$name')"
  applied=$((applied + 1))
done

echo "done: $applied migration(s) applied"
