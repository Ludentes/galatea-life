---
title: The Zigbee bridge — driving its scripted doer by hand
status: draft
last_verified:
area: guides
audience: maintainer
author: Galatea maintainers
related:
  - docs/plans/2026-10-01-zigbee-bridge-1a-binding.md
  - docs/specs/2026-10-01-zigbee-bridge-design.md
---

# The Zigbee bridge — driving its scripted doer by hand

Until the herdsman doer exists (plan 2), the Zigbee bridge runs only through its scripted doer, and
the harness grades three of its ids (GA-BRIDGE-1, 16 and 17). This guide plays the radio by hand: a
lamp joins and reports, a command is confirmed, repeated, and left unanswered and read back, the
coordinator is lost and found, a second bridge is refused, and a stopped bridge starts again with
its check-in kept in Postgres. About 15 minutes on the developer's machine, with Docker.

## What you need

- A built checkout of this repository: `pnpm install && pnpm -r build` at its root.
- A throwaway broker on port 18830 and a throwaway Postgres on 15432, so that they do not clash
  with system ones:

```bash
docker run -d --rm --name zb-check -p 127.0.0.1:18830:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
docker run -d --rm --name zb-check-pg -p 127.0.0.1:15432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine
```

- `mosquitto_pub` and `mosquitto_sub`, from Debian's `mosquitto-clients`. Without them, run each
  as `docker exec zb-check mosquitto_pub …` with the host and port left out.

## Three terminals

**Watch**, in the first, everything under the check's root:

```bash
mosquitto_sub -h 127.0.0.1 -p 18830 -V mqttv5 -t 'check/#' -v
```

**The bridge**, in the second, from the repository's root. The data directory is kept in `$DATA`:

```bash
export DATA=$(mktemp -d)
GALATEA_TEST_TRANSPORT=check/test/zigbee/control \
GALATEA_BROKER=mqtt://zigbee@127.0.0.1:18830 \
GALATEA_ROOT=check \
GALATEA_STATE_DIR=$DATA \
GALATEA_DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres \
node reference/zigbee-bridge/dist/main.js
```

Expect `ready`. The watch shows, in order: `check/bridges/zigbee/lwt` empty (`(null)`), `devices`
with an empty list, then `status` with `"state":"online"`, `"levels":["Serve"]`, and the
`coordinator` transport, `"kind":"zigbee"`, `up`. A `status` follows every 10 s.

**The applier's and the radio's hands**, in the third. `cmd` sends a command to a device as the
applier would, `ctl` a control message as the harness would:

```bash
cmd() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/bridges/zigbee/devices/$1/command \
    -m "{\"commandId\":\"${3:-$(cat /proc/sys/kernel/random/uuid)}\",\"issuedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"resultWithinMs\":10000,\"value\":$2}"
}
ctl() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/test/zigbee/control -m "$1"
}
```

## A lamp joins and reports

```bash
ctl '{"requestId":"r1","op":"join","device":"lamp","capabilities":["onoff","level"],"feedback":"closed"}'
ctl "{\"requestId\":\"r2\",\"op\":\"report\",\"device\":\"lamp\",\"values\":{\"on\":true,\"level\":40,\"power\":3.5},\"observedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}"
```

Expect: `control/reply` `{"requestId":"r1","ok":true}`; an `event` `joined` for `lamp` with
`seq` 1 (from plan 1b); `devices` with one entry, `"id":"lamp"`,
`"transport":"coordinator"`, the actions `onoff.turn_on`, `onoff.turn_off` and `level.set_level`
(its `level` 0 to 100), each `confirms: true`, `"otherAdmins":"unknown"`; and a `status` whose
roster lists `lamp` with `basis` `report` and `basisMaxAgeMs` 60000. After `r2`:
`devices/lamp/status` with `"state":"on"`, `"on":true`, `"level":40`, `"available":true` and the
`timestamp` you sent, the reading's time, not the bridge's (GA-BRIDGE-1). `power` is not there: the
lamp declares no such key, so it is left out and named in the `status`'s fault
`{"code":"undescribed_keys","device":"lamp","detail":"power"}` (GA-BRIDGE-76, from plan 1b).

