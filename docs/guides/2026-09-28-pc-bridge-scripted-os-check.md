---
title: The PC bridge — driving its scripted OS by hand
status: draft
last_verified: 2026-10-01
area: guides
audience: maintainer
author: Galatea maintainers
related:
  - docs/plans/2026-09-28-pc-build-3a-bridge-binding.md
  - docs/plans/2026-09-29-pc-build-3b-computer-people.md
  - docs/plans/2026-09-30-pc-build-3c-plugin-packages.md
  - docs/plans/2026-09-30-pc-build-3d-plugin-servers.md
  - docs/plans/2026-10-01-pc-build-4a-linux-reads.md
  - docs/plans/2026-10-01-pc-build-4b-linux-processes.md
  - docs/specs/2026-09-27-pc-reference-build-design.md
---

# The PC bridge — driving its scripted OS by hand

Until the Linux backend exists (plan 4), the PC bridge runs only through its scripted OS, and the
harness grades only its status (GA-BRIDGE-16, GA-BRIDGE-17). This guide plays the OS by hand, as
plan 5's tests will: a sleep, a resume, a suspend with no warning, a lost observer, a scheduled
shutdown withdrawn; the computer's people (accounts and their tokens, a session and its helper, a
forged helper, locks, notifications, the administrators, a deleted account); a second bridge
refused, a killed bridge started again, a stop, and a state file the bridge refuses; and a plugin
package installed from a local HTTP server, commanded, activated, uninstalled; its server started
in a session, commanded, and swapped to a new version; and an install cut short by a killed
bridge. About 50 minutes, on the developer's machine; nothing is installed system-wide but the
broker's tools and mpv.

## What you need

- A built checkout of this repository: `pnpm install && pnpm -r build` at its root.
- A throwaway broker on port 18830, so that it does not clash with a system one on 1883. Either
  Docker:

```bash
docker run -d --rm --name pcb-check -p 127.0.0.1:18830:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
```

  or Debian's package, left running in its own terminal:

```bash
sudo apt install mosquitto mosquitto-clients
printf 'listener 18830 127.0.0.1\nallow_anonymous true\n' > /tmp/pcb-check.conf
mosquitto -c /tmp/pcb-check.conf -v
```

`mosquitto_pub` and `mosquitto_sub` come with `mosquitto-clients`; install that package for the
Docker route too.

- mpv, for *A plugin's server, commanded and swapped*: `sudo apt install mpv`. The mpv plugin's
  server starts it idle, with no window and nothing loaded, so nothing is shown or played.

## Three terminals

**Watch**, in the first, everything under the check's root:

```bash
mosquitto_sub -h 127.0.0.1 -p 18830 -V mqttv5 -t 'check/#' -v
```

**The bridge**, in the second, from the repository's root. The state directory is kept in
`$STATE` for the last step:

```bash
export STATE=$(mktemp -d)
GALATEA_TEST_TRANSPORT=check/test/desk-pc/control \
GALATEA_BROKER=mqtt://desk-pc@127.0.0.1:18830 \
GALATEA_ROOT=check \
GALATEA_STATE_DIR=$STATE \
GALATEA_TEST_RUN_ID=manual \
node reference/pc-bridge/dist/main.js
```

Expect `ready`. The watch shows, in order: `check/bridges/desk-pc/lwt` empty (`(null)`), `devices`
with one device, `computer`, `devices/computer/status` with `available: true`, then `status` with
`"state":"online"`, `"testRunId":"manual"`, and the `host` transport `up`. A `status` follows every
10 s.

**The owner's and the OS's hands**, in the third. Two helpers: `cmd` sends a command to the
computer as the applier would, `ctl` sends a control message as the harness would:

```bash
cmd() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/bridges/desk-pc/devices/computer/command \
    -m "{\"commandId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"issuedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"resultWithinMs\":5000,\"value\":$1}"
}
ctl() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/test/desk-pc/control -m "$1"
}
```

## A sleep, and the resume

```bash
cmd '{"action":"power.sleep"}'
```

Expect, in this order: `control/received` with `"action":"os.sleep"`; the computer's `ack` with
`"result":"applied"`; `status` with `"state":"offline"` and `"graceful":true`; `lwt` empty. Then
nothing more: no `status` every 10 s, since the bridge is asleep. The ack before the offline is
GA-BRIDGE-22's order.

```bash
ctl '{"requestId":"r1","op":"power","event":"resume","suspendedMs":3600000}'
```

