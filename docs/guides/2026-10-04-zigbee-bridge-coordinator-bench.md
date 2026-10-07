---
title: The Zigbee bridge on the bench — the coordinator side of the herdsman doer
status: draft
last_verified:
area: guides
audience: maintainer
author: Galatea maintainers
related:
  - docs/plans/2026-10-04-zigbee-bridge-2b-the-coordinator.md
  - docs/plans/2026-10-05-zigbee-bridge-2c-the-devices-described.md
  - docs/plans/2026-10-05-zigbee-bridge-2c-2-the-actions.md
  - docs/plans/2026-10-05-zigbee-bridge-2c-3-the-doers-own-exchanges.md
  - docs/plans/2026-10-05-zigbee-bridge-3a-windows-removal-and-the-blocklist.md
  - docs/plans/2026-10-05-zigbee-bridge-3b-the-herdsman-doers-provisioning.md
  - docs/specs/2026-10-01-zigbee-bridge-design.md
  - docs/guides/2026-10-01-zigbee-bridge-scripted-doer-check.md
---

# The Zigbee bridge on the bench — the coordinator side of the herdsman doer

Plan 2b gave the Zigbee bridge its herdsman doer's coordinator side: the network guard, the
controller's life and link, and the join rule. Plan 2c-1 gave it its devices, described from the
converters' definitions and read through their converters. Plan 2c-2 carries their actions out and
reads them back. Plan 2c-3 gives the doer its own exchanges: a definition's `configure`, the answers a
converter sends a device by itself, `zigbee-bridge form` and `zigbee-bridge backup`, and the doer's
own coordinator backup. Plan 3a gives the core join windows, removal and the blocklist, and plan 3b
the herdsman doer's side of them: herdsman's permit-join and Leave Request, and its join handler
under the maintainer's window rule. This guide has two parts.

- **Read-only checks.** They start the bridge on the network the bench already has, and touch
  nothing on it: no join window, no command, no write. The bridge offers actions now, so these
  checks run it with `GALATEA_ZIGBEE_NO_ACTIONS=1`, which withholds every action and every
  read-back in code: its devices are described with their keys and no action, and a command for
  one is never carried out. The switch also withholds every `configure` and every answer a
  converter would send a device by itself. Even so, nothing should publish a command to it: no
  applier, no commander, only the watch. Anyone may run them at any time, in about 20 minutes.
