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

instance_names() {
  sed -e 's/#.*//' -e 's/[[:space:]]//g' "$1" | grep -v '^$' || true
}
