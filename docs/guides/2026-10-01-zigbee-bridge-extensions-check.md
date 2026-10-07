---
title: The Zigbee bridge — extensions, occurrences, settings and admissions by hand
status: draft
last_verified:
area: guides
audience: maintainer
author: Galatea maintainers
related:
  - docs/plans/2026-10-01-zigbee-bridge-1b-extensions.md
  - docs/guides/2026-10-01-zigbee-bridge-scripted-doer-check.md
  - docs/specs/2026-10-01-zigbee-bridge-design.md
---

# The Zigbee bridge — extensions, occurrences, settings and admissions by hand

Plan 1b gave the Zigbee bridge's core what bridge 0.5 added: extensions on any device, occurrences,
undescribed keys, declarations that rest on a setting, and admissions and leaves. This guide plays
them by hand through the scripted doer: a button pusher whose `onoff` waits for its mode, a lamp
that sends a key it does not declare, a bed sensor whose vibration is an event and whose second
extension is misnamed, a lamp that leaves and comes back, and a restart that keeps the pusher's
mode. About 15 minutes on the developer's machine, with Docker. The devices and their names are
made up.

## What you need

The same as for *driving its scripted doer by hand* (the 1a guide): a built checkout, a throwaway
broker on port 18830 and Postgres on 15432, and `mosquitto-clients`.

```bash
pnpm install && pnpm -r build
docker run -d --rm --name zb-check -p 127.0.0.1:18830:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
docker run -d --rm --name zb-check-pg -p 127.0.0.1:15432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine
```

## Three terminals

**Watch**, in the first:

```bash
mosquitto_sub -h 127.0.0.1 -p 18830 -V mqttv5 -t 'check/#' -v
```

**The bridge**, in the second, from the repository's root:

```bash
export DATA=$(mktemp -d)
GALATEA_TEST_TRANSPORT=check/test/zigbee/control \
GALATEA_BROKER=mqtt://zigbee@127.0.0.1:18830 \
GALATEA_ROOT=check \
GALATEA_STATE_DIR=$DATA \
GALATEA_DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres \
node reference/zigbee-bridge/dist/main.js
```

Expect `ready`, then `devices` with an empty list and an `online` `status`.

**The hands**, in the third. `cmd` sends a command as the applier would, `ctl` a control message as
the harness would, and `now` gives the time on the wire's form:

```bash
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
cmd() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/bridges/zigbee/devices/$1/command \
    -m "{\"commandId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"issuedAt\":\"$(now)\",\"resultWithinMs\":10000,\"value\":$2}"
}
ctl() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/test/zigbee/control -m "$1"
}
```

## A pusher whose onoff waits for its mode

The pusher declares one extension, `org.galatea.test.pusher`, with a `state` key `mode` and the
action `set_mode`. Its `onoff` depends on the mode: in click mode a push toggles, so `onoff` is not
idempotent; in switch mode it is. `bySetting` gives the doer both:

```bash
SET_MODE='{"action":"org.galatea.test.pusher.set_mode","idempotent":true,"stateless":false,"confirms":true,"args":{"mode":["click","switch"]},"confirmedBy":{"key":"org.galatea.test.pusher.mode","value":{"arg":"mode"}}}'
onoff() { echo "{\"capabilities\":[\"onoff\"],\"actions\":[{\"action\":\"onoff.turn_on\",\"idempotent\":$1,\"stateless\":false,\"confirms\":true},{\"action\":\"onoff.turn_off\",\"idempotent\":$1,\"stateless\":false,\"confirms\":true},$SET_MODE]}"; }
PUSHER="{\"requestId\":\"p1\",\"op\":\"describe\",\"device\":\"pusher\",\"entry\":{\"capabilities\":[],\"reachMs\":2500,\"actions\":[$SET_MODE],\"extensions\":[{\"capability\":\"org.galatea.test.pusher\",\"keys\":[{\"key\":\"org.galatea.test.pusher.mode\",\"kind\":\"state\",\"schema\":{\"enum\":[\"click\",\"switch\"]}}],\"actions\":[{\"action\":\"org.galatea.test.pusher.set_mode\",\"schema\":{\"enum\":[\"click\",\"switch\"]}}]}]},\"bySetting\":{\"key\":\"org.galatea.test.pusher.mode\",\"entries\":{\"click\":$(onoff false),\"switch\":$(onoff true)}}}"
ctl "$PUSHER"
```

Expect `control/reply` `p1` `ok`, a `joined` event for `pusher` with `seq` 1, and `devices` whose
`pusher` entry has `"capabilities":[]`, only `set_mode` among its actions, the extension, and
`"settings"` nowhere: settings are the doer's word to the core, not the wire's. The bridge's
`status` reads `offline` while the pusher, its only device, has not checked in.

Once that `devices` is out, a command for `onoff` is refused, since the mode was never observed
(GA-BRIDGE-74):

```bash
cmd pusher '{"action":"onoff.turn_on"}'
```

Expect the pusher's `ack` `"result":"unsupported"`, `"detail":"onoff.turn_on is not offered"`.

The pusher reports its mode:

```bash
ctl "{\"requestId\":\"p2\",\"op\":\"setting\",\"device\":\"pusher\",\"key\":\"org.galatea.test.pusher.mode\",\"value\":\"click\",\"observedAt\":\"$(now)\"}"
```

