#!/bin/sh
# The store's backups: a dump of `galatea`, checked by restoring it.
#   backup.sh once    one dump and its check; exits 1 when the check fails
#   backup.sh loop    a dump every day at GALATEA_BACKUP_AT, and one at start
#                     when none is younger than 25 h
#   backup.sh health  the healthcheck: the last check passed, within 25 h
set -eu
# Dumps hold the home's state, transcripts included: readable by the owner only.
umask 077

B=/backups
KEEP="${GALATEA_BACKUP_KEEP:-14}"
AT="${GALATEA_BACKUP_AT:-03:30}"
MAX_AGE=90000 # 25 h
export PGHOST="${PGHOST:-postgres}" PGUSER=postgres

password() {
  PGPASSWORD="$(cat /run/db-secrets/postgres)"
  export PGPASSWORD
}

check_keep() {
  case "$KEEP" in
    '' | *[!0-9]* | 0) echo "backup: GALATEA_BACKUP_KEEP must be a positive integer, not '$KEEP'" >&2; return 1 ;;
  esac
}

check_at() {
  echo "$AT" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$' ||
    { echo "backup: GALATEA_BACKUP_AT must be HH:MM, not '$AT'" >&2; return 1; }
}

# The schemas a build owns: everything but Postgres's own and `public`.
schemas_in() {
  psql -X -At -d "$1" -c "SELECT nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\_%' AND nspname NOT IN ('information_schema', 'public')
    ORDER BY 1"
}

# The same list, read from the dump's own table of contents.
schemas_of() {
  pg_restore -l "$1" | awk '$4 == "SCHEMA" && $6 != "public" { print $6 }' | sort
}

# Restores $1 into a throwaway database and prints why it is unusable, or nothing.
check() {
  db="galatea_check_$$"
  reason=""
  dropdb --if-exists "$db"
  createdb "$db"
  if ! pg_restore --exit-on-error -d "$db" "$1" 2>"$B/.restore-errors"; then
    reason="restore failed: $(head -c 300 "$B/.restore-errors" | tr '\n' ' ')"
  fi
  rm -f "$B/.restore-errors"
  if [ -z "$reason" ] && [ "$(schemas_in "$db")" != "$(schemas_of "$1")" ]; then
    reason="the restored schemas differ from the dump's"
  fi
  if [ -z "$reason" ]; then
    for s in $(schemas_in "$db"); do
      if [ "$(psql -X -At -d "$db" -c "SELECT to_regclass('$s.migrations') IS NOT NULL")" = t ] &&
         [ "$(psql -X -At -d "$db" -c "SELECT count(*) FROM $s.migrations")" = 0 ]; then
        reason="$s.migrations is empty"
        break
      fi
    done
  fi
  dropdb --if-exists "$db"
  printf '%s' "$reason"
}

# Keeps the newest KEEP dumps, but never the newest good one: failed checks
# alone can't prune away the last dump that restored.
prune() {
  good=$(grep -lx ok "$B"/galatea-*.dump.check 2>/dev/null | sort | tail -n 1)
  good="${good%.check}"
  n=$(ls -1 "$B"/galatea-*.dump 2>/dev/null | wc -l)
  if [ "$n" -gt "$KEEP" ]; then
    ls -1 "$B"/galatea-*.dump | sort | head -n $((n - KEEP)) | while read -r old; do
      [ "$old" = "$good" ] && continue
      rm -f "$old" "$old.check"
    done
  fi
}

once() {
  check_keep || return 1
  [ -w "$B" ] || {
    echo "backup: cannot write $B; create it as uid $(id -u) (bin/galatea-db-prepare does)" >&2
    return 1
  }
  password
  f="$B/galatea-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump -Fc -d galatea -f "$f.partial"
  mv "$f.partial" "$f"
  reason=$(check "$f")
  now=$(date +%s)
  if [ -z "$reason" ]; then
    echo ok >"$f.check"
    printf 'ok %s %s\n' "$now" "$(basename "$f")" >"$B/status.new"
  else
    echo "failed: $reason" >"$f.check"
    printf 'failed %s %s %s\n' "$now" "$(basename "$f")" "$reason" >"$B/status.new"
  fi
  mv "$B/status.new" "$B/status"
  prune
  [ -z "$reason" ] || { echo "backup: $(basename "$f"): $reason" >&2; return 1; }
  echo "backup: $(basename "$f"): ok"
}

# Each backup runs as a process of its own: `once || true` in this shell would
# switch off `set -e` inside it, and a failed pg_dump would go unnoticed.
loop() {
  check_keep && check_at || exit 1
  last=$(ls -1 "$B"/galatea-*.dump 2>/dev/null | sort | tail -n 1)
  if [ -z "$last" ] || [ $(($(date +%s) - $(stat -c %Y "$last"))) -gt "$MAX_AGE" ]; then
    sh "$0" once || true
  fi
  while :; do
    now=$(date +%s)
    next=$(date -d "$AT" +%s)
    [ "$next" -gt "$now" ] || next=$((next + 86400))
    sleep $((next - now))
    sh "$0" once || true
  done
}

health() {
  [ -f "$B/status" ] || exit 1
  read -r state at _ <"$B/status"
  [ "$state" = ok ] && [ $(($(date +%s) - at)) -le "$MAX_AGE" ]
}

case "${1:-}" in
  once) once ;;
  loop) loop ;;
  health) health ;;
  *) echo "usage: backup.sh once|loop|health" >&2; exit 2 ;;
esac
