#!/usr/bin/env bash
# Creates a PostgreSQL database and user for each service with a relational database:
# role <s>_service (LOGIN, no administrative privileges) owns database <s>_db.
# The role password comes from variable <S>_DB_PASSWORD (e.g. AUTH_DB_PASSWORD).
# Also creates auth_shadow_db (owner auth_service): the shadow database for local
# "prisma migrate dev" in Auth Service, so the role does not need CREATEDB.
#
# Runs automatically on the first container start (empty volume), from
# /docker-entrypoint-initdb.d. Can be run again, e.g. after changing passwords in deploy/.env:
#   docker compose -f deploy/compose.yaml exec -T postgres bash /docker-entrypoint-initdb.d/01-service-databases.sh
# The script is idempotent: existing roles only get their password set, existing databases are left alone.
#
# The file must have the executable bit (chmod 755). Without it the image entrypoint would
# source it into its own shell instead of running it as a separate process.
#
# Passwords never reach the logs: psql reads them from the environment itself (\getenv), so they
# are not in process arguments or in statement text; the server does not log failed statements.
set -euo pipefail

SERVICES="auth user product inventory order shipping"

# Check all passwords first so the database is never left half-configured.
for s in $SERVICES; do
  var="$(printf '%s' "$s" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
  if [ -z "${!var:-}" ]; then
    echo "01-service-databases.sh: missing or empty variable $var (password for role ${s}_service)" >&2
    exit 1
  fi
done

{
  cat <<'SQL'
SET log_min_error_statement = panic;
SET log_statement = 'none';
\set VERBOSITY terse
SQL

  for s in $SERVICES; do
    var="$(printf '%s' "$s" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD"
    cat <<SQL
\getenv password $var
\set role ${s}_service
\set db ${s}_db
SELECT format(
  CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = :'role')
    THEN 'ALTER ROLE %I LOGIN PASSWORD %L'
    ELSE 'CREATE ROLE %I LOGIN PASSWORD %L'
  END, :'role', :'password') \gexec
\unset password
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db') \gexec
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
  done

  cat <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', 'auth_shadow_db', 'auth_service')
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'auth_shadow_db') \gexec
REVOKE ALL ON DATABASE auth_shadow_db FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
} | psql -X -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres

echo "01-service-databases.sh: done ($SERVICES)"
