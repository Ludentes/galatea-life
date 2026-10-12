# Shared by the owner's scripts. Finds the installation's directory, its
# compose file and its settings file, and reads the settings as shell
# variables (not exported: Compose reads the same file itself).
here=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
export COMPOSE_FILE="${COMPOSE_FILE:-$here/compose.yaml}"
env_file="${COMPOSE_ENV_FILES:-$here/.env}"
env_file="${env_file%%,*}"
if [ -f "$env_file" ]; then
  # shellcheck disable=SC1090
  . "$env_file"
fi

# The settings 4a named, read by nothing since the install-core plan: refused, so that an old .env
# never leaves the scripts writing fresh secrets beside the real ones.
for old in GALATEA_DB_SECRETS GALATEA_BROKER_SECRETS; do
  if [ -n "${!old:-}" ] || printenv "$old" >/dev/null; then
    echo "$(basename "$0"): $old is no longer read: set GALATEA_SECRETS to the directory holding db/ and broker/ (and GALATEA_TLS, GALATEA_SECRETS_BACKUPS), then remove $old from $env_file" >&2
    exit 1
  fi
done

die() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

# A path from the settings, relative to the installation's directory.
resolve() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$here/${1#./}" ;;
  esac
}

# `docker compose up -d`, and when it fails, the end of the log of each service that exited
# non-zero: a migrate's own reason, where Compose says only that it "didn't complete successfully".
compose_up() {
  local rc=0 svc code state
  docker compose up -d "$@" || rc=$?
  [ "$rc" -eq 0 ] && return 0
  docker compose ps -a --format '{{.Service}} {{.ExitCode}} {{.State}}' 2>/dev/null |
    while read -r svc code state; do
      [ "$state" = exited ] && [ "$code" != 0 ] || continue
      echo "$(basename "$0"): $svc exited $code; the end of its log:" >&2
      docker compose logs --no-log-prefix --tail 20 "$svc" >&2 || true
    done
  return "$rc"
}

instance_names() {
  sed -e 's/#.*//' -e 's/[[:space:]]//g' "$1" | grep -v '^$' || true
}