- **For the final destructive suite.** Checks that pull the coordinator's link, admit or remove a
  device, or change the coordinator. The bench is read-only until the whole bridge is done (the
  maintainer's ruling, 2026-10-04); then the maintainer walks these with the suite's other parts.

⛔ Before anything starts herdsman on a real network: nothing else may hold the coordinator (it
takes one TCP client at a time), and the data directory must be a copy made for this run, never
another run's.

## What you need

- The bench box (the box beside the coordinator), with Docker and a built checkout of this
  repository: `pnpm install && pnpm -r build` at its root.
- The coordinator's address, written below as `tcp://<coordinator>:6638`.
- A data directory for this run, `$DATA`, mode 0700, holding herdsman's `database.db` and
  `coordinator_backup.json` from the network's last run, and the owner's `network.json` (below).
- A throwaway broker and Postgres, as in the scripted doer's guide:

```bash
docker run -d --rm --name zb-bench -p 127.0.0.1:18830:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
docker run -d --rm --name zb-bench-pg -p 127.0.0.1:15432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine
```

### The owner's network.json for a network formed before the bridge

`zigbee-bridge form` (plan 2c-3, *Forming a network*, below) writes `network.json` for a network it forms. A network formed
earlier, by herdsman with a configuration of its own, is described by hand, once. This reads that
configuration (`panID`, `extendedPanID`, `channelList`, `networkKey`) and herdsman's database for
the coordinator's address, writes the bridge's file with mode 0600, and prints only the channel and
the coordinator:

```bash
OLD=/path/to/herdsman-network.json DATA=$DATA node -e '
const fs = require("fs"); process.umask(0o077);
const o = JSON.parse(fs.readFileSync(process.env.OLD, "utf8"));
const c = fs.readFileSync(process.env.DATA + "/database.db", "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l)).find((d) => d.type === "Coordinator");
const n = { panID: o.panID, extendedPanID: o.extendedPanID, channel: o.channelList[0], networkKey: o.networkKey, coordinator: c.ieeeAddr };
fs.writeFileSync(process.env.DATA + "/network.json", JSON.stringify(n), { mode: 0o600 });
console.log(n.channel, n.coordinator);'
```

## Watch, and the bridge

**Watch**, in one terminal:

```bash
mosquitto_sub -h 127.0.0.1 -p 18830 -V mqttv5 -t 'bench/#' -v
```

**The bridge**, in another, from the repository's root. `GALATEA_ZIGBEE_DEBUG=1` keeps herdsman's
debug lines (never its frame dumps, which carry the key):

```bash
GALATEA_BROKER=mqtt://zigbee@127.0.0.1:18830 \
GALATEA_ROOT=bench \
GALATEA_STATE_DIR=$DATA \
GALATEA_DATABASE_URL=postgres://postgres@127.0.0.1:15432/postgres \
GALATEA_ZIGBEE_COORDINATOR=tcp://<coordinator>:6638 \
GALATEA_ZIGBEE_DEBUG=1 \
node reference/zigbee-bridge/dist/main.js 2> bridge.log
```

## Read-only checks

Every check in this part starts the bridge as in *Watch, and the bridge* with
`GALATEA_ZIGBEE_NO_ACTIONS=1` added to its environment (any value other than 1 or 0 makes it refuse
to start). The destructive part starts it without the switch.

### The bridge resumes the network and keeps the link

Start the bridge as above, with the switch.

Expect, within about 5 s: `ready` on its output; `bench/bridges/zigbee/status` with the
`coordinator` transport already `up` (the bridge announces itself only once its doer has started,
so the first `status` follows herdsman's start); no fault; `devices` listing every device herdsman's
database has (*The bridge describes the bench's devices*, below). The first `status` can take up to about 118 s on a slow coordinator
(the guard's read, up to 20 s, herdsman's start, up to 90 s, then the first health exchange, up to
8 s); a stop before it exits at once, announcing nothing. A `status` follows every 10 s, the
coordinator `up`. In `bridge.log`: `zh:controller` lines starting the controller, and no line
with `Disable joining`, `permitJoin`, `LEAVE` or `Changing channel`. If `coordinator_backup.json`
in `$DATA` is more than a day old, expect herdsman's `Wrote coordinator backup` within about 40 s
of the first `status`: the doer's own backup (plan 2c-3), which reads the coordinator's NV over its
link and sends nothing to the network; otherwise none until the stop.

Leave it running for 10 minutes. Expect the coordinator `up` throughout.

Stop it with Ctrl-C. Expect exit code 0, a `status` with `"state":"offline"`, a fresh
`coordinator_backup.json` in `$DATA` (herdsman's `Wrote coordinator backup` in `bridge.log`: the
backup reads the coordinator's NV over its link, and sends nothing to the network), and still no
line with `Disable joining` in `bridge.log`: the bridge closes herdsman without a frame.

### The bridge describes the bench's devices

The check above ends by stopping the bridge: start it again as in *Watch, and the bridge*, with the
switch, and wait for its first `status`. Read the retained `bench/bridges/zigbee/devices` and each
device's declaration. Under the switch every device's `actions` is empty and its extension lists
keys and no actions; the actions named below are those the bridge offers without it, for the
destructive part. Expect the button pusher (TS0001, `_TZ3210_a04acm9s`) with the capabilities
`onoff` and `sensor`, the sensor key `battery`, `reachMs` 2500, the setting
`org.galatea.zigbee.ts0001_fingerbot.mode`, its extension's keys (`mode`, `lower`, `upper`,
`delay`, `reverse`, `touch`), each with a description, and its extension's actions `set_mode`
(`click` and `switch` only, not idempotent), `set_lower`, `set_upper`, `set_delay` (each in steps
of 1: the extension's schema says `integer`, and a fraction is refused `invalid_request`),
`set_reverse` and `set_touch`, each `confirms: false` (a Tuya datapoint has no answer), listed in `actions` and
in the extension alike; `onoff.turn_on` and `turn_off` only once the button pusher's mode has been
observed (a mode the store kept counts), `confirms: true`. Expect the vibration sensor (TS0210,
`_TZ3000_fkxmyics`) with the capability `sensor`, the sensor key `battery`, the proposed class
`sensor`, and its extension's keys `voltage`, `sensitivity`, `tamper` and `battery_low` as state,
`vibration` as an event whose only value is `true`; no action, its reach unknown (86400000), so
the core withholds its `set_sensitivity` (GA-BRIDGE-7). Under the switch the bridge polls nothing
and configures nothing (plan 5b): in the `status` roster every device has `basis` `report` and
`cadenceMs` null, and `basisMaxAgeMs` null (the button pusher's `configure` sets no reporting up,
and the radar's configure, kept under its definition's version alone, no longer matches the version
the override table's battery report gives it). Without the switch, *Freshness: polls and configured
reports* below.

Move the vibration sensor. Expect, within a second, an occurrence of
`org.galatea.zigbee.ts0210.vibration` with the value `true`, and the readings `tamper` and
`battery_low` (`false`); 90 s later, no reading and no occurrence of `vibration: false` (the
converter's timer is turned off, and is not the device's). If the sensor reports its sensitivity
(the IAS zone's `currentZoneSensitivityLevel`), expect the reading
`org.galatea.zigbee.ts0210.sensitivity`, and that name not in the entry's `undescribed` list; the key
reads 0 to 200 (the device takes 200, though its set is offered for 0 to 50 only), and a level
outside that gives no reading at all. Any of its
other frames that no converter reads are each announced once by an `undescribed` event and listed in
the `undescribed` list on its entry in `devices`, with no fault (GA-BRIDGE-76, plan 5a).

Leave it running until the button pusher reports: its battery report comes about every 4 hours,
so allow up to 5. Expect `battery` as a reading, and the datapoints the converters do not know (`dp108`,
`dp111` and others) each announced once by an `undescribed` event and listed in its entry's `undescribed`.

Then check `bridge.log`. The bridge sends a device nothing of its own; herdsman answers the
devices' own frames. Each of these prints nothing:

```bash
# Every ZCL frame herdsman sent is an answer to a device's frame.
grep -E "ZCL command|CommandResponse" bridge.log \
  | grep -v -E "\.(defaultRsp|readRsp|enrollRsp|checkinRsp|fastPollStop|queryNextImageResponse)\("
# No bind, no unbind, and nothing that joins, leaves or moves the network.
grep -E "(Bind|Unbind) 0x|Disable joining|permitJoin|LEAVE|Changing channel" bridge.log
```

Lines `zigbee: <device>: refused …` are what a converter tried and the doer refused (for example the
button pusher's `mcuGatewayConnectionStatus` answer, if it asks: under the switch even the answers
the doer lets through are refused): they name a refusal, not a frame. Under the switch there is no
line `zigbee: <device>: configured`, `configure` or `answered`:

```bash
grep -E "zigbee: 0x[0-9a-f]{16}(/[0-9]+)?: (configured|configure |answered)" bridge.log
```

### The guard refuses a network that is not the coordinator's

Copy `network.json` aside, and change the copy in `$DATA` to another channel than the network's:

```bash
cp $DATA/network.json network.json.keep
node -e 'const f=process.argv[1],fs=require("fs"),n=JSON.parse(fs.readFileSync(f));n.channel=n.channel===26?11:n.channel+1;fs.writeFileSync(f,JSON.stringify(n),{mode:0o600})' $DATA/network.json
```

Start the bridge. Expect a `status` with the fault `state_mismatch`, detail "the coordinator's
network is on another channel than network.json: herdsman would move it", and the coordinator
`down`; `bridge.log` shows the guard opening the coordinator's socket and closing it, and no
`zh:controller` start. Wait 30 s: the guard reads again on the backoff (10, then 20 s), and
herdsman is never started. Stop the bridge, and put the file back:

```bash
cp network.json.keep $DATA/network.json && chmod 600 $DATA/network.json
```

Do the same with the `coordinator` field changed (expect "another coordinator answers than the one
the network was formed on") and with `panID` changed by one (expect "the coordinator holds another
network than network.json").

### No network.json, and a data directory others can read

Move `network.json` out of `$DATA` and start the bridge. Expect the fault `no_network`, the
coordinator `down`, and no socket to the coordinator at all. Put the file back: within the backoff
the fault clears and the coordinator comes `up`.

Run `chmod 750 $DATA` and start the bridge. Expect it to refuse to start, exit code 2, naming the
mode. Run `chmod 700 $DATA`.

### The key never reaches the log

With the key's bytes from `network.json`, count every form of the key in `bridge.log`: decimal
lists, hex in either case (in a run, spaced as a Node Buffer prints it, colon-separated, as `0x`
lists, and as two 8-byte halves), and base64 (padded, unpadded, base64url). Any part of a form
counts: the first half of each is looked for too. Expect only zeros:

```bash
node -e '
const fs = require("fs"), k = Buffer.from(JSON.parse(fs.readFileSync(process.argv[1])).networkKey), t = fs.readFileSync(process.argv[2], "utf8").toLowerCase();
const h = [...k].map((b) => b.toString(16).padStart(2, "0"));
const forms = [[...k].join(","), [...k].join(", "), h.join(""), h.join(" "), h.join(":"), h.map((x) => "0x" + x).join(","),
  h.map((x) => "0x" + x).join(", "), h.slice(0, 8).join(""), h.slice(8).join(""), k.toString("base64"), k.toString("base64url"),
  k.toString("base64").slice(0, 11), k.toString("base64url").slice(11)].map((f) => f.toLowerCase());
console.log(forms.map((f) => t.split(f).length - 1));' $DATA/network.json bridge.log
```

### Provisioning withheld under the switch (plan 3b)

With the bridge running under the switch, expect `status` to say `levels: ["Serve"]`: the owner's
switch withholds provisioning, so the herdsman doer opens no window and removes nothing. Send a
`join` (as in *Provisioning requests on the bench*, below): expect the reply `invalid_request` at
once, and still no line with `permitJoin`, `Disable joining` or `LEAVE` in `bridge.log`. The bridge
answers it itself and never calls herdsman. A device that rejoins on its own while this runs (the
TS0210 does after the coordinator was away) is let in with its id: under the switch the join handler
refuses nothing, since a refusal is a Leave Request.

## For the final destructive suite

Walked with the maintainer, once the whole bridge is done. Each needs the bridge running as above,
with the watch open.

### The coordinator's link pulled (spike S3)

Pull the coordinator's network cable (or its power). Expect the coordinator `down` within 30 s
(GA-BRIDGE-23), `retryIntervalMs` 10000, 20000, 40000, then 60000 at each `status` change
(GA-BRIDGE-11), and the bridge still running (GA-BRIDGE-10). Note which comes first in
`bridge.log`: herdsman's `Adapter disconnected` or the doer's "did not answer the health
exchange": that is S3's question. Plug it back. Expect the coordinator `up` within the backoff's
next try, with a new controller started (`bridge.log`), the guard read first.

### A half-open link

On the bench box, drop the coordinator's packets without closing the connection:

```bash
sudo iptables -I OUTPUT -d <coordinator> -p tcp --dport 6638 -j DROP
```

Expect the health exchange to fail within 8 s and the coordinator `down` within 30 s, then the
backoff. Remove the rule (`sudo iptables -D OUTPUT -d <coordinator> -p tcp --dport 6638 -j DROP`).
Expect `up` again.

### A stop while herdsman starts

Start the bridge and stop it with Ctrl-C within its first second. Expect exit code 0 and no
retained `offline` for a bridge never announced. Start it again: expect the network resumed, the
guard's `startup` first.

### A device herdsman still has rejoins while the store is away

Stop Postgres (`docker stop zb-bench-pg`). Expect `store_fault` once the bridge next writes (a
device's check-in, within a minute). Power the Fingerbot off and on
(it rejoins). Expect no `admission_refused`, no `left`, and the Fingerbot still on the network:
herdsman's database has it, so the doer lets it in without asking. Start Postgres again.

### A device herdsman still has rejoins while herdsman starts, the store away

herdsman's join handler is live before its start is done, and the window that matters is a
controller rebuilt while the store is away (the bridge does not start without its store). With the
bridge running and Postgres up, stop Postgres and wait for `store_fault`. Then cut the
coordinator's link (as in *A half-open link*, below) until the coordinator shows `down`, and
restore it. As `bridge.log` shows the guard's read and herdsman starting again, power the
Fingerbot off and on so that it rejoins during that start. Expect no `admission_refused`, and the
Fingerbot still on the network. Start Postgres again.

### A device re-paired without a leave takes a new id (the window rule, 2026-10-05)

Needs the join window (plan 3b). With the store up and the bridge running, factory-reset the
Fingerbot without removing it first, open a join window, and pair it again. If the device announced
a leave at its reset (`bridge.log` shows herdsman's leave, and the watch a `left`), herdsman deleted
it, and `joined` with a new id is herdsman's own admission. Otherwise herdsman still has it, and
raises nothing for it (spike S7): under the window rule the doer reports it itself. Expect, either
way, `joined` with a new id, the Fingerbot in `devices` under it, its old id gone from `devices`, and
`window_closed` listing the new id; without the leave, no `interviewed` (herdsman does not interview
it again) and `bridge.log` without herdsman's `Interview ... started`. Note what herdsman logged for
the join: it is the window rule's evidence too. No lock gets its PIN until the maintainer has seen
*Spike S6's procedure*, below.

### The button pusher's mode, and onoff with it (plan 2c-2)

Set the button pusher's mode to `click` from the watch's commander
(`org.galatea.zigbee.ts0001_fingerbot.set_mode`, value `click`, `resultWithinMs` 10000). Expect the
ack `sent` (a Tuya datapoint has no answer), `bridge.log` showing one `manuSpecificTuya.sendData`
with `"disableRecovery":true` and `"sendPolicy":"immediate"`, then the device's echo: the
description sent again before the reading of the new mode (GA-BRIDGE-74), `onoff.turn_on` and
`turn_off` declared not idempotent. Setting the mode moved the arm on the bench (bench spike 2).
Press it with `onoff.turn_on`: expect the arm to click, the ack `applied` (genOnOff's Default
Response), one `genOnOff.on` in `bridge.log` with `"disableRecovery":true`, and the reading
`on: true`. Set the mode to `switch`: expect `onoff.turn_on` and `turn_off` idempotent again, and
`genOnOff.on` sent with herdsman's recovery on (no `disableRecovery` in the line).

### An action's read-back (plan 2c-2)

In switch mode, send `onoff.turn_off` with `resultWithinMs` 10000. If the device's own report comes
first, expect no read; otherwise a `genOnOff.read` in `bridge.log` at about `issuedAt` + 8 s, and
the reading `on: false` from its answer before the bound (GA-BRIDGE-34). Send
`set_lower` (value 60): expect no read at all (a Tuya datapoint has no get; its echo is the reading).

### A command whose time runs out is never carried out later (plan 2c-2)

Send `onoff.turn_on` to the button pusher with `resultWithinMs` 300, while it sleeps (let it idle
for a minute first). Expect the ack `failed(expired)` with nothing sent, or `failed(no_confirmation)`
once herdsman had the frame, never `applied` late; watch the arm for a minute: it moves at most
once, within the command's time or not at all. `bridge.log` shows the call's `timeout` as the time
left (under 300).

### A device's refusal (plan 2c-2)

Send the button pusher a command its converter maps to a frame the device refuses, if one is found
(bench spike 2 found none: the device answered SUCCESS even to `offWithEffect`, which it ignores).
Expect `failed(refused)` with the ZCL status's name as `detail`, and never herdsman's text: no
payload, no `ZCL command` line, in the ack.

### A lock's PIN is not handed to the lock (plan 2c-2; needs a Zigbee lock, which the bench has not)

With a lock that requires a PIN for remote operation, write its PIN in `$DATA/pins.json` (mode
0600, `{"<the lock's device id>": "<PIN>"}`) and start the bridge. Expect no `unlock` offered (only
`lock.lock`), and a `pin_missing` fault naming the lock, whose detail says a PIN is configured but
no lock is handed its PIN until spike S6 tells a new association from a rejoin. Send `lock.unlock`:
expect `unsupported`, no `closuresDoorLock` line in `bridge.log`, the lock still locked, and the PIN
in no published message and no log line. Make `pins.json` readable by the group (`chmod 640`):
expect the bridge to refuse to start, naming the file and not the PIN. Put the PIN where the device
id goes (`{"<PIN>": "<the lock's device id>"}`, mode 0600): expect the bridge to refuse to start,
saying the file names a lock by something that is no device id, and quoting neither.

### The vibration sensor's sensitivity (plan 2c-2)

Needs a reach for the sensor: it listens only for a second or two after an event, and until a reach
of 145 s or less is known the core offers no `set_sensitivity` (GA-BRIDGE-7). Until then: send it,
and expect `unsupported`. With a reach: move it, and within a second write its sensitivity. Expect
the read-back to confirm the new value, or the command to fail `no_confirmation` when the sensor
slept first.

### configure, binding and reporting (plan 2c-3)

A definition's `configure` binds clusters to the coordinator and sets reporting up on the device:
it writes. The button pusher's binds genOnOff and reads genBasic (the Tuya magic packet); the
vibration sensor's definition has none. Start the bridge without the switch, on a copy of `$DATA`
whose `database.db` has no `"configured"` in the button pusher's line (a network the bridge has not
configured yet). Expect nothing configured at the start (the button pusher is an end device, asleep
but for moments). Press the button pusher's own button, or wait for its battery report. Expect in
`bridge.log`, right after its message: herdsman's `Bind <button pusher>/1 genOnOff from
'<coordinator>/1'`, a `ZCL command <button pusher>/1 genBasic.read(` line with `"disableRecovery":true` and
`"timeout":5000` (sent once, waited for 5 s, so that it holds the device's place in herdsman's queue
no longer), then
`zigbee: <button pusher>: configured (TS0001_fingerbot, version 0.0.0)`; its
`devices` entry with `basisMaxAgeMs` still null (it binds and sets no reporting up), and the button
pusher's line in `$DATA/database.db` with `"configured":"0.0.0"` in its `meta`. Restart the bridge,
and press the button again: expect no second `configured`. If the button pusher sleeps through the
bind, expect `configure (TS0001_fingerbot) failed: …; tried again at its next message`, and the next
try no sooner than 10 minutes later; after three failed tries, `given up after 3 tries, until the
bridge restarts or the device is interviewed again`, and no fourth. The bench has no device that sets reporting up: with one, expect
its `basisMaxAgeMs` to be twice the longest maximum interval its `configure` set (herdsman's
`configuredReportings` in `database.db`), from the `devices` published right after `configured`.
With a device whose `configure` writes or sends a command, expect `configure (<model>) needs a call
the doer does not send; not tried again, and no bound`, and its bound null.

### A converter's answers to a device (plan 2c-3)

Without the switch, power the button pusher off and on (take its battery out for 10 s). A Tuya
device asks whether its gateway is connected as it comes back. Expect in `bridge.log`
`zigbee: <button pusher>/1: answered manuSpecificTuya.mcuGatewayConnectionStatus: a Tuya device asks
whether its gateway is connected`, herdsman's `mcuGatewayConnectionStatus` line with
`"disableRecovery":true` and `"timeout":3000`, and the device keeps working (a press from its own button still
reports `on`). It asks for the time too only with the `time_start` option, which the bridge does not
set: expect no `mcuSyncTime` answer, and no `refused` line for it. With the switch, expect the
answer `refused` instead, and the device still working. A Legrand device's security read, a time
read answered in a device's own form, and a Tuya query after an announce are answered too; the bench
has none of those devices. A converter's timer (an interval query, a daily time write) stays
refused: expect its `refused` line, with "the exchange it answers has ended" or the guard's own
reason.

### Forming a network (plan 2c-3)

⛔ This replaces the bench's network: both devices must be paired again (plan 3's join window).
Only with the maintainer, as the suite's last step or on a spare coordinator.

`form` reads the coordinator first, as the bridge's network guard does (read-only), and refuses
while it holds a network unless it is given `--replace-network`. With that flag it forms over the
coordinator's network: every device paired to it is lost to it and must be paired again, and no
file the bridge keeps brings that network back.

Give it a data directory that does not exist first:

```bash
GALATEA_STATE_DIR=$DATA-typo GALATEA_ZIGBEE_COORDINATOR=tcp://<coordinator>:6638 \
  node reference/zigbee-bridge/dist/cli.js form --channel 25
```

Expect exit code 2, `refusing to form: <directory> does not exist`, no directory made, and no
socket to the coordinator.

With the bridge stopped, move `$DATA`'s `network.json`, `coordinator_backup.json` and `database.db`
aside. Keep them only as a record: after the form the bridge will not restore from them (its guard
refuses, `state_mismatch`), and the devices must be paired again. Run, from the repository's root:

```bash
GALATEA_STATE_DIR=$DATA GALATEA_ZIGBEE_COORDINATOR=tcp://<coordinator>:6638 \
  node reference/zigbee-bridge/dist/cli.js form --channel 25
```

Expect exit code 2, `refusing to form: the coordinator holds a network on channel <the bench's
channel>: forming replaces it, and every device paired to it must be paired again`, and no
`zh:controller` start: the coordinator still holds the bench's network (put the three files back
and the bridge resumes it). Then, the maintainer agreeing, run it with the flag:

```bash
GALATEA_STATE_DIR=$DATA GALATEA_ZIGBEE_COORDINATOR=tcp://<coordinator>:6638 \
  node reference/zigbee-bridge/dist/cli.js form --channel 25 --replace-network
```

Expect exit code 0, a line `replacing the network the coordinator holds on channel <the bench's
channel>`, one line naming the new channel, the PAN id and the coordinator's IEEE address, and no
key; `$DATA/network.json` with mode 0600, and herdsman's `coordinator_backup.json` and
`database.db` beside it. Run the key check of *The key never reaches the log* over the command's
output. Run it again: expect it to refuse (exit code 2), `network.json is there already`, and the
file unchanged. Start the bridge: expect the network resumed on the new channel. While it runs, run
`form` in a data directory of its own on the same coordinator: expect it to refuse, the coordinator
not read (it takes one TCP client, the bridge's), never to take it from the bridge (and with the
bridge's own `$DATA`, to refuse, the bridge running).

### Backing the data directory up (plan 2c-3)

While the bridge runs, run:

```bash
GALATEA_STATE_DIR=$DATA node reference/zigbee-bridge/dist/cli.js backup --out ~/zigbee-kept.json
```

Expect exit code 2, "another bridge is running on $DATA: stop the bridge first", and no file. Stop
the bridge (its stop writes the coordinator's backup) and run it again. Expect exit code 0, the files
it took (`network.json`, `coordinator_backup.json`, `database.db`, and `pins.json` if there is one),
when the coordinator's backup was written (the stop's time), `~/zigbee-kept.json` with mode 0600,
and `jq '.files | keys' ~/zigbee-kept.json` listing those files. Run it again: expect it to refuse to
write over the file. The file holds the network key and the PINs in clear: keep it as the owner keeps
`network.json`.

### The doer's own coordinator backup (plan 2c-3)

With the bridge stopped, make the backup a day and an hour old:

```bash
touch -d '-25 hours' $DATA/coordinator_backup.json
```

Start the bridge. Expect, within about 40 s of the first `status`, herdsman's `Wrote coordinator
backup` and the file's time now; the coordinator `up` throughout (the backup's NV reads interleave
with the health exchange); no `Disable joining` or `permitJoin`. Note how long the backup took
(herdsman's debug lines `Creating coordinator backup` to `Wrote coordinator backup`): `BACKUP_MS` is
30 s, three times the bench's 9.3 s. Leave the bridge running for an hour: expect no second backup.
Stop it within a minute of a backup under way (make the file old again and restart, then stop it at
`Creating coordinator backup`): expect one `Wrote coordinator backup`, not two, then the exit.

### A new admission of known hardware while the store is away (the maintainer's ruling)

Needs plan 3's join window. The order matters: the old id must still be in the store when the
store goes away. Stop Postgres first, and wait for `store_fault`. Then remove a device (it leaves,
and `left` names its id, but the removal cannot be written: the store would still give the
hardware its old id at the next start). Open a join window and pair the device again. Expect
herdsman to refuse it (the device is sent a Leave Request), the fault `admission_refused` naming
its hardware and its old id, and no `joined`. Start Postgres, wait for `store_fault` to clear, open
a window, and pair it again: expect `joined` with a new id, and `admission_refused` cleared. (With
the store up when the device leaves, the removal is written and the new admission is simply
unknown hardware: no refusal.)

### Provisioning requests on the bench (plans 3a and 3b)

Plan 3a gave the core its join windows, removal and blocklist over the scripted doer; plan 3b gives
the herdsman doer `permitJoin` and `removeFromNetwork`. With 3b the bridge's `status` says
`levels: ["Serve", "Provision"]`, except under `GALATEA_ZIGBEE_NO_ACTIONS`, where it stays
`["Serve"]` and answers `join`, `join_close`, `remove` and `unblock` `invalid_request` (*Provisioning
withheld under the switch*, a read-only check). Every check below starts the bridge without the
switch. herdsman's debug lines are needed for them (`GALATEA_ZIGBEE_DEBUG=1`, as in *Watch, and the bridge*); the
doer's own lines start `herdsman: ` (a Leave Request sent, a device that did not answer one, a
record dropped without a frame). A request is published to `bench/bridges/zigbee/request/<op>`
with a fresh `requestId` and `issuedAt`, and its reply read on `bench/bridges/zigbee/reply`, for
example:

```bash
mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -t bench/bridges/zigbee/request/join \
  -m '{"requestId":"j1","issuedAt":"'"$(date -u +%FT%TZ)"'","transport":"coordinator","windowMs":60000}'
```

### A join window opened and closed

Send `join` with `windowMs` 60000: expect the reply `accepted`, herdsman's debug line for a permit
sent to the broadcast address, and nothing joining. Wait a minute: expect `window_closed` with
`devices: []` and `windowMs: 60000`, and herdsman's permit off. Send `join` with `windowMs` 300000:
expect `window_closed` after 254 s with `windowMs: 254000`. Send `join`, and a second `join` while
it is open: expect the second answered `failed(busy)` and the first window untouched. Send
`join_close` and `join` at once: expect herdsman's permit off, then on again, in that order. Send
`join` again and `join_close` at once: expect the reply `ok`, `window_closed` at once, and a second `join_close` answered `ok` with no
event.

### A join window near a router

Pick a router the bench has (`router: true` in its description; the Fingerbot and the TS0210 are end
devices, so this needs a mains-powered device). Send `join` with `near` its device id: expect herdsman
to send the permit to that router alone. A `near` that names an end device is answered
`invalid_request`, and one that names nothing `failed(unknown_device)`.

herdsman sends Green Power's commissioning mode with every permit, and to a router it awaits the
router's answer for 10 s: a router without Green Power may never answer, and herdsman's permit then
rejects though the Zigbee permit went out (plan 3b's reading of herdsman 10.10.0's source). Record
which: `window_closed` within about 10 s of `accepted`, with `bridge.log`'s `join: the window did not
open`, means it rejects at that router (and the core closed the window at once, a `permitJoin` of
0); a window that lasts its time means the router answered. With a router of each kind, try both.

### The close the bridge owes the coordinator

Start the bridge without `GALATEA_ZIGBEE_NO_ACTIONS`: expect herdsman's debug line for a permit of 0
sent to the broadcast address once the network resumed, and no other permit. Send `join` with
`windowMs` 200000, then kill the bridge's process (no stop) and start it again within the window:
expect that permit of 0 at the new start, and nothing joining afterwards. Send `join` with `windowMs`
200000, cut the coordinator's link (unplug it from the network) and send `join_close`: expect
`window_closed` at once and no permit sent; restore the link: expect one permit of 0 once the next
controller is up, within the 200 s. Repeat with `windowMs` 60000 and the link restored after the
minute: expect no permit then.

### An admission in a window

Open a window, reset the TS0210 to factory and pair it: expect `joined` with a new id, the device in
`devices`, `interviewed` once herdsman's interview ends, and `window_closed` listing it. Its old id is
gone (`left` was published when herdsman deleted it, or is published now).

### remove, with and without force

With the Fingerbot awake, send `remove` with its device id and `blockRejoin: false`: expect
`accepted`, herdsman's Leave Request, then `left` naming the id and the device gone from `devices`.
Pair it again in a window. Then take its battery out and send `remove` without `force`: expect
`accepted` and no `left` while it is away; put the battery back, and expect `left` once it answers.
Pair it again, take the battery out, and send `remove` with `force: true`: expect `left` at once,
`bridge.log`'s `dropped from herdsman's database, without a frame` and no Leave Request, and the
device still believing it is on the network: it comes back as new hardware (`joined`, new id), in a
window or not, unless blocked (herdsman marked it deleted, and a secured rejoin needs no permit).

Spike S7 found from the sources that herdsman gives up on a Leave Request after its wait for the
answer (on Z-Stack about 16 s), keeping the device, and the doer then tries again at the device's
next message. While the battery is out, expect `bridge.log`'s `did not answer its Leave Request ...
tried again at its next message` once, and no second try until the device speaks. Two things only
the bench shows, to record: how long the awake Fingerbot takes to answer a Leave Request (the time
from `accepted` to `left`), and whether a Leave herdsman gave up on still reaches a sleeping device
from its parent's queue once it wakes (then herdsman's own leave, `Device leave` in its debug lines,
ends the removal before the doer's next try). A device that refuses its removal (none on the bench
does) would leave the removal pending under the fault `remove_refused`.

### A blocked device's rejoin

Send `remove` with `blockRejoin: true`: expect its hardware id in `status.blocked` before the reply.
Open a window and pair it again: expect `blocked_rejoin` naming the identifier, no `joined`, and
herdsman sending it a Leave Request (the join handler refuses it). Restart the bridge: expect
`blocked` to still list it. Send `unblock`: expect `ok`, the list empty, and the device admitted at
the next window with a new id. Then take the Fingerbot's battery out, send `remove` with
`blockRejoin: true` and no `force`, and restart the bridge before it answers: expect the removal
started again at the start, and `left` once the battery is back.

### A window closed before a stop

Open a window of 200 s and stop the bridge (SIGTERM) within it: expect, after the UNSUBACK and
before the graceful `offline`, `window_closed` and herdsman's permit turned off (`Disable joining`
in its debug lines) before the stop's backup (`Wrote coordinator backup`) and the controller's close.
A stop with no window open sends no `Disable joining`.

### Spike S6's procedure: the window rule's check

S6 answered from the sources that no frame tells an association from a rejoin, and the maintainer
ruled the window rule (2026-10-05): an indication for hardware herdsman has is a new admission
while the doer's window is open, and a rejoin outside it. The PIN hold (`withholdsPins`) stays
until these are seen. Run them in order, with no window open unless said:

1. Power-cycle a router, or move an end device out of its parent's reach until it rejoins elsewhere:
   expect the join handler called with its hardware, the same id kept, and no `joined`.
2. Reset the TS0210 to factory and make it join with no window open: expect nothing (no indication,
   no admission). An indication here means the firmware takes an association or a well-known-key
   rejoin outside a window; record it, and the PIN hold stays.
3. Open a window and make the TS0210 join again (as a lock-like device would be swapped): under the
   window rule, expect a new id. With (2) showing nothing and the window rule taken, no joiner keeps
   an id it did not have, and the PIN hold may be lifted.

4. Open a window and power-cycle the router of step 1 within it: expect a new id, `joined`, and the
   adopted device's id gone. This is the departure from the standard's "a secured rejoin sends no
   `joined`, even while a window is open", which only herdsman shows; the scripted doer has no
   such case.

The answer is one of: *the window rule holds* (1 kept, 2 nothing, 3 new, 4 new), *the firmware
admits outside a window* (2 indicated), or *a rejoin loses its id* (1 new); until it is run,
*could not find out*.

### Freshness: polls and configured reports (plan 5b)

⛔ **Needs the maintainer's go.** Without the switch the bridge writes to the bench's devices: the
radar's and the vibration sensor's battery report is a ZCL Configure Reporting, stored in the
device, and the button pusher's `configure` binds genOnOff. A poll is only a read, but the bridge
polls only without the switch, which also offers every action. Nothing else may publish a command.

Plan 5b gives every device a bound the bridge can stand behind (the design, *Freshness*). Start the
bridge without the switch, on a copy of `$DATA`, with the watch open, and the freshness watch beside
it, from `reference/zigbee-bridge` (it reads the bridge's `status` and `devices`, and sends nothing):

```bash
GALATEA_BROKER=mqtt://127.0.0.1:18830 GALATEA_ROOT=bench WATCH_OUT=$HOME/freshness-$(date +%F).jsonl WATCH_HOURS=12 \
  node bench/freshness-watch.mjs > $HOME/freshness-$(date +%F).summary.json
```

Its output names devices by the bridge's ids and models; keep it with the owner's records, never in
this repository.

1. **The button pusher is polled.** Expect its roster entry with `basis` `poll`, `cadenceMs` 300000
   and `basisMaxAgeMs` 900000; within about 10 s of the first `status`, a `ZCL command <button
   pusher>/1 genBasic.read(` line in `bridge.log` with `"disableRecovery":true` and `"timeout":5000`,
   then its `lastCheckIn` moving and `observable` true. Every 5 minutes after, unless the device spoke
   in between, another read. Take its battery out: `observable` false within 900 s plus a status
   interval, and one line `zigbee: <button pusher>: its poll was not answered: …`; put it back: `its
   poll is answered again`, `observable` true.
   - *It never answers the read* (the line stays, `observable` stays false): the Tuya firmware does not
     answer genBasic. Record it in the passport; the override table takes `poll: false` for
     the model, with the date, and its bound is null, the owner's to set.
   - *It answers, slower than 2.5 s* (the time from the read to the answer in herdsman's debug lines):
     record the time; the override's `reachMs` takes it, with its date.
2. **The vibration sensor's battery report is configured at its next message.** Move it. Expect, right
   after its occurrence, `ZCL command <sensor>/1 genPowerCfg.configReport(` with
   `"minRepIntval":3600,"maxRepIntval":3600`, `"disableRecovery":true` and `"timeout":5000`, then
   `zigbee: <sensor>: configured (TS0210, version 0.0.0+galatea.<8 hex>)`, and its roster entry with
   `basisMaxAgeMs` 7200000.
   - *`configure (TS0210) failed: …; tried again at its next message`*: it slept before the frame
     reached it (its awake window is 1–2 s). Move it again after 10 minutes; after three failures the
     bridge gives up until it restarts. Record which.
   - *The device answered UNSUPPORTED_ATTRIBUTE or another status*: it refuses reporting on that
     attribute; its bound stays null, and the passport says so.
3. **The radar is configured again for its battery report**, at its next message (it reports often):
   the same lines, `ZG-204ZV`, its own configure's frames first (the Tuya magic read), then
   `genPowerCfg.configReport`; `basisMaxAgeMs` 7200000.
4. **Overnight: is the report honoured, and what does each model send on its own?** Leave the bridge
   and the freshness watch running for 12 hours, nothing happening in the room. Read the summary: for
   each device its `checkIns`, `longestGapS`, `medianGapS`, `unobservableS` and `withinBound`.
   - *The vibration sensor and the radar: `longestGapS` at most 3600 plus a status interval, and
     `withinBound` true*: the report is honoured. Record the date in each passport.
   - *A device that accepted the report but whose gaps run past 7200 s* (`withinBound` false, its
     `unobservableS` growing): the firmware ignores what it accepted. The override table takes
     `reportsIgnored` with the date and what was seen, and the model's bound is null again (bridge 0.6,
     *The roster and freshness*).
   - *The radar's light every `illuminance_interval` minutes, steadily, with nothing happening*: its
     rhythm on its own. The override table may take `rhythm` (`everyMs`, the date, what was seen); with
     its report honoured it changes nothing, since a configured report wins.
   - *The button pusher: `longestGapS` at most 310*, `unobservableS` 0: polled as declared.
5. **A restart keeps it.** Restart the bridge: expect no second `configured` line for either sensor
   (herdsman keeps `meta.configured` and the reports it recorded), their bounds declared at once, and
   the button pusher read within 10 s of the first `status`.

What the run decides, for the maintainer: whether the hourly battery report stays the route for the
two sleeping sensors, or each falls back to the owner's `fresh_s` (`reportsIgnored`); whether the
button pusher's poll stays; and the dates and figures that go into the override table and the
passports. Every answer is written down the same day, with the Zigbee freshness items.
