#!/usr/bin/env bash
# Runs a command with VOICE_FRONT_TEST_DATABASE_URL naming a Postgres server
# the tests may create databases on. Given one already, it runs the command as
# is. Otherwise it starts a throwaway postgres:18-alpine on this host's
# loopback, and removes it when the command ends.
#   tools/with-postgres.sh uv run pytest -q
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: tools/with-postgres.sh <command> [args...]" >&2; exit 2; }
if [ -n "${VOICE_FRONT_TEST_DATABASE_URL:-}" ]; then exec "$@"; fi

POSTGRES_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export POSTGRES_PASSWORD
name="voice-front-test-$$"
# The password goes by name, never on the command line.
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD -p 127.0.0.1::5432 postgres:18-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
# The image's first start runs a server on its socket only, then restarts it:
# ready on TCP means the real one.
for _ in $(seq 1 150); do
  docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 0.2
done
docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres
port=$(docker port "$name" 5432/tcp | head -n 1)
port=${port##*:}
export VOICE_FRONT_TEST_DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:$port/postgres"
unset POSTGRES_PASSWORD
"$@"