Expect: `control/received` with `"action":"os.step_clock"` first (GA-BRIDGE-59), then `lwt` empty,
`devices`, the computer's status with a new `timestamp`, `status` online without `graceful`, and
`control/reply` `{"requestId":"r1","ok":true}`. The bridge's terminal prints `resumed after 3600000
ms asleep`, and the 10 s statuses come back.

## A suspend the OS did not announce

```bash
ctl '{"requestId":"r2","op":"power","event":"suspend","announced":false}'
```

Expect: no graceful `status`; `lwt` carrying `{"bridgeId":"desk-pc","instanceId":"…"}` at once,
the broker's will, since the connection was cut with no DISCONNECT, as a frozen process leaves it.
Then:

```bash
ctl '{"requestId":"r3","op":"power","event":"resume","suspendedMs":60000}'
```

Expect the same return as above: `os.step_clock`, `lwt` cleared, `devices`, statuses.

## The observer lost

```bash
ctl '{"requestId":"r4","op":"transportState","state":"down"}'
cmd '{"action":"power.cancel"}'
ctl '{"requestId":"r5","op":"transportState","state":"up"}'
```

Expect: a `status` whose `host` transport is `down` within a second of `r4`; the cancel acked
`"result":"failed","reason":"unreachable"` and no `os.cancel` on `received`; a `status` with
`host` `up` after `r5`. The computer stays `observable` for 30 s after its last check-in, as its
roster bound says, so a short loss leaves `state` `online`.

## A scheduled shutdown, withdrawn

```bash
cmd '{"action":"power.shutdown","value":120}'
cmd '{"action":"power.cancel"}'
cmd '{"action":"power.cancel"}'
```

Expect: `os.shutdown` with `"args":{"delayS":120}` and an `applied` ack; then two `os.cancel`s,
each acked `applied`, the second with nothing scheduled (GA-BRIDGE-63). The bridge stays online:
the scripted OS only schedules a delayed shutdown. Rounding the delay up to whole minutes is the
Linux backend's (plan 4).

## What it refuses

```bash
ctl '{"requestId":"r6","op":"join","device":"lamp","capabilities":["onoff"],"feedback":"closed"}'
cmd '{"action":"power.wake"}'
cmd '{"action":"power.sleep","value":1}'
```

Expect: `r6` answered `"ok":false` with `"unsupported":true` (no device joins a PC's host); the wake
acked `"result":"unsupported"` (a PC's bridge offers no wake); the sleep with an argument acked
`"result":"failed","reason":"invalid_request"`, and no `os.sleep` on `received`.

## The computer's people: accounts and tokens

From here the OS has people in it (plan 3b). Two accounts, one whose name makes a token as it is
and one whose name does not:

```bash
ctl '{"requestId":"a1","op":"account","osId":1000,"name":"liza","state":"present"}'
ctl '{"requestId":"a2","op":"account","osId":1001,"name":"John.Doe","state":"present"}'
```

Expect, for each: `devices` again, its `accounts` growing to `{"liza":"liza","u1001":"John.Doe"}`,
`session.lock`'s `args` to `{"account":["liza","u1001"]}`, and `personal` and `selfChanging` listing
`session.liza`, `session.u1001` and the three personal keys; then the computer's status with
`"session.liza":"none"` and `"session.u1001":"none"`, each with its time in `timestamps`. The
computer's `otherAdmins` read `[{"vendor":"os","label":"root"}]`, and since the broker is on this
machine it carries `"proposedInfrastructure":true` (GA-BRIDGE-65). `John.Doe` fails the token rule,
so its token is `u` and its uid, and its name is only the label (GA-BRIDGE-52).

## A session, and its helper

```bash
ctl '{"requestId":"s1","op":"session","id":"2","osId":1000,"seat0Active":true,"state":"active"}'
```

Expect the computer's status with `"session.liza":"unknown"`, and `control/received` with
`"action":"os.helper_start","args":{"session":"2"}`: the bridge started a helper in the new
graphical session, and the session reads `unknown` until that helper reports. Play it:

```bash
ctl '{"requestId":"h1","op":"helper","session":"2","action":"start"}'
ctl '{"requestId":"h2","op":"helper","session":"2","action":"report","values":{"activity":"idle","camera_in_use":true}}'
```

Expect the computer's status with `"session.liza":"idle"` and `"camera_in_use":true`, the camera's
time in `timestamps` the time of the report, the session key's the last observation's.

## A forged helper

Another process of the same session, one the bridge did not start, reports the session active:

```bash
ctl '{"requestId":"f1","op":"helper","session":"2","action":"report","from":"sessionProcess","values":{"activity":"active"}}'
```

Expect `status` with one fault, `{"code":"helper_refused","device":"computer","detail":"session 2: a
report from a connection not bound as its helper"}` (its connection was refused first, and the
entry keeps the latest detail), and no change of the computer's status: `session.liza` stays
`idle` (GA-BRIDGE-61). The fault stays until the bridge restarts: every `status` in the steps
below lists it, up to *A killed bridge starts again*.

