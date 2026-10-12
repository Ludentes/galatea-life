#!/bin/sh
# Creates the role and the same-named schema of every instance listed in
# /config/instances, and the read-only `reader` role. Runs on every `up`.
# It never drops anything, so running it again is always safe.
set -eu

SECRETS=/run/db-secrets
INSTANCES=/config/instances
export PGHOST="${PGHOST:-postgres}" PGUSER=postgres PGDATABASE=galatea
PGPASSWORD="$(cat "$SECRETS/postgres")"
export PGPASSWORD

fail() { echo "db-init: $*" >&2; exit 1; }

[ -f "$INSTANCES" ] || fail "no instances file"
# One name per line; `#` starts a comment.
# A watcher (`watch`, `watch-<n>`) is the broker's alone: no role, no schema.
names=$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$INSTANCES" | grep -v '^$' | grep -Ev '^watch(-.*)?$' || true)

# Check every name before changing anything.
for n in $names; do
  case "$n" in
    postgres | reader | public | information_schema | pg_*) fail "$n is reserved" ;;
  esac
  echo "$n" | grep -Eq '^[a-z][a-z0-9_]{0,62}$' || fail "bad instance name: $n"
  [ -s "$SECRETS/$n" ] || fail "no password in $SECRETS/$n"
done

# Passwords reach psql through \set and a file, never a command line.
{
  printf '%s\n' "SET client_min_messages = warning;"
  printf '%s\n' "SELECT 'CREATE ROLE reader NOLOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reader') \\gexec"
  if [ -s "$SECRETS/reader" ]; then
    printf '%s\n' "\\set pw \`cat $SECRETS/reader\`"
    printf '%s\n' "SELECT format('ALTER ROLE reader LOGIN PASSWORD %L', :'pw') \\gexec"
  fi
  printf '%s\n' "REVOKE ALL ON DATABASE galatea FROM PUBLIC;"
  printf '%s\n' "REVOKE ALL ON SCHEMA public FROM PUBLIC;"
  printf '%s\n' "GRANT CONNECT ON DATABASE galatea TO reader;"
  for n in $names; do
    printf '%s\n' "SELECT 'CREATE ROLE $n LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$n') \\gexec"
    printf '%s\n' "\\set pw \`cat $SECRETS/$n\`"
    printf '%s\n' "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', '$n', :'pw') \\gexec"
    printf '%s\n' "GRANT CONNECT ON DATABASE galatea TO $n;"
    printf '%s\n' "CREATE SCHEMA IF NOT EXISTS $n AUTHORIZATION $n;"
  done
} | psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f -

echo "db-init: ready ($(echo $names | wc -w) instances)"