## A command, confirmed and repeated

```bash
cmd lamp '{"action":"level.set_level","value":70}' 6f1c2a90-0000-4000-8000-000000000001
cmd lamp '{"action":"level.set_level","value":70}' 6f1c2a90-0000-4000-8000-000000000001
```

Expect, for the first: `control/received` `{"device":"lamp","action":"level.set_level","args":{"level":70}}`;
the lamp's status with `"level":70` and `"timestamps":{"on":"…"}`, `on`'s older time; then the
`ack` `"result":"applied"`. For the second: the same `ack` again, byte for byte, and no second
`received` (GA-BRIDGE-4).

## No answer, and the read-back

```bash
ctl '{"requestId":"r3","op":"commandResult","device":"lamp","result":"none"}'
cmd lamp '{"action":"onoff.turn_off"}'
```

Expect: `received` with `onoff.turn_off`; the `ack` `"result":"failed","reason":"no_confirmation"`,
`"detail":"no answer from the device"`; then, 8 s after the command's `issuedAt` (its 10 s, less
1 s for GA-BRIDGE-34, less the 1 s the read takes), the lamp's status again, with a new `timestamp`
and still `"on":true`: the read-back of a device that did not act.

## The coordinator lost and found

```bash
ctl '{"requestId":"r4","op":"transportState","state":"down"}'
cmd lamp '{"action":"onoff.turn_on"}'
ctl '{"requestId":"r5","op":"transportState","state":"up"}'
```

Expect: a `status` whose `coordinator` is `down` with `"retryIntervalMs":10000` at once; the
command acked `"result":"failed","reason":"unreachable"`, `"detail":"the coordinator is not
answering"`, and no `received`; a `status` with the `coordinator` `up` after `r5`.

## What it refuses

```bash
ctl '{"requestId":"r6","op":"power","event":"suspend"}'
```

Expect `r6` answered `"ok":false`, `"unsupported":true`: no Zigbee radio sleeps.

## One bridge per data directory

Print the data directory in the bridge's terminal with `echo "$DATA"`, and start a second bridge on
it in the third, the path pasted in place of `<path>`:

```bash
GALATEA_TEST_TRANSPORT=check/test/zigbee/control \
GALATEA_BROKER=mqtt://zigbee@127.0.0.1:18830 \
GALATEA_ROOT=check \
GALATEA_STATE_DIR=<path> \
GALATEA_DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres \
node reference/zigbee-bridge/dist/main.js; echo "exit $?"
```

Expect `refusing to start: another bridge is running on <path>` and `exit 2`, and nothing new on the
watch.

## A stop, and a start that remembers

Press Ctrl-C in the bridge's terminal. Expect `status` `offline` with `"graceful":true`, then `lwt`
empty. The store kept the lamp:

```bash
docker exec zb-check-pg psql -U postgres -c "SELECT device_id, hardware_id, admission, last_check_in, present FROM devices"
```

Expect one row: `lamp`, `lamp`, admission 1, the read-back's time as `last_check_in`, present `t`.
Start the bridge again with the same command, then have the lamp join again:

```bash
ctl '{"requestId":"r7","op":"join","device":"lamp","capabilities":["onoff","level"],"feedback":"closed"}'
```

Expect `devices` with `lamp` under the same id, and a `status` whose roster gives `lamp` the
`lastCheckIn` from before the stop (GA-BRIDGE-31, GA-BRIDGE-37), `"timestamp":null`, and
`"observable":false` once that check-in is older than its 60 s bound: a report makes it observable
again.

## Cleaning up

Stop `mosquitto_sub` and the bridge with Ctrl-C, then `docker stop zb-check zb-check-pg` and
`rm -rf "$DATA"`.