## A lock, and one that does not take

```bash
cmd '{"action":"session.lock","value":"liza"}'
```

Expect `control/received` with `"action":"os.lock","args":{"sessions":["2"]}`, the computer's
status with `"session.liza":"locked"` (it may come twice), then the ack `"result":"applied"`: the
key's read-back before the ack (GA-BRIDGE-34). The bridge acks `applied` only when every graphical
session of the account reads locked or disconnected and that key has gone out. Now unlock it, and
have its locker ignore the next lock:

```bash
ctl '{"requestId":"l1","op":"session","id":"2","state":"active"}'
ctl '{"requestId":"l2","op":"lockBehaviour","session":"2","result":"ignores"}'
cmd '{"action":"session.lock","value":"liza"}'
```

Expect the status back to `"session.liza":"idle"`, another `os.lock`, and 5 s later the ack
`"result":"failed","reason":"not_locked"` (GA-BRIDGE-66). Two other outcomes are the unit tests'
(the actions tests, `reference/pc-bridge/test/actions.test.ts`), not this guide's: a lock the OS
reported whose key is still held back at 5 s (the token table not yet saved), and a lock still
waiting when the OS suspends without warning, are both acked
`"result":"failed","reason":"no_confirmation"`.

## An SSH login, and an account it does not know

```bash
ctl '{"requestId":"x1","op":"session","id":"9","osId":1001,"graphical":false,"state":"active"}'
cmd '{"action":"session.lock","value":"u1001"}'
cmd '{"action":"session.lock","value":"olga"}'
```

Expect the status with `"session.u1001":"active"` (an SSH login read from the OS alone, with no
helper), then two acks at once, with no `os.lock`: `"reason":"no_graphical_session"` for `u1001`,
and `"reason":"invalid_request"` for `olga`, which `accounts` does not list.

## A notification, and one nobody can see

```bash
cmd '{"action":"notify.notify","value":{"text":"Ужин готов","urgency":"info","from":{"endpoint":"Дмитрий","role":"guest"}}}'
cmd '{"action":"notify.notify","value":{"text":"Привет","urgency":"warning"}}'
```

Expect, for each, `control/received` with `"action":"os.notify"` in session `2`, its `text`
`"От: Дмитрий (гость)\nУжин готов"`, then `"От: неизвестный отправитель\nПривет"` (the source
first, an unknown sender marked, GA-BRIDGE-56), and an `applied` ack. Lock the session and try again:

```bash
ctl '{"requestId":"n1","op":"session","id":"2","state":"locked"}'
cmd '{"action":"notify.notify","value":{"text":"x","urgency":"info"}}'
```

Expect the status with `"session.liza":"locked"`, no `os.notify`, and the ack
`"result":"failed","reason":"not_shown"` with the detail `no session is unlocked with a helper
running` (GA-BRIDGE-62). `not_shown` means no helper could show the text: every session locked or
disconnected, no helper running, or every helper answering that it failed. A helper that was given
the text but did not answer within 2 s, or was cut off by the bridge going offline (a suspend or a
stop), gives `"reason":"no_confirmation"` instead, as the text may be on the screen and a second
copy must not be invited; the scripted OS's helpers always answer, so that case is the unit tests'
(`reference/pc-bridge/test/actions.test.ts`).

## The administrators change

```bash
ctl '{"requestId":"d1","op":"admins","groups":[{"name":"sudo","gid":27,"members":[1001]}],"polkit":{"identities":["unix-group:sudo"],"unrecognised":false}}'
```