Expect, in this order: `devices` with the pusher's `"capabilities":["onoff"]` and `onoff.turn_on`
`"idempotent":false`; then `devices/pusher/status` with `"org.galatea.test.pusher.mode":"click"`.
The new declarations are on the wire before the value they rest on.

Switch the mode with the extension's own action:

```bash
cmd pusher '{"action":"org.galatea.test.pusher.set_mode","value":"switch"}'
```

Expect `control/received` with `"args":{"mode":"switch"}`; `devices` with `onoff.turn_on`
`"idempotent":true`; the `ack` `"result":"applied"`; and the status with `"switch"`. The ack and the
status may come in either order: the ack is the protocol's word, the status the device's.

## A key no one declared

```bash
ctl '{"requestId":"l1","op":"join","device":"lamp","capabilities":["onoff"],"feedback":"closed"}'
ctl "{\"requestId\":\"l2\",\"op\":\"report\",\"device\":\"lamp\",\"values\":{\"on\":true,\"power\":3.5},\"observedAt\":\"$(now)\"}"
```

Expect `joined` for `lamp`, then `devices/lamp/status` with `"on":true` and no `power`, and a
`status` whose `faults` hold `{"code":"undescribed_keys","device":"lamp","detail":"power"}`
(GA-BRIDGE-76). A name the doer reports without a value joins it:

```bash
ctl '{"requestId":"l3","op":"undescribed","device":"lamp","names":["genBasic.0x4000"]}'
```

Expect the fault's `detail` to read `genBasic.0x4000, power`.

## An occurrence, and a misnamed extension

The bed sensor reports occupancy, and vibration as an `event` key; its second extension, `vibe`,
has no namespace:

```bash
ctl '{"requestId":"b1","op":"describe","device":"bed","entry":{"capabilities":["sensor"],"sensorKeys":["occupancy"],"feedback":"closed","extensions":[{"capability":"org.galatea.test.bed","keys":[{"key":"org.galatea.test.bed.vibration","kind":"event","schema":{"type":"boolean"}}]},{"capability":"vibe","keys":[{"key":"vibe.level","schema":{"type":"number"}}]}]}}'
```

Expect `joined` for `bed`; `devices` whose `bed` entry lists `org.galatea.test.bed` only; a `status`
fault `{"code":"invalid_extension","device":"bed","detail":"vibe: vibe is not a namespace with a
dot"}` (GA-BRIDGE-77); and the bridge's own line `bed: extensions left out: …`.

Send the same frame twice:

```bash
OCCUR="{\"requestId\":\"b2\",\"op\":\"occur\",\"device\":\"bed\",\"key\":\"org.galatea.test.bed.vibration\",\"value\":true,\"frameId\":\"tsn-17\",\"observedAt\":\"$(now)\"}"
ctl "$OCCUR"; ctl "$OCCUR"
```

Expect one `event` `{"seq":…,"type":"occurrence","device":"bed","key":"org.galatea.test.bed.vibration","value":true,"timestamp":…}`
with the time you sent, and no second one: the same frame within 10 s is the same occurrence
(GA-BRIDGE-75). No `devices/bed/status` carries the key.

## A leave, and the ways back

```bash
ctl '{"requestId":"l4","op":"leave","device":"lamp"}'
```

Expect `devices` without `lamp`, `devices/lamp/status` with an empty payload (`(null)`), which
clears the retained status, the `undescribed_keys` fault gone, and a `left` event for `lamp`
(GA-BRIDGE-21).

The lamp comes back by a secured rejoin. It has no entry in `devices`, so this is an admission:

```bash
ctl '{"requestId":"l5","op":"admit","device":"lamp","how":"securedRejoin"}'
```

Expect `joined` for `lamp-2`, an id never used, and `devices` with `lamp-2`. The same again, now
that `lamp-2` is in `devices`, is not new: no `joined`, no change. An association of the same
hardware is new, whatever `devices` holds (GA-BRIDGE-35):

```bash
ctl '{"requestId":"l6","op":"admit","device":"lamp","how":"securedRejoin"}'
ctl '{"requestId":"l7","op":"admit","device":"lamp","how":"association"}'
```

Expect, after `l7` only: `devices` without `lamp-2`, `devices/lamp-2/status` emptied, `joined` for
`lamp-3`, and `devices` with `lamp-3`.

## A restart that keeps the mode

Press Ctrl-C in the bridge's terminal, and look at what the store kept:

```bash
docker exec zb-check-pg psql -U postgres -c "SELECT device_id, hardware_id, admission, present FROM devices ORDER BY device_id" -c "SELECT * FROM settings"
```

Expect `lamp` and `lamp-2` with `present` `f`, `bed`, `lamp-3` and `pusher` with `t`, and one
setting: the pusher's mode, `"switch"`, with the time it was observed. Start the bridge again with
the same command, and have the doer describe the pusher before it reports anything:

```bash
ctl "$PUSHER"
```

Expect `devices` whose `pusher` entry offers `onoff.turn_on` with `"idempotent":true` at once, no
`joined`, and `devices/pusher/status` with `"switch"` at its old time: the declarations rest on the
mode as last observed, kept across the restart (GA-BRIDGE-74).

## What it refuses

```bash
ctl '{"requestId":"w1","op":"windowState","open":true}'
```

Expect `w1` answered `"ok":false`, `"unsupported":true`: join windows come with plan 3.

## Cleaning up

Stop `mosquitto_sub` and the bridge with Ctrl-C, then `docker stop zb-check zb-check-pg` and
`rm -rf "$DATA"`.
