#!/bin/sh
# Runs at each start of the broker, then becomes Mosquitto. Its identities are `applier`, every
# line of /config/instances starting `bridge_`, and each watcher the owner lists (`watch`, or
# `watch-<n>` for more than one at a time, since the client id is the user name), each with its
# password from /run/broker-secrets/<id> (written by bin/galatea-prepare); no other build has one,
# so every other name is refused at CONNECT. The access rules, one block per identity and no
# pattern (the install-core design, *The broker's access rules*):
# - the applier reads every bridge's tree but its commands and requests, writes only those, and
#   reads the finder's topics;
# - a bridge writes its own tree but its commands and requests, and reads only those;
# - a watcher reads everything and writes nothing: it cannot publish, take a service's session over
#   (its name is no service's) or leave a will anyone hears.
# The broker's key is copied into the tmpfs for `mosquitto`, whatever the order of its privilege drop.
set -eu

SECRETS=/run/broker-secrets
INSTANCES=/config/instances
KEY=/run/broker-key/broker.key
RUN=/mosquitto/run
ROOT="${GALATEA_ROOT:-galatea}"

fail() { echo "broker-init: $*" >&2; exit 1; }

echo "$ROOT" | grep -Eq '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$' \
  || fail "GALATEA_ROOT is no topic root: letters, digits, _ and -, in parts joined by /"
[ -f "$INSTANCES" ] || fail "no instances file"
listed=$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$INSTANCES" | grep -v '^$' || true)
[ -n "$listed" ] || fail "no instances"

# Check every name, and every identity's password, before writing anything.
names=""
for n in $listed; do
  case "$n" in
    watch | watch-*) echo "$n" | grep -Eq '^watch(-[a-z0-9]{1,16})?$' ||
      fail "bad watcher name: $n (watch, or watch- and up to 16 lower-case letters and digits)" ;;
    *) echo "$n" | grep -Eq '^[a-z][a-z0-9_]{0,62}$' || fail "bad instance name: $n" ;;
  esac
  case "$n" in
    applier | bridge_* | watch | watch-*) names="$names $n" ;;
    *) continue ;;
  esac
  [ -s "$SECRETS/$n" ] || fail "no password in secrets/broker/$n (run bin/galatea-prepare)"
done
[ -n "$names" ] || fail "no broker identity in instances (applier, bridge_*)"
[ -s "$KEY" ] || fail "no key in secrets/tls/broker.key (run bin/galatea-certs)"

umask 077
mkdir -p "$RUN"
# Passwords reach the file through the shell's own printf, never a command line; then hashed in place.
: >"$RUN/passwd"
for n in $names; do
  printf '%s:%s\n' "$n" "$(cat "$SECRETS/$n")" >>"$RUN/passwd"
done
mosquitto_passwd -U "$RUN/passwd"
cp "$KEY" "$RUN/broker.key"

B="$ROOT/bridges"
# The bridge topics below are the applier's BRIDGE_TOPICS (reference/applier's bus) and the bridge
# standard's; broker.test.ts checks this list against the applier's image, so one added there and
# not here fails the test instead of being silently undelivered.
{
  echo "# Written by broker-init.sh at each start of the broker. One block per identity, no pattern."
  for n in $names; do
    echo
    echo "user $n"
    if [ "$n" = applier ]; then
      for t in status lwt devices devices/+/status devices/+/ack reply event; do echo "topic read $B/+/$t"; done
      echo "topic write $B/+/devices/+/command"
      echo "topic write $B/+/request/+"
      echo "topic read $ROOT/finder/#"
    elif [ "$n" = watch ] || [ "${n#watch-}" != "$n" ]; then
      echo "topic read #"
    else
      for t in status lwt devices devices/+/status devices/+/ack reply event; do echo "topic write $B/$n/$t"; done
      echo "topic read $B/$n/devices/+/command"
      echo "topic read $B/$n/request/+"
    fi
  done
} >"$RUN/acl"
chown -R mosquitto:mosquitto "$RUN"
echo "broker-init: ready ($(echo $names | wc -w) identities, root $ROOT)"
exec mosquitto -c /broker/mosquitto.conf