Expect `devices` with `"otherAdmins":[{"vendor":"os","label":"g27"},{"vendor":"os","label":"root"},{"vendor":"os","label":"u1001"}]`
(the sudo group's member by token, polkit's group by `g` and its gid), then `event`
`{"seq":1,…,"type":"other_admins_changed","device":"computer"}` (GA-BRIDGE-53): the event always
follows the `devices` that carry the new set. With `"reported":false` in the same message the OS
would change the facts without telling the bridge, and the change would show at the next daily
re-read.

## An account deleted

```bash
ctl '{"requestId":"e1","op":"account","osId":1000,"state":"deleted"}'
```

Expect `devices` with `"accounts":{"u1001":"John.Doe"}` and `session.lock`'s `account` `["u1001"]`,
and the computer's status without `session.liza`: its token is retired and never given again
(GA-BRIDGE-52). With `"state":"absent"` instead, the account would only lapse from the listing and
keep its token and key. `camera_in_use` and the other personal keys stay in the status, because the
scripted OS keeps session 2 open after its account is gone; a real OS closes it, so this is a limit
of the scripted OS, not of the bridge.

## One bridge per state directory

In the bridge's terminal the state directory is `$STATE`; print it with `echo "$STATE"`. In the
third terminal, start a second bridge on the same directory, the path pasted in place of `<path>`:

```bash
GALATEA_TEST_TRANSPORT=check/test/desk-pc/control \
GALATEA_BROKER=mqtt://desk-pc@127.0.0.1:18830 \
GALATEA_ROOT=check \
GALATEA_STATE_DIR=<path> \
GALATEA_TEST_RUN_ID=manual \
node reference/pc-bridge/dist/main.js; echo "exit $?"
```

Expect `refusing to start: another bridge is running on <path>` and `exit 2`, and nothing new on
the watch: the first bridge keeps answering alone.

## A killed bridge starts again

Kill the first bridge with no chance to clean up, from the third terminal:

```bash
pkill -KILL -f reference/pc-bridge/dist/main.js
```

Expect `lwt` on the watch at once, with the bridge's `instanceId`: the kernel closed the dead
process's connection, and the broker fired the will. Start the bridge again in its own terminal with the same
command as before. Expect `ready` and a fresh `status`: no stale lock outlives the process, as the
kernel frees the lock's name when the process dies. The scripted OS starts empty again, with no
account at all, as a machine whose accounts were all removed while the bridge was down would be:
asked about the tokens it keeps, it answers that `u1001` is gone, so `devices` carries
`"accounts":{}` and `session.lock`'s `account` `[]`, and the computer's status no session key
(GA-BRIDGE-52: a deletion is read afresh at each observation, never remembered). `otherAdmins` is
root alone, and, that set differing from the one kept in the state file, an
`other_admins_changed` event with `"seq":1` follows the first `status`.

## A stop, and a state file it will not trust

Press Ctrl-C in the bridge's terminal. Expect `status` `offline` with `"graceful":true`, then `lwt`
empty, and the process ends. Then spoil its state file and start it again with the same command:

```bash
echo '{' > "$STATE/state.json"
```

