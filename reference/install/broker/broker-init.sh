#!/bin/sh
# Runs at each start of the broker, then becomes Mosquitto. Every line of
# /config/instances is a broker identity, with its password from
# /run/broker-secrets/<id> (written by bin/galatea-db-prepare). The access rules:
# the applier reads and writes everything under GALATEA_ROOT; every other identity
# reads and writes only <root>/bridges/<its id>/#, which holds every topic a bridge uses.
set -eu

SECRETS=/run/broker-secrets
INSTANCES=/config/instances
RUN=/mosquitto/run
ROOT="${GALATEA_ROOT:-galatea}"

fail() { echo "broker-init: $*" >&2; exit 1; }

echo "$ROOT" | grep -Eq '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$' \
  || fail "GALATEA_ROOT is no topic root: letters, digits, _ and -, in parts joined by /"
[ -f "$INSTANCES" ] || fail "no instances file"
names=$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$INSTANCES" | grep -v '^$' || true)
[ -n "$names" ] || fail "no instances"

# Check every name and password before writing anything.
for n in $names; do
  echo "$n" | grep -Eq '^[a-z][a-z0-9_]{0,62}$' || fail "bad instance name: $n"
  [ -s "$SECRETS/$n" ] || fail "no password in secrets/broker/$n (run bin/galatea-db-prepare)"
done

umask 077
mkdir -p "$RUN"
# Passwords reach the file through the shell's own printf, never a command line; then hashed in place.
: >"$RUN/passwd"
for n in $names; do
  printf '%s:%s\n' "$n" "$(cat "$SECRETS/$n")" >>"$RUN/passwd"
done
mosquitto_passwd -U "$RUN/passwd"
{
  echo "# Written by broker-init.sh at each start of the broker."
  echo "user applier"
  echo "topic readwrite $ROOT/#"
  echo
  echo "pattern readwrite $ROOT/bridges/%u/#"
} >"$RUN/acl"
chown -R mosquitto:mosquitto "$RUN"
echo "broker-init: ready ($(echo $names | wc -w) identities, root $ROOT)"
exec mosquitto -c /broker/mosquitto.conf