Expect the bridge to print `refusing to start: …state.json is not JSON: …` and exit with code 2,
never starting with an empty store (the design's *Error handling*). Remove the file and it starts
again.

## A plugin package, installed and uninstalled

From here the bridge hosts plugin packages (plan 3c): it fetches, checks and unpacks them, and
declares their devices. It starts a version's server once the version is activated and its account
has a graphical session (plan 3d); liza has none in this section, so every plugin device here reads
`available: false`. Leave the bridge running from the last step, with `rm "$STATE/state.json"` done
and the bridge started again, so that it knows no one.

Build the mpv plugin's package, in the third terminal from the repository's root, and note its
`sha256`:

```bash
pnpm --filter @ludentes/galatea-life-plugin-mpv pack:plugin
export SHA=$(cut -d' ' -f1 reference/plugins/mpv/dist/org.galatea.mpv-0.1.0.tar.gz.sha256)
```

Expect one line of JSON with `package`, `sha256` and `bytes`. Serve the package over plain HTTP in
a fourth terminal (the bridge fetches `http:` only under a test run, as `GALATEA_TEST_RUN_ID` makes
this one):

```bash
cd reference/plugins/mpv/dist && python3 -m http.server 18099 --bind 127.0.0.1
```

Back in the third terminal, a helper for the requests, as the applier would send them, and an
account for the plugin with `node` where its `PATH` looks (the scripted OS knows no file until it is
told of one):

```bash
req() { mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t "check/bridges/desk-pc/request/$1" -m "$2"; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
ctl '{"requestId":"a1","op":"account","osId":1000,"name":"liza","state":"present"}'
ctl '{"requestId":"f1","op":"file","path":"/usr/bin/node","executable":true}'
req install "{\"requestId\":\"i1\",\"issuedAt\":\"$(now)\",\"host\":\"computer\",\"account\":\"liza\",\"package\":{\"url\":\"http://127.0.0.1:18099/org.galatea.mpv-0.1.0.tar.gz\",\"sha256\":\"$SHA\"}}"
```

Expect, on the watch: `reply` `{"requestId":"i1","op":"install","status":"accepted"}` at once;
then `devices` with two entries, `computer` and `org.galatea.mpv:0.1.0:player`, the player with
`"host":"computer"`, `"plugin":"org.galatea.mpv"`, `"feedback":"closed"`, `"reachMs":0`,
`"classEvidence":"none"`, `"model":{"vendor":"org.galatea.mpv","model":"player"}` and `otherAdmins`
root and liza; `devices/org.galatea.mpv:0.1.0:player/status` retained with `"available":false`;
`status` with `"levels":["Serve","Host"]` and the player in its roster, `"basis":"poll"`,
`"observable":false`; then, after `devices`, an `other_admins_changed` event for `computer` (the mpv
plugin runs in liza's session, so the computer lists liza too) and `installed` with
`"requestId":"i1"` and the manifest as installed. The HTTP terminal shows one `GET`. The files are
in place, root's only in a real install:

```bash
ls "$STATE/plugins/org.galatea.mpv/0.1.0"
```

Expect `manifest.json  package.json  server.js`. Send the `install` again with `i1` changed to
`i1b`: expect `accepted` and `installed` again, since the same package, account and manifest
repair an install (GA-BRIDGE-68); another package for the same version would end
`install_failed` with `"reason":"version_conflict"`.

A command to the player, and its activation:

```bash
mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t check/bridges/desk-pc/devices/org.galatea.mpv:0.1.0:player/command \
  -m "{\"commandId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"issuedAt\":\"$(now)\",\"resultWithinMs\":5000,\"value\":{\"action\":\"media.pause\"}}"
req activate "{\"requestId\":\"v1\",\"issuedAt\":\"$(now)\",\"plugin\":\"org.galatea.mpv\",\"version\":\"0.1.0\"}"
```

Expect the player's `ack` `"result":"failed","reason":"unreachable"` with `"detail":"org.galatea.mpv
0.1.0 is not activated"`, and `reply` `{"requestId":"v1","op":"activate","status":"ok",
"data":{"plugin":"org.galatea.mpv","version":"0.1.0"}}`. The activation starts nothing: the mpv
plugin `needsSession`, and liza has no graphical session, so the player's status goes out again,
still `available: false`, stamped with the activation. Send the same command again: its `ack` is
`unreachable` with `"detail":"its account has no graphical session"`.

Uninstall it:

```bash
req uninstall "{\"requestId\":\"u1\",\"issuedAt\":\"$(now)\",\"host\":\"computer\",\"plugin\":\"org.galatea.mpv\"}"
```

Expect `reply` `accepted`; `devices` with the computer alone; the player's status cleared
(`(null)`, a retained empty payload, GA-BRIDGE-21); `status` without the player; an
`other_admins_changed` for `computer`, liza no longer listed; then `uninstalled` with
`"plugin":"org.galatea.mpv"`. `ls "$STATE/plugins"` shows nothing (the `.staging` directory is
hidden). An `uninstall` of it again is `failed` with `"reason":"unknown_plugin"`.

## A plugin's server, commanded and swapped

The scripted OS runs a plugin's server for real, as your own user, so the interpreter the package
names must be the `node` you have. Tell the scripted OS where it is, give liza a graphical session
(the helper it starts there is not needed here), and install the package again (the HTTP server
still running):

```bash
export NODE_DIR=$(dirname "$(command -v node)")
ctl "{\"requestId\":\"a2\",\"op\":\"account\",\"osId\":1000,\"name\":\"liza\",\"path\":[\"$NODE_DIR\",\"/usr/bin\",\"/bin\"],\"state\":\"present\"}"
ctl "{\"requestId\":\"f2\",\"op\":\"file\",\"path\":\"$NODE_DIR/node\",\"executable\":true}"
ctl '{"requestId":"s2","op":"session","id":"2","osId":1000,"seat0Active":true,"state":"active"}'
req install "{\"requestId\":\"i3\",\"issuedAt\":\"$(now)\",\"host\":\"computer\",\"account\":\"liza\",\"package\":{\"url\":\"http://127.0.0.1:18099/org.galatea.mpv-0.1.0.tar.gz\",\"sha256\":\"$SHA\"}}"
```

Expect `received` `os.helper_start` for session `2`, then as in the last section: `accepted`, the
player's status `available: false`, `other_admins_changed` for `computer`, `installed`. Activate it:

```bash
req activate "{\"requestId\":\"v3\",\"issuedAt\":\"$(now)\",\"plugin\":\"org.galatea.mpv\",\"version\":\"0.1.0\"}"
```

Expect, within a second or two: on `check/test/desk-pc/control/received`, `"action":"os.server_start"`
with `"plugin":"org.galatea.mpv"`, `"version":"0.1.0"`, `"account":1000`, `"session":"2"`,
`"noNewPrivs":true`, an `env` of `HOME` `/home/liza`, `PATH` liza's, `LANG` `C.UTF-8` and
`GALATEA_PLUGIN_DIR` the version's directory, and nothing else (no display variables: the scripted
OS has none to give), and an `argv` of node's absolute path and the package's `server.js`; `reply`
`ok`; then the player's status `"available":true,"playing":false,"volume":100` (mpv's own volume).
Nothing about the player was published while its server started. The server and its mpv run:

```bash
pgrep -af 'org.galatea.mpv|galatea-mpv'
```

Expect a `node …/org.galatea.mpv/0.1.0/server.js` and an `mpv --idle=yes --force-window=no …`.
A helper for the player's commands, and three of them:

```bash
pcmd() {
  mosquitto_pub -h 127.0.0.1 -p 18830 -V mqttv5 -q 1 -t "check/bridges/desk-pc/devices/$1/command" \
    -m "{\"commandId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"issuedAt\":\"$(now)\",\"resultWithinMs\":5000,\"value\":$2}"
}
pcmd org.galatea.mpv:0.1.0:player '{"action":"media.set_volume","value":30}'
pcmd org.galatea.mpv:0.1.0:player '{"action":"media.pause"}'
pcmd org.galatea.mpv:0.1.0:player '{"action":"media.set_volume","value":300}'
```

Expect, for the first, `ack` `"result":"applied"` with no `detail`, and the status `"volume":30`
right after it (the read the bridge makes at once after a tool), then the same status again 2 s
before its `resultWithinMs` ran out (the read-back, GA-BRIDGE-34, published although nothing
changed). For the second, `"result":"failed","reason":"no_confirmation","detail":"nothing is
loaded"`: the tool's `isError`, since mpv has nothing to pause. For the third,
`"result":"failed","reason":"invalid_request","detail":"volume is above 100"`, answered by the
bridge from the manifest, the tool never called. The status is not published again at each 5 s
read that changed nothing: the roster's `lastCheckIn` in `status` moves instead.

A new version, staged beside the running one: the same package with the manifest's version
`0.1.1`, served next to the first:

```bash
mkdir -p /tmp/mpv-next && tar -xzf reference/plugins/mpv/dist/org.galatea.mpv-0.1.0.tar.gz -C /tmp/mpv-next
sed -i 's/"version": "0.1.0"/"version": "0.1.1"/' /tmp/mpv-next/manifest.json
tar --format=ustar -czf reference/plugins/mpv/dist/org.galatea.mpv-0.1.1.tar.gz -C /tmp/mpv-next manifest.json package.json server.js
export SHA2=$(sha256sum reference/plugins/mpv/dist/org.galatea.mpv-0.1.1.tar.gz | cut -d' ' -f1)
req install "{\"requestId\":\"i4\",\"issuedAt\":\"$(now)\",\"host\":\"computer\",\"account\":\"liza\",\"package\":{\"url\":\"http://127.0.0.1:18099/org.galatea.mpv-0.1.1.tar.gz\",\"sha256\":\"$SHA2\"}}"
```

Expect `accepted`; `devices` with three entries, `org.galatea.mpv:0.1.1:player` with
`"stagedFor":"org.galatea.mpv:0.1.0:player"`; its status `available: false`; `installed`. The
0.1.0 server runs on, and a command to its player is still answered. Activate the new version, as
the applier does when the owner adopts its player in the old one's place:

```bash
req activate "{\"requestId\":\"v4\",\"issuedAt\":\"$(now)\",\"plugin\":\"org.galatea.mpv\",\"version\":\"0.1.1\"}"
```

Expect `os.server_start` for `0.1.1`; `reply` `ok`; then, once the new server has served,
`devices` without 0.1.0's player, 0.1.0's status cleared (`(null)`, once) and the 0.1.1 player's
status `"available":true,"volume":100` (its own mpv), and no `uninstalled`. `ls
"$STATE/plugins/org.galatea.mpv"` shows `0.1.1` alone, and `pgrep` as above shows one server and
one mpv, 0.1.1's. Uninstall it as in the last section (`u3`): expect `uninstalled`, its status
cleared, and `pgrep` finding neither the server nor its mpv. Remove the second package:
`rm -r /tmp/mpv-next reference/plugins/mpv/dist/org.galatea.mpv-0.1.1.tar.gz`.

## An install cut short by a restart

Stop the HTTP server (Ctrl-C in the fourth terminal) and, in its place, a listener that takes the
request and never answers:

```bash
nc -l 127.0.0.1 18099
```

Send `install` again with a new `requestId`, `i2` (the line above with `i1` changed). Expect
`accepted`, and the `GET` printed by `nc`, and nothing more: the fetch waits. Kill the bridge as in
*A killed bridge starts again*, stop `nc` with Ctrl-C, start the HTTP server again, and start the
bridge again. Expect, after its first `status`, one event
`{"seq":1,…,"type":"install_failed","requestId":"i2","reason":"restart","detail":"unknown_account:
liza is no account the computer's accounts lists"}`: the bridge kept the request on disk before it
answered `accepted`, and ends it exactly once after the restart (GA-BRIDGE-68). The scripted OS
starts with no account, so liza's token is retired and the resumed install cannot run as her; on a
real OS the account is still there, the resumed fetch succeeds, and the end is `installed`. Had the
600 s passed while the bridge was down, the end would be `restart` all the same, with
`"detail":"its 600 s passed while the bridge was down"`.

## The Linux backend's reads, as your own account

Plan 4a's Linux backend reads the real OS; its processes (the helper, a plugin's server, plan 4b)
start only as root, so the bridge serves a session on Linux only as its service. What it reads can be checked now, on any
Debian or Ubuntu desktop, as your own account, changing nothing: `linux-read` takes no delay lock,
steps no clock, locks nothing and runs sudo only as root. About 5 minutes.

```bash
cd reference/pc-bridge
node dist/linux-read.js localhost > /tmp/pcb-read.json
```

Its output names your accounts and the machine's id: redact both before you share it. Expect:

- `identity`: the 32 hex digits of `/etc/machine-id` (compare with `cat /etc/machine-id`), and the
  board's vendor and model (`cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name`).
- `sessions`: your desktop session, with `graphical: true` and `seat0Active: true`, and no
  greeter; compare with `loginctl list-sessions` and `loginctl show-session <id> -p Class -p
  LockedHint`. An SSH login in another terminal (`ssh localhost`) adds a session with
  `remote: true`; run `linux-read` again to see it, then log it out.
- `accounts`: each account with a uid from `UID_MIN` to `UID_MAX`
  (`grep -E '^UID_(MIN|MAX)' /etc/login.defs`) and a shell that is not `nologin` or `false`, each
  with its home. Only your own account has a `path`, your login shell's `PATH`
  (`bash -lc 'printenv PATH'`); another account's needs root.
- `admins.facts.groups`: `sudo` (or `wheel`) with your account if you are an administrator;
  `admins.facts.sudo`: every account but root `cannotTell`, and a note saying why (sudo lists
  another account's rules to root only).
- `admins.facts.polkit`: `unrecognised: true` with a note that `/etc/polkit-1/rules.d` cannot be
  read (it is root's), and the identities of the stock rules it recognised: `unix-group:sudo`
  resolved to the `sudo` group on Debian and Ubuntu; on Ubuntu `gnome-initial-setup` too, which
  the table marks as good as root.
- `personalKeys`: `camera_in_use` and `microphone_in_use` where PipeWire is installed; `app` only
  if GDM is set to X11 alone.
- `isOwnAddress`: `own: true` for `localhost`; run it again with your router's address in place of
  `localhost` for `own: false`.

Then the bridge's own start with the Linux backend, against a broker that is not there, with a
credential file of your own (the service's, `/etc/galatea-pc-bridge/credential`, is root's):

```bash
CRED=$(mktemp) && printf 'not-a-real-password\n' > "$CRED" && chmod 600 "$CRED"
GALATEA_BROKER="mqtt://pc-check@127.0.0.1:1" GALATEA_ROOT=galatea-check GALATEA_STATE_DIR="$(mktemp -d)" \
  GALATEA_CREDENTIAL_FILE="$CRED" timeout 4 node dist/main.js
```

Expect it to try the broker again with a growing delay and, at the timeout, `stopped before
ready`. Then `chmod 644 "$CRED"` and run it again: expect `refusing to start: … has mode 0644;
other accounts must not reach it (0600)`, and nothing of the file's content. `rm "$CRED"`.

## The session helper's reads, as your own account

Plan 4b's session helper reads what the service cannot see from outside the session: idleness,
the camera and microphone, the focused window. Its pieces can be checked as your own account,
changing nothing and showing no notification; the helper itself, its launcher and the bus policy
need root and the service, and wait for the VM run. About 5 minutes, after `pnpm -r build`.

```bash
cd reference/pc-bridge
```

The display variables the service would give the helper, as it reads them from your user manager
(it asks as root for another account; here, your own):

```bash
systemctl --user show-environment > /tmp/pcb-env.txt
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { parseShowEnvironment } from "./dist/linux/session-env.js";
console.log(parseShowEnvironment(readFileSync("/tmp/pcb-env.txt", "utf8")));'
```

Expect up to five names: `DISPLAY` and `XAUTHORITY` on X11 or `WAYLAND_DISPLAY` on Wayland, and
`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`; each value as `grep` shows it in the file, except a
value systemctl quoted as `$'…'` (look for one with `grep "=\$'" /tmp/pcb-env.txt`), which comes
unquoted. `rm /tmp/pcb-env.txt`.

The camera and the microphone, from PipeWire's graph:

```bash
node --input-type=module -e '
import { pipeWire } from "./dist/helper/reads.js";
import { run } from "./dist/linux/run.js";
console.log(await pipeWire(run, process.env.XDG_RUNTIME_DIR));'
```

Expect `{ camera_in_use: false, microphone_in_use: false }` with nothing recording. Open a camera
application (Cheese, or a browser's camera test) and run it again: `camera_in_use: true`. Start a
microphone test in a call application, or Sound Recorder: `microphone_in_use: true`. Close them:
both `false` again within a few seconds. The volume panel's level meter alone keeps it `false`.

The focused window, on X11 only (`echo $XDG_SESSION_TYPE` says `x11`):

```bash
sleep 3; node --input-type=module -e '
import { activeApp } from "./dist/helper/reads.js";
import { run } from "./dist/linux/run.js";
console.log(await activeApp(run, { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY }));'
```

Click another window during the three seconds. Expect its class, as `xprop WM_CLASS` gives it as
the second string when you click that window (`Gnome-terminal`, `firefox`). On a locked screen it
is `null`; on Wayland `undefined` (no reading, and the bridge does not declare `app`).

Idleness, read-only (GNOME):

```bash
gdbus call --session --dest org.gnome.Mutter.IdleMonitor --object-path /org/gnome/Mutter/IdleMonitor/Core \
  --method org.gnome.Mutter.IdleMonitor.GetIdletime
```

Expect `(uint64 N,)`, the milliseconds since your last input, small while you type; the helper
reports `idle` from 300000 on.

The helper with no service to talk to, on a bus of its own:

```bash
dbus-daemon --session --fork --print-address=1 --print-pid=1 > /tmp/pcb-bus.txt
DBUS_SYSTEM_BUS_ADDRESS=$(head -1 /tmp/pcb-bus.txt) DBUS_SESSION_BUS_ADDRESS= node dist/helper.js --session 2; echo "exit $?"
node dist/helper.js; echo "exit $?"
kill "$(tail -1 /tmp/pcb-bus.txt)"; rm /tmp/pcb-bus.txt
```

Expect `galatea-pc-helper: the service's endpoint: Could not get owner of name
'org.galatea.PcBridge1': no such name` and exit 1: a helper with no service ends at once. Then,
with no session named, its usage and exit 2.

## Cleaning up

Stop `mosquitto_sub` with Ctrl-C, the HTTP server, then the broker: `docker stop pcb-check`, or
Ctrl-C in its terminal. `rm -rf "$STATE"`.
