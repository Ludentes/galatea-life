---
title: The reference applier
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
---

# The reference applier

A TypeScript build of the Galatea applier standard ([`standard/applier.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/applier.md), 0.15), graded by the
conformance harness on the ids in `graded-ids.json`. The design is
`docs/specs/2026-09-28-reference-applier-design.md`. This page says what the build does now; how it
got here, slice by slice, is under *History* below.

## Not built: the PC ids

`describe` claims `Act` and `Safe` at 0.15, but twelve Act MUSTs are neither built nor graded. They
are the PC work's, done separately and at a lower priority:

| Id | What is missing |
|---|---|
| GA-DESC-10 | `wake_via`: a computer's wake through another device, and its checks |
| GA-DESC-11 | A replacement that changes a plugin action's tool hash, argument schema or `requested_tier` dropping the owner's lower tier |
| GA-DESC-15 | An owner's `idempotent: true` on a plugin action falling back on a new tool hash |
| GA-DESC-16 | `personal` and `self_changing` kept across a plugin's replacements |
| GA-DESC-17 | `session.lock`'s `account` argument limited to the computer's accounts |
| GA-APPLY-12 | `power.wake` dispatched to the `wake_via` device |
| GA-APPLY-13 | `power.wake` acked on the computer's return |
| GA-EVT-7 | `media.launch` acked only on a new `started_at` with `playing` |
| GA-ADOPT-4 | `activate { plugin, version }` sent to the plugin's bridge |
| GA-ADOPT-5 | A staged plugin device's adoption pending until the swap |
| GA-PROV-4 | A plugin's devices leaving the model when it is uninstalled |
| GA-BUS-15 | No `route_conflict` for a device `stagedFor` a plugin device |

(The adapter ids GA-STATE-3 and GA-DESC-12 are not this build's: it is no adapter. The meta-applier's
ids are not claimed.)

**What a PC owner sees today.** The applier still adopts a `computer` and a plugin's devices (the PC
bridge is a stopgap channel for notices), and their actions run through the rules every device's do:

- `power.wake` goes to the computer itself, so a sleeping computer gives `skip(dead)`; nothing wakes it.
- `media.launch` is stateless, so it ends `delivered` once sent, not `acked` on the launch.
- A plugin version is never activated: `activate` is never sent, and `stagedFor` is never read, so a
  staged version's devices can raise a `route_conflict`.
- `provision`'s `install` and `uninstall` answer `invalid_request` (not built); a plugin's devices
  stay in the model after it is uninstalled another way, until the owner forgets them.
- `session.lock` takes any `account` token, and a plugin's tool changes keep the owner's tier and
  `idempotent: true`.

## What it does now

- **Serving.** MCP at revision 2026-07-28 (and the two 2025 revisions), the caller resolved from its
  bearer on every request: the owner's configuration credential (16 characters at least) or a
  client's. Clients' credentials are kept as SHA-256 digests. Off loopback it serves only over TLS
  (GA-SEC-1). `describe`, `state`, `plan`, `apply`, `outcome`, `events`, `history`, `configure`,
  `provision` and `candidates` are all built.
- **The model.** It follows every bridge the owner registers (one MQTT identity per bridge, never the
  applier's own), takes their `status`, `devices`, device status, acks, events and replies, and
  judges each device's and bridge's liveness and freshness itself. Malformed input is a
  `bridge_fault`, never a reason to drop the rest or to stop: a string the store cannot keep (U+0000,
  a lone surrogate) is replaced before it is written. Devices are adopted, declared, replaced,
  routed across bridges and forgotten through `configure`.
- **The gate.** `plan` gives each step the first reason of the standard's order; `apply` dispatches
  through the same judgement at send time, with tokens used once, idempotency keys, ack bounds,
  reissues, late acks and assumed state for open devices.
- **Safe.** Safety rules fire with no client and guard their devices; latches hold and raise their
  undos to `no_voice`; a heating load is turned off at its cap; witnesses judge an action's effect
  on a sensor, each on the key set at configure (its sensor's first when the owner names none); a
  declaration change that breaks a rule or a witness disables it with a notice.
- **Provisioning and discovery.** `provision`'s join, join_close, commission, connect, remove and
  unblock (not install or uninstall, the PC work's), keyed and recorded (a keyed body kept only as its digest); the finder's candidates, and
  the owner's ignores.
- **Events.** `events` from memory, with every notice not yet taken; `history` from the store, 7 days,
  filtered in SQL, and refused for a range holding more than 10 000 events (ask for a shorter one).
- **Storage.** One Postgres schema, migrated at start; every step in memory first, its writes behind
  through one writer, committed in order. Everything GA-PERSIST-1 lists survives a restart.
- **Embedding.** `Applier.stop()` clears every timer it and its modules own, so a host can stop it
  and close its store.

The harness's mutations run only under its run id; the three that defeat a safety floor
(`trusts-any-token`, `applies-without-token`, `lets-a-client-undo-safety`) also need its clock
(`GALATEA_TIME_SOURCE`).

## Build, test and grade

```sh
pnpm install
pnpm --filter @ludentes/galatea-life-applier build
pnpm --filter @ludentes/galatea-life-applier test          # unit and MCP tests, on PGlite: no server needed
pnpm build && pnpm --filter @ludentes/galatea-life-applier conformance   # the harness, on the graded ids and the negatives; needs Docker
pnpm --filter @ludentes/galatea-life-applier conformance:matrix           # each mutation on the checks in its reach and its rows' ids; once per slice's gate
pnpm --filter @ludentes/galatea-life-applier conformance:matrix --changed origin/main   # only the mutations the change puts in scope; once per pull request
pnpm --filter @ludentes/galatea-life-applier conformance:matrix --full    # every mutation against every graded id; weekly and before every release
```

`--changed <base>` scopes the matrix to the change against `<base>` (the guide's *What runs when*).
The clean run runs as ever; then only the mutations in scope run, each still skipping by reach. A
mutation is in scope when one of its sites is in a changed file, when the check file of one of its
rows' ids changed, or a module of the harness that check file imports (the ids it breaks or couples,
and its known couplings), when one of its site files changed at the base or now, when its
`subject.json` or `proposed-rows.json` entry, its manifest row or its `known-outside.json` entry
changed or it is new, and every mutation is when the change touches the shared harness (the
harness's `sharedFor(standard)`: the common `SHARED_HARNESS` and a build's own, closed over what they
import in the harness; it holds the schemas, `pnpm-lock.yaml`, this build's `graded-ids.json`,
verdict and driver, its `src/mutations.ts` outside the `MUTATIONS` list, and `subject.json`'s fields
other than its mutations). The matrix prints each mutation in scope with
its reasons. A change that touches none runs the clean run only, and says so. `--uncommitted` adds
the working tree's changes; `--only` narrows the scope further; `--full` refuses it. When it cannot
scope (a base git cannot diff, a mutation with no site in the sources, a reach that does not hold
the sources' sites) every mutation runs, by reach, and it says why. To see a change's scope without
running anything:
`node node_modules/@ludentes/galatea-life-harness/scripts/changed.mjs --build . --base origin/main`.

What `--changed` leaves to the nightly, by design (the maintainer's rulings on the preflight, 2026-10-07):
the subject's code outside the mutations' sites (`main.ts`, the store and the rest a change may touch
without touching a site), the code a site hands its decision to in another file (a callee given the
comparison as an argument; a backlog item asks for a lint rule), and a check in a mutation's reach
but not among its rows' ids. A change to any of these runs no mutation for it; the nightly matrix by
reach over every mutation catches what it moves within a day. With `--head` other than HEAD (the
helper's command only), the build's files and sources are read from that head, but the registry's
check files, the harness's imports and the shared packages' places are this checkout's;
`--uncommitted` is refused with it. Without `--uncommitted`, a working tree with changes is warned of.

The matrix skips by reach (docs/guides/2026-10-05-how-builds-are-checked.md, *Skipping by reach*):
its clean run collects V8 coverage of each check and adds it to the stored reach, which carries
what earlier builds' clean runs reached (`~/.cache/galatea-reach`, or `--reach <store>`), and each mutation then runs only the checks that
evaluate one of its sites, with its rows' ids. `--reach <store>` on `conformance` records the graded
run's reach the same way, changing nothing it checks. `test/mutation-sites.test.ts` keeps every mutation read
through a direct comparison with its name, which the reach depends on.

The two harness runs check different things. `conformance` is the gate run on every change: every
graded id must pass, and each mutation is run only on its manifest row's ids (the ids it breaks and
their coupled ids), which must fail. It takes a few minutes. It cannot see a mutation failing an id
outside its row, since it never runs those ids under the mutation.

`conformance:matrix` runs the clean build and each mutation against all graded ids, three at a time
(`--jobs`), and lists every id a mutation fails outside its row. It takes about an hour, so it is run
once per slice's gate, not on every change. Some older rows are known to be incomplete (the
mutation fails an id through a real coupling the row does not name); `known-outside.json` lists them
until a later applier revision completes the rows (0.14 left them as they were), and the script fails only on a failure outside a
row that is not listed there, or on the clean build failing an id. `proposed-rows.json` holds the
mutations of restart clauses that applier 0.14's *Negative subjects* does not name yet, each with the
ids it breaks (the maintainer's ruling 6, 2026-10-05): the matrix runs and grades them as rows of the
standard, while `subject.json` does not list them, so `conformance`'s negatives are unchanged. Each
row is proposed for applier 0.16; when the standard names it, its mutation moves to `subject.json`.

## Run it by hand

Start a Postgres for it, on loopback, with what the installation's `db-init` makes: a `reader`
role, and the applier's role with a schema of its name. Then start the applier on it:

```sh
docker run -d --name galatea-applier-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine
docker exec galatea-applier-pg psql -U postgres -c "CREATE ROLE reader NOLOGIN" \
  -c "CREATE ROLE applier LOGIN PASSWORD 'change-me-db'" -c "CREATE SCHEMA applier AUTHORIZATION applier"
GALATEA_DATABASE_URL=postgres://applier:change-me-db@127.0.0.1:55432/postgres \
GALATEA_OWNER_CREDENTIAL=change-me-owner-credential GALATEA_MCP_PORT=18443 node reference/applier/dist/main.js
```

If a port is taken (55432, 18830, 18443), use another in each command that names it. The server trusts every connection, which is fine only on loopback and for a trial.

If `docker exec` fails at once, the server is still starting: run it again. It prints
`ready on http://127.0.0.1:18443/mcp`. Add it to Claude Code as an HTTP MCP server with the header
`Authorization: Bearer change-me-owner-credential`, then:

1. Call `describe`: `revision` 0, no devices, `levels` `["Act"]`.
2. Call `configure` with `{ "changes": [{ "op": "upsert", "kind": "client", "value": { "id": "demo",
   "credential": "change-me-client", "kind": "steward" } }], "expected_revision": 0, "dry_run": true }`:
   a `diff` of `+ client demo (steward)`, and `describe` still shows revision 0.
3. Send the same with `"dry_run": false`: `describe` shows revision 1.
4. Send it again with `"expected_revision": 0`: `stale_revision`.
5. Stop the applier (Ctrl-C) and start it again on the same database: revision is still 1.
6. Read what it keeps, as the `reader` role:
   `docker exec galatea-applier-pg psql -U postgres -c 'SET ROLE reader' -c 'SELECT seq, time, type FROM applier.history_v'`
   shows one `model` event; `SELECT * FROM applier.events` in its place is refused.
7. Call `events` with no cursor and keep the `cursor`. Stop the database
   (`docker stop galatea-applier-pg`) with the applier running, and send a `configure` adding a
   client `other` (`"expected_revision": 1`, `"dry_run": false`, and a credential of eight or more
   characters): after 10 s, an MCP error, not a result. `describe` still answers, at revision 1,
   and `history` (with a `from` and a `to`) is an MCP error at once ("the store is unreachable"):
   the `configure`'s write is still queued and failing, so the store is marked down and `history`
   does not wait on it. The applier's log says `store unreachable, retrying` once. Start the
   database again (`docker start galatea-applier-pg`):
   within a few seconds `describe` shows revision 2, and `events` from the kept cursor shows one
   `model` event, for revision 2, without the `configure` being sent again, and the log says
   `store back`.
8. Start the applier with `GALATEA_APPLIER_HOST=0.0.0.0` and no certificate: it refuses to start,
   naming GA-SEC-1.
9. Remove the database: `docker rm -f galatea-applier-pg`.

### With a bridge

This walk needs the database above (before its step 9 removes it) and a broker. Start Mosquitto on
loopback, and the harness's simulated bridge on it (built by `pnpm build`), which fronts the
fixture's nine devices:

```sh
docker run -d --name galatea-applier-mqtt -p 127.0.0.1:18830:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
GALATEA_BROKER=mqtt://demo-bridge@127.0.0.1:18830 GALATEA_ROOT=demo \
GALATEA_TEST_TRANSPORT=demo/test/demo-bridge/control node conformance/sim/dist/bridge/main.js
```

Start the applier with the broker, in another terminal (stop it first if the walk above left it
running):

```sh
GALATEA_BROKER=mqtt://demo-applier@127.0.0.1:18830 GALATEA_ROOT=demo \
GALATEA_DATABASE_URL=postgres://applier:change-me-db@127.0.0.1:55432/postgres \
GALATEA_OWNER_CREDENTIAL=change-me-owner-credential GALATEA_MCP_PORT=18443 node reference/applier/dist/main.js
```

1. `configure` with `{ "changes": [{ "op": "upsert", "kind": "bridge", "value": { "id": "demo-bridge",
   "identity": "demo-bridge" } }], "expected_revision": <describe's>, "dry_run": false }`. Within a
   second `describe` lists nine devices, `demo-bridge:lamp` to `demo-bridge:ac`, all
   `"adopted": false`, and `state` shows every one `dead`: the bridge's status so far was retained.
2. Within 10 s (the bridge's next status) every device reads `live`, but `demo-bridge:unbound`,
   whose bridge cannot know its bound, which reads `stale`.
3. Call `events` with no cursor and keep the `cursor`. Then `configure` with `{ "changes": [{ "op": "upsert", "kind": "adopt", "value": { "device": "demo-bridge:lamp", "class": "light" } }], "expected_revision": <describe's>, "dry_run": false }`:
   `describe` shows the lamp `"adopted": true`, and `events` from the kept cursor a `model` event
   naming the lamp and its class.
4. Stop the broker (`docker stop galatea-applier-mqtt`): at once every device reads `dead`. Start it
   again (`docker start galatea-applier-mqtt`): they read `live` again within about 40 s, since the
   applier retries with a backoff of up to 30 s, and the bridge's next status can take 10 s more.
5. Stop the bridge (Ctrl-C): every device reads `dead` within a second. Start it again: live within
   10 s.
6. Stop the applier and start it again: `describe` shows the same revision and the nine devices,
   the lamp still adopted; they read `dead`, then `live` within 10 s.
7. `docker exec galatea-applier-pg psql -U postgres -c 'SET ROLE reader' -c 'SELECT type, count(*) FROM applier.history_v GROUP BY type'`
   shows `liveness`, `model`, `state` and `transport` events.
8. Adopt the gate and the heater: `configure` with `{ "changes": [{ "op": "upsert", "kind": "adopt",
   "value": { "device": "demo-bridge:gate", "class": "gate" } }, { "op": "upsert", "kind": "adopt",
   "value": { "device": "demo-bridge:heater", "class": "socket" } }], "expected_revision": <describe's>,
   "dry_run": false }`. `describe` gives the gate's `cover.close` `confirm` and its other actions
   `no_voice`, and the heater's actions `reversible`.
9. `configure` with `{ "op": "upsert", "kind": "load", "value": { "device": "demo-bridge:heater",
   "load": "heating" } }`: the heater's `onoff.turn_on` is now `confirm`. Then `{ "op": "upsert",
   "kind": "tier", "value": { "device": "demo-bridge:gate", "action": "cover.close", "tier":
   "reversible" } }`: `invalid_request`, "configure only raises a tier", and `revision` stays.
10. `configure` with `{ "op": "upsert", "kind": "fresh_s", "value": { "device": "demo-bridge:lamp",
    "fresh_s": 20 } }`: `state` gives the lamp `fresh_s` 20 and `fresh_basis` `configured`, and
    `events` from a cursor kept before it a `freshness` event.
11. `{ "op": "upsert", "kind": "ack_within_s", "value": { "device": "demo-bridge:lamp", "action":
    "onoff.turn_on", "ack_within_s": 11 } }` is `invalid_request` (the lamp is reached in 1 s, so
    12 is the least); 12 is taken.
12. Call `events` and take its notices (`notice_taken` with their ids). Put the bridge's transport
    in `unknown`: `docker exec galatea-applier-mqtt mosquitto_pub -t demo/test/demo-bridge/control
    -m '{"requestId":"w12","op":"transportState","state":"unknown"}'`. Within a second `events`
    carries an `open_loop` notice for each adopted device (the lamp, the gate and the heater), and
    they still read `live`. Send `"state":"up"` and then `"unknown"` again: no new notice.
13. `configure` with `{ "op": "upsert", "kind": "forget", "value": { "device": "demo-bridge:tv" } }`:
    `invalid_request`, since the bridge still lists the TV.
14. `configure` with `{ "op": "delete", "kind": "adopt", "value": { "device": "demo-bridge:heater" } }`:
    `describe` shows the heater `"adopted": false` and its `onoff.turn_on` back at `reversible`,
    and `events` a `model` event with `"adopted": false`.
15. Remove the broker: `docker rm -f galatea-applier-mqtt`.

A `GALATEA_BROKER` that is not a valid `mqtt://` or `mqtts://` URL is refused at start, and the
message never carries its value.

## Environment

| Variable | Meaning |
|---|---|
| `GALATEA_OWNER_CREDENTIAL` | The owner's configuration credential, 16 characters at least, and none a stored client holds (required, as a value or through `GALATEA_OWNER_CREDENTIAL_FILE`) |
| `GALATEA_OWNER_CREDENTIAL_FILE` | A file holding it instead, the account's own, mode 0600; its last line end is dropped |
| `GALATEA_MCP_PORT` | The port of `/mcp` (required) |
| `GALATEA_APPLIER_HOST` | The address to listen on; default `127.0.0.1` |
| `GALATEA_APPLIER_TLS_CERT`, `GALATEA_APPLIER_TLS_KEY` | Paths to a certificate and key, PEM; required off loopback. The entry point reads them |
| `GALATEA_BROKER` | `mqtt[s]://<identity>[:<password>]@host:port`: the broker, with the applier's MQTT identity as the user name and ClientID; without it the applier has no bus, and every bridge reads dead. The password is never printed |
| `GALATEA_BROKER_PASSWORD_FILE` | A file holding the broker's password, put into `GALATEA_BROKER`, which then carries none; the account's own, mode 0600 |
| `GALATEA_BROKER_CA` | A path to the CA certificate an `mqtts` broker is validated against; without it, the system's store |
| `GALATEA_ROOT` | The deployment's MQTT `{root}` (required with `GALATEA_BROKER`) |
| `GALATEA_DATABASE_URL` | The applier's Postgres, as its own role, whose schema bears its name (required); never printed |
| `GALATEA_DATABASE_PASSWORD_FILE` | A file holding the role's password, put into `GALATEA_DATABASE_URL`, which then carries none; the account's own, mode 0600. `migrate-main.js` reads it too |
| `GALATEA_TEST_RUN_ID`, `GALATEA_TIME_SOURCE`, `GALATEA_MUTATION` | The harness's subject contract ([`conformance/README.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/README.md)) |

Every setting is read and checked before anything is opened, and a setting it cannot use stops the
applier with exit code 2 and one line naming the settings, never a secret:

- An empty value counts as unset.
- A value and its `_FILE` twin both set, or a URL that carries a password beside its password file,
  is refused. With no file set, the values and full URLs work as the harness passes them.
- Every path setting must be absolute; one that is not is refused without being repeated, since a
  secret put there by mistake would be.
- `GALATEA_BROKER_CA` needs an `mqtts://` `GALATEA_BROKER` and must hold a PEM certificate;
  `GALATEA_APPLIER_TLS_CERT` and `_KEY` are set together, and must serve TLS together.
- `GALATEA_MCP_PORT` is a port from 1 to 65535; `GALATEA_ROOT` is required with `GALATEA_BROKER`; a
  `GALATEA_MUTATION` this build does not have is refused (under a run only), and so is one that
  defeats a safety floor without `GALATEA_TIME_SOURCE`.
- `GALATEA_OWNER_CREDENTIAL` shorter than 16 characters is refused; one a stored client holds stops
  the start once the store is open.

## The image

`docker build -f reference/applier/Dockerfile -t galatea-applier:local .`, from the repository's
root, builds the image that serves both entries: `node dist/main.js` (its default) and
`node dist/migrate-main.js`. It needs BuildKit (Docker's default builder since 23.0), which reads the
allow-list beside the Dockerfile (`Dockerfile.dockerignore`); the base image is pinned by digest.

## Room for the PC work

The PC slice is built in its own session. Its fields, tier rows, ack rules, bus handlers and tables
join what is here; see the design's *Room for the PC work*.


## History

Each slice as it landed. Later slices changed some of what the earlier ones say: every operation slice 1
lists as not built is built now, and a witness with no key keeps its first key since the whole-applier review.

### What slice 1 does

It serves the MCP binding (revision 2026-07-28, and the 2025 revisions), resolves the caller from
the bearer on every request, and keeps its configuration and events in Postgres, in its role's own
schema (`docs/specs/2026-09-28-storage-design.md`). Its steps work in memory and hand their writes to
one writer, which commits them in order and retries while the store is down. `configure` takes
clients, bridges and a `time_source`, and answers once the change has committed; `describe` and
`state` show an empty model; `events` is served from memory and `history` from the store. `plan`, `apply`, `outcome`, `provision` and `candidates` are listed
and answer `invalid_request` ("not built yet"), until the slices that build them.

### What slice 2a adds

It connects to the broker named by `GALATEA_BROKER` and follows every bridge the owner registers:
their devices appear in `describe`, unadopted, with the bridge's proposed class, and the owner
adopts them with `configure`'s `adopt`. `state` gives each device's values, each with its
observation's time, and its liveness, which the applier judges itself: a bridge is dead until a
status arrives live, and 30 s after its last one, on its will, or on a graceful offline; a device is
dead when its bridge or transport is, or when its bridge says it is gone, and stale past its bound.
Losing the broker makes every device dead until each bridge speaks again. A malformed entry, an
unknown value or a message that is not JSON is a `bridge_fault` event, never a reason to drop the
rest; a will and silence kill a bridge with no `bridge_fault`, only `liveness` events. A devices
list (a roster or the document) that is missing or malformed retracts nothing: only a well-formed
list without an entry removes a device. A transport that appears or changes `kind` is a model change
(a new `revision` and a `model` event, kept in the store), and a transport a status omits reads
`down`.

After a stop that was not clean (a crash, a kill, or a stop taking over 3 s, the clean-stop
timeout), the next start moves `revision` by `SEQ_LIFE_GAP`, as it does `seq`, so a revision served
and never written is not served again for another model, and every older `events` cursor expires.
That jump changes `revision` with no change of the model.

### What slice 2b adds

Declarations. Every action's tier is the higher of the standard's *Default tiers* and what the owner
raised: a gate's `cover.close` is `confirm` and its other actions `no_voice`, a lock's `unlock`, a
water or gas valve's opening action and an `infrastructure` device's `turn_off` are `no_voice`, a
socket with a `heating` load turns on at `confirm`. `configure` takes the owner's declarations, one
kind each (`tier`, `load`, `infrastructure`, `fresh_s`, `ack_within_s`, `personal`,
`self_changing`), and `adopt` takes them at once in `declarations`, with `opens_with` for a valve
switched by a relay. A tier is only ever raised: a lower one is `invalid_request`. Changing a
socket's `load` or its `infrastructure` flag re-applies the table in the same change set. An owner's
`fresh_s` is the device's bound, over its bridge's (a `feedback: open` device's bound is unknown
until it is closed; each life starts every bound unknown, so the first bound known is a `freshness`
event); an `ack_within_s` below 2, below twice the
device's reach plus 10, or above 300 is refused. `notify.notify`, `media.announce`, `power.shutdown` and `media.launch` are never idempotent,
a device on an `ir` transport is `feedback: open`, and `app`, `camera_in_use`, `microphone_in_use`
and `speech` are personal wherever a device reports them.

Notices. `events` carries every notice not yet taken, until a client names it in `notice_taken`;
the owner's `notice_taken` is ignored. A bridge's `faults` entry naming an adopted device is one
notice while it stands, across a restart too. A device that joined while the applier was away
(found in the retained `devices` document, or in a snapshot's) is a `missed_device` notice. A bridge's device fault whose `code` is
longer than 128 characters is cut there, and at most 64 device faults stand per bridge: past that,
one `bridge_fault` says so.

The writer's backlog is capped at 100 000 write sets. While the store is down and the cap is
reached, the events' rows and the bridges' facts are dropped (both can be derived again); an owner's
change, a notice and the counters are never dropped. The owner gets a notice with cause `store`, saying history has a gap for this time, and
since events were lost the next start expires every older cursor, as after a stop that was not
clean.

A refused subscription is asked for again on the backoff until the broker grants it, and raises one
`bridge_fault` while it stands. A grant below QoS 1 is a standing fault too, but is not asked for
again: the broker's maximum will not change, so the bridge stays unheard until the next connection.

### What slice 3 adds

Adoption. The owner's `adopt` with `replaces` gives new hardware an adopted device's id: the new
device takes the old one's class and declarations (an owner-set `fresh_s` stays with the old
hardware), and the old stable identifier goes to `previous_identifiers`. A new device lacking an
action or a key the declarations use is refused, and so is one naming an identifier the id retired:
that hardware, back, is a device of its own, under a minted id such as `hall:lamp/2`. A delete of an
`adopt` un-adopts the device and drops its declarations. `forget` removes a device its bridge no
longer lists, with its adoption and declarations; while its bridge lists it, the forget is refused.
A transport leaves the model when no device names it and its bridge lists it no more, and a device
naming a transport its bridge never listed is dead, with a `bridge_fault`.

A device new to the model showing an identifier the model already holds is its own device, never
merged into the other, with a `route_conflict` event (the identifier, the bridges, the devices),
one per identifier and set of bridges; on the same bridge it is also a `route_conflict` notice.
A copy another bridge shows beside an adopted device is not adopted too: an adopted device keeps
its bridge, and an adoption with `replaces` moves it onto that copy.

Notices. `other_admins` is state: a change of it alone is an `other_admins` event, not a model
change. A device with an action above `reversible` and another admin, or with `other_admins:
unknown`, is an `other_admin` notice when it is adopted and whenever an admin is added; its `[]`
after that notice replaces it if no client took it. A device adopted on a transport that can answer
nothing, and an adopted device whose transport first reads `unknown`, are an `open_loop` notice.

### What slice 4a adds

Plans, the reason order and tokens, with nothing dispatched yet. `plan` gives one step per distinct
action, each with the first reason of the standard's order that applies, from `unknown_target` to
`token` (`safety` and `latched` come with slice 6), its tier, whether its device is stale, and
`basis: real`; it changes nothing, and its plan is held in memory for 60 s. A bad argument of a
standard action, or one beyond its device's own `args` constraints (a list, a range, an object's
fields), is `refuse(invalid_args)`. `already` is judged only on a live, closed device's
observed value. A `confirm` or `no_voice` action needs a token that stands: the sending client's own,
proved with its `token_key`, naming the step exactly, within the skew and no more than 300 s ahead.
A `no_voice` action by voice or through a brain is `refuse(tier)`. A toggle on an open device needs
a person's token (`refuse(toggle_only)`), and a toggling action is never idempotent.

Routes. A device newly showing the identifier of another bridge's unadopted device is folded into
it: held under an id of its own, exposed only as that device. Route first: that one device is
adopted only once the owner's `route { stable_identifier, bridge }` names the bridge that carries
it, so its steps read `refuse(not_adopted)` until then, and `refuse(duplicate_route)` is left to a
meta-applier. A route to the other bridge moves the device's id onto the copy there, and folds the
hardware it had, and any other bridge's copy, into it. A route never moves an adopted device, and an
adopted device's route is not deleted. A folded copy that stops sharing the identifier, or whose
device is forgotten, is a device of its own again, and a copy beside a device whose adoption is
deleted folds into it.

Ids. A bridge id is at most 32 characters. A bridge device or transport whose id would pass 128 is
not modelled: a `bridge_fault` while it stands, which drops only it.

### What slice 4b adds

Apply and dispatch. `apply` takes a plan the same client made, unexpired and of the current
revision (`plan_not_yours`, `plan_expired`, `stale_revision` and `unknown_plan` otherwise, nothing
dispatched), or an inline request, judged at dispatch (its dead target `skipped(dead)`). Each `op` step, and each planned
`skip(already)`, is judged again at dispatch, and the tokens it will use are committed before
anything is sent. Each step is published to the bridge that carries its device, never to a folded
copy's, unretained with a Message Expiry of its `ack_within_s`, and its PUBACK awaited before the
next step: `0x10` or any refusal is `unreachable` with the token unused (only `0x87` also a
`bridge_fault`, for a snapshot request too), and a PUBACK the lost connection took is `dispatched`,
never sent again. A report or ack that comes before the PUBACK waits on it. A token is recorded as
used before its command is published, used whatever follows, and dispatched at most once.

The final outcomes. An ack is taken only from that bridge, on that device's topic, with its own id
as `source`; the optional non-terminal `received` and a result the applier does not know are no terminal ack.
`failed(unreachable)` and `failed(expired)` are `unreachable`, `failed(no_confirmation)` waits, a
stateless action ends `delivered` (or `sent` where it is declared `confirms: false`), a stateful one
`acked` on a report that matches, arriving after the publish, and an open device's `sent`. An ack
still counts for 900 ms after the bound; then a closed device's step is `failed(no_ack)` and an open
one's `unanswered`. A closed one's ends at once when its bridge dies; the applier losing its broker
is no bridge's death. The terminal ack's `detail` rides on the outcome and its `outcome`
event. A report moving towards a dispatched action, inside its bound, carries that apply's cause; a
`self_changing` key does only for the action's own key. `outcome` gives an apply's outcomes to the
client that made it. Applies, waiting steps and used tokens survive a restart.

### What slice 4c adds

Idempotency keys. An apply under a key the same client used in the last 3600 s, with the same body
(compared in RFC 8785 form, without the key and the actions' tokens, so a retry carrying fresh
tokens is the same body), returns that apply as it stands and dispatches nothing; another body is
`idempotency_conflict`. A repeat that comes while the first apply still runs, its PUBACKs out
included, waits for it and answers as it does. The key is kept with its apply, before any step is
dispatched, so every apply now waits for the store, and fails within 10 s, nothing sent, while the
store is down. Keys survive a restart.

Late acks. A report matching a step that ended `failed(no_ack)` on a closed device, within the 60 s
after that outcome, is one `late_ack` event with the apply's cause, and its state change is the
apply's, never `external`; the step's outcome does not change. After a bridge's `failed` ack saying
the device did not act, even one that comes after the `failed(no_ack)`, a match is `external`
(unless a reissue already went out). The late window survives a restart.

Reissue. An idempotent step that ended `failed(no_ack)`, that used no token and whose device has
reported nothing moving away from it, is sent again under a fresh command id 500 ms after its bound
and grace (later than its `failed(no_ack)` when its bridge was found dead first), judged again by
the gate, and again after that reissue's bound: three attempts in all, each with its whole bound
inside the step's late window, so a match it brings is the step's `late_ack`, and a report moving
towards it inside its bound is the apply's. A later action dispatched to the device on the same key
stops it. A non-idempotent action is never reissued, and nothing is reissued inside a bound or after
a restart.

An open device's assumed state. A `feedback: open` device's `state` gives the values its applier
assumes, each marked `assumed: true`: the value an action asks for, once it ends `sent` or
`unanswered`, never `unreachable` or `failed`. A command for an action declared `whole_state: true`
carries `state`: the assumed value of every key, the latest earlier action still in flight taking
its key, from any apply, and the action's own value; when it ends `sent` or `unanswered`, every key
it carried is assumed. Both follow the order the commands were dispatched in, not the order their
outcomes came in: a command never overrides a value a later one set. The assumed state and what is
in flight survive a restart; a forgotten device's goes.

### What applier 0.14 brings

The build now answers to applier 0.14 and bridge 0.5, for every id the slices so far cover.

Extensions on any device. A device of any bridge may carry `extensions`, a bridge's own capabilities
named as a namespace with a dot, their actions and keys read to the last dot, each key a `state` or
an `event` (`state` where its bridge left it out); what breaks this is dropped with a fault, alone.
An extension action takes the extension tier, `confirm`, or its floor where that is higher (the
highest tier any row naming the device's class, flag or load gives, `no_voice` on a door lock, a
valve, a gate or a garage door); the owner may lower it to its floor and no further, a lower tier
being `invalid_request`, never clamped. It is never idempotent, whatever its bridge says, and a
stateful one is acked, and `already`, on the key and value its `confirmed_by` names.

Occurrences. An event key's value comes as an `occurrence` on the bridge's event topic: one
`occurrence` event, never a state value; it moves no liveness or freshness. `history` keeps it,
except one of a key in the device's `personal`, which stays in `events` only. An event key in a
device's status is dropped with a fault.

Declarations that change. A bridge re-describing a device is a model change, as before. A step of an
apply under way whose action's declarations changed before its dispatch is
`refused(declaration_changed)`; one already dispatched keeps the rules it went with, and is reissued
only where both its old and its new declaration say idempotent. A tier the owner lowered on an
extension action falls back to the table while its declarations differ from those it was set on.

### What slice 6a adds

The build claims Safe, in part: `subject.json` claims Act and Safe, and `graded-ids.json` lists the
Safe ids built so far; the rest (latches, re-sends, liveness notices, the heating cap, witnesses)
are slices 6b and 6c's, and the harness's report shows them `untested` until then. The build can
claim Safe, and `describe` says it does only while the owner's `box` is set (a provisional
`configure` kind, refused while the broker connection is plain TCP off loopback) and no bridge's
status declares an `ungoverned` path, which `describe` lists under its bridge. A socket whose load
was never configured is `heating`.

Safety rules. A rule is configured in a provisional language (`configure.safety_rule.json`):
comparisons of its own devices' reported keys with constants, joined by `all` and `any` at most two
deep, and actions as a request names them. `configure` refuses one naming a device not adopted, a key
its device does not report or an event key, an action declared `toggles: true`, a device with
another admin (or `other_admins: unknown`) without `accepts_other_admins`, and two rules setting one
key of one device differently; a forget or an adoption's delete of a device a rule names is refused,
and a rule follows its device through `replaces`. A rule fires once each time its trigger becomes
true on a new report (a later `basis_time`, never an assumed or fast-clock value), whatever the
reporting device's liveness; its actions go through the dispatcher under no client, with cause
`{ safety_rule }`, always sent and never reissued; until each has a final outcome every request for a
device it actuates is `refuse(safety)`. Complete, it gives a `safety_rule` notice saying each
outcome and a `rule_fired` event, which `history` finds by the devices the rule names. The last
basis seen per key, each trigger's last reading and a running rule are kept for a restart
(migration `0011`), which slice 7 tests.

### What slice 6b adds

The Safe claim holds: only the heating cap and witnesses (GA-LOAD-2, GA-WIT-1) are left, slice 6c's.

Latches. A rule may declare `latch: { condition }`. Its latch is held from when the rule fires until
the condition is true on reported values, never an assumed one, with every device it reads `live`.
While it is held, the rule does not fire again, and a request is `refuse(latched)` (after `safety`,
before `tier`) when it would change a key the rule set on a device it actuated to another value, by the
key it sets or a side effect (`level.set_level` turns a light on), or is any extension action on such
a device. Once the latch clears, such an action is `no_voice` and needs a token whose `for` names a
person, until an undo of that key runs. A `latch` event says when it is
set, cleared, or cleared by the owner's `clear_latch` (a Safe `configure` kind, refused when no latch
of that rule is held); a rule deleted, or no longer declaring a latch, clears its own the same way.
`state` lists the held latches. Latches are kept for a restart (migration `0013`), which slice 7
tests.

Re-sends. While a rule's latch is held, or with none while its trigger is true, an actuation that
did not land is sent again, through the dispatcher, as a new attempt with its own step id (`s1.2`).
The class of its final outcome decides what happens:
- one that did not run (`skipped(dead)`, `unreachable`, a `failed` that did not act) is sent again
  once its device is not `dead`, at once on its return;
- one that may have run (`failed(no_ack)`) is sent again only if its action is idempotent and the
  device's report since the firing does not match;
- an `unanswered` idempotent one is sent once more;
- a final one never, `failed(not_locked)` and `failed(no_graphical_session)` included, so a lock
  nothing can take is not tried for ever.

Attempts are spaced by the action's `ack_within_s`, so a live device that keeps failing gets one
attempt per bound for as long as the rule wants it. The rule is complete only once nothing waits, or
once the owner's `clear_latch` leaves it wanting nothing. A notice says at once that an actuation
waits, raised again only when what waits changes, and the completion notice replaces it, giving why
one was not sent again. A `late_ack` lands a waiting actuation and, while the rule runs, is said in
the completion notice; once the rule is complete, a `late_ack` of an actuation whose final outcome
did not land is a second notice.

Liveness notices. Each device a rule reads or actuates is a `liveness` notice, keyed by rule and
device, a newer one replacing an untaken older one:
- when it stops being `live`;
- when it is `live` again after such a notice;
- when it is closed and its `fresh_s` is not known as the rule is configured or the device adopted
  (an open device has no bound, and is `live` while its bridge is);
- when the owner's `fresh_s` is longer than the declared one.

A device dead only because its bridge went offline gracefully, or because the applier lost the broker,
is noticed only if it is still not `live` 60 s later, unless it is that bridge's second such death
within 10 min. A disabled rule is said nothing of.

Rules and declarations. `configure` checks a rule's args against its device's declared `args`, as a
plan's are (`invalid_args`), on the device it names and on one replacing it. A rule whose devices'
declarations change so that it no longer fits them is disabled (migration `0012`): an action gone or
now toggling, args the device now refuses, a key it no longer reports. It gives a `rule_disabled`
notice, fires no more, and `describe` lists it with why, until the owner sets it again; set again,
it acts as a newly configured rule, firing on the next new report that makes its trigger true. Every
rule is checked once at start, so a disable a crash lost is made again. A rule's step
whose args its device refuses at dispatch is `refused(invalid_args)`.

### What slice 6c adds

The Safe claim is whole: every Safe id is graded. What a restart keeps of an on-time, a witness's
watch and the broker's host's administrators as last seen is slice 7's.

The heating cap. A socket whose load is `heating` has a `max_on_s` (a Safe `configure` kind and
declaration, refused above 86400 and on a load that is not heating), 14400 where the owner set none,
which `describe` shows. Its on-time counts from its first report of `on`, reset only by a report of
`off`; on a socket that reports nothing, from the first `onoff.turn_on` the applier sends that ends
`sent` or `unanswered`, reset only by an `onoff.turn_off` that ends `sent`. It is kept in the store
(migration `0014`) and a clock stepped back never lowers it, nor counts a socket turned on after the
step as on for the step's length. New hardware that replaces a socket while on counts from the
replacement. On for its `max_on_s`, the socket is sent `onoff.turn_off` by the applier itself,
through the dispatcher under no client, cause `load_cap`, whatever a running safety rule or a latch
guards. Its outcome is judged by GA-SAFE-12's classes, as a rule's is: one that did not go out
(`skipped(dead)`, `unreachable`, a `failed` saying it was not carried out) is sent again whatever its
idempotency; one that may have run (`failed(no_ack)`, `unanswered`, `sent` on a socket that reports
its state) only if declared idempotent. Each is sent again no sooner than its `ack_within_s` after
the last attempt began while the socket is not `dead`, and at once on its return, until it reports
`off` (on a socket that reports nothing, until a turn-off ends `sent`). A turn-off that did not land
is one standing `load_cap` notice per socket, a new one only when what it says changes. A socket
made heating, or given a lower cap, while on past it is said to be turned off at once. The cap never
sends a toggle: `configure` refuses `load: heating`, and `max_on_s`, on a socket whose
`onoff.turn_off` toggles, and a socket taken as heating whose turn-off toggles or is not offered, at
its adoption or after its bridge re-describes it, is a `load_cap` notice saying the cap cannot act,
once while it stands. A cap that could not act, or ended `refused` or `skipped` for a missing target
or action, is armed again when its declarations or its adoption change, while the socket stays on.

Witnesses. A Safe `configure` kind, `witness`, names on an action a device offers the sensor that
judges it (read on the `key` it names, or else on the sensor's first key), what it expects (`rises`,
`falls`, `{ becomes }`, or `{ toward: { arg, by } }`, moving at least `by` towards a number argument
of the step, `unknown` when the room was already within `by` of it) and its `within_s`. Each
dispatched step of that action, from an apply, a rule or the cap, gets a second `outcome` event
`within_s` after its dispatch: `confirmed`, `unconfirmed`, or `unknown` when the sensor was not `live`
throughout. `outcome` carries the verdict as the step's `witness`, beside the step's own outcome,
which never changes. A witness over a sensor whose `fresh_s` is not known, or the owner's longer than
the declared one, is a `liveness` notice, which follows the witness to another sensor and goes with
it when it is deleted.

Computers. The `os` administrators, or the `unknown`, of a computer carrying the broker (its owner's
`infrastructure`, either way, else its bridge's `proposedInfrastructure`, adopted or not) count as
another admin of every device a safety rule actuates, so such a rule needs `accepts_other_admins`;
a computer the owner marks `applier_host` (an Act kind, on one adopted computer only) is left out,
and the refusal names both ways out. One that newly counts, its `applier_host` cleared or its flag
set, or an administrator added to it, is an `other_admin` notice for each rule without
`accepts_other_admins`, which keeps running; so is one that came while a change setting the rule
waited for its commit. An admin
added to a device a rule actuates says that the rule's latch no longer binds that admin.


### What slice 7a adds

The start in two phases. `Applier.start` is `load` then `resume`, then the bridges and the timers.
`load` reads each module's rows into memory, and nothing else: no outcome settled, no notice, no
event, no timer. `resume` lets each module judge what is due, in the order they loaded: the
dispatcher arms each waiting step again and ends a step it finds `dispatched` with no waiting row
`failed(no_ack)`, the safety rules take up a run the last life left, and the caps' resume is empty
until slice 7b. So an orphan step's end reaches modules that already hold their rows. `load` writes
one thing, as before: `EventLog.load` starts this life's `last_seq` past the last life's and removes
the clean-stop marker. Each phase runs once, in order: `load` on a new applier only, `resume` on a
loaded one only; anything else throws.

What a restart is graded on. The harness restarts the subject (SIGTERM), or crashes it (SIGKILL),
and grades across it GA-PERSIST-1's own items (the configuration, the id map, retired identifiers
and adoption, a held apply's outcomes, a pending ack deadline and the `late_ack` after it, a plan
made before as `unknown_plan`), a used token (GA-TOKEN-4), an idempotency key (GA-APPLY-4), the
assumed state (GA-APPLY-16) and a cursor of the last life after events were lost (GA-EVT-4, read
again whole or `cursor_expired`). The reference's own restart policy (every cursor expired after a
stop that was not clean, the 10 s internal error, the revision's jump) is shown by its unit tests,
never graded by the harness.

The stalled store. For a subject whose `subject.json` says `database: true`, the harness locks its
schema's tables from the admin's own session, so the subject's writes wait until the lock is
released (GA-TOKEN-4: one token sends at most one command across a stalled store, a crash and a
restart; GA-EVT-4: events served from memory and lost to a crash).

`proposed-rows.json` (the maintainer's ruling 6, 2026-10-05): the mutations of restart clauses that applier
0.14's *Negative subjects* does not name (`forgets-an-ack-deadline`, `forgets-a-retired-identifier`,
`forgets-a-used-token`, `uses-a-token-behind`, `forgets-an-idempotency-key`, `skips-lost-events`),
graded by the matrix as rows and proposed for applier 0.16. The standard's own row
`sends-a-bare-setpoint` is in `subject.json`.

### What slice 5a adds

`provision` for `join`, `join_close`, `commission`, `remove` and `unblock`. The owner's credential
only; each applier id is resolved to the bridge that owns it (a `near` must be on the transport's
bridge), the bridge's latest status must claim Provision (`not_claimed` otherwise), and the request
goes to `{root}/bridges/{b}/request/{op}` in the bridge's camel case and ids, with a fresh random
`requestId`; a bridge not registered with this applier is `not_claimed`. The bridge's reply within
2 s is returned as `{ request_id, op, status, data?, reason? }` once its record has committed; no
reply, a refused publish or no subscriber is `unreachable` with its `request_id`. A reply is routed
on its `requestId`; one naming another `op` than its request's is a `bridge_fault` and no answer. `install` and
`uninstall` stay `invalid_request`: the PC build adds them with GA-PROV-4 (the maintainer, 2026-10-05);
`connect` is slice 5b's.

Every request is committed to `provisions` (migration `0016`) before its publish, keyed or not
(the maintainer's ruling K1): a caller whose row has not committed within 10 s gets the internal error, and
a row that lands after that is never sent (the maintainer, 2026-10-05): it stays `unreachable`, its key held. An `idempotency_key` is claimed first, before any check of
the model, in `core/keys.ts` (`Keys`, slice 4c's semantics, generic in its record): a repeat within
3600 s with the same body is answered from the record whatever changed since, and sends nothing;
another body is `idempotency_conflict`. The record is the reply, or `unreachable`, replaced by a
later reply carrying the `requestId`, or `accepted` by an event carrying it; it is read back at a
start and pruned after 3600 s. The dispatcher's keys are on `Keys` too since slice 7b.

Each bridge provisioning event (`joined`, `left`, `window_closed`, `commissioned`,
`commission_failed`, `connected`, `connect_failed`, `blocked_rejoin`), taken once by its `seq`, is
one `provision` event in the applier's ids, with a provisional `what` (its kind) and `cause`
(`{ provision: request_id }` for a request this applier sent that bridge, `device` for `joined`,
`left` and `blocked_rejoin`, `bridge` otherwise); `history` matches it by its `device`, `devices`
and `transport`. Each closed window is also a `window_closed` notice naming what joined, an empty
window included (the maintainer's ruling K4).

The `provision` request and response schemas are provisional. Four mutations:
`provisions-for-anyone` (GA-PROV-1), `hides-new-devices` (GA-PROV-2) and `provisions-twice`
(GA-PROV-3, graded with a keyed `remove`) in `subject.json`; `forgets-a-provision-key` (GA-PROV-3's
restart clause) in `proposed-rows.json`, proposed for applier 0.16.

### What slice 7b adds

Safe across a restart: what the safety rules, the caps and the witnesses hold is kept, so a clean
restart or a crash leaves the house as guarded as before it. Migration `0015_restarts.sql` holds
the new rows.

A firing's records commit as one write set. `Store.group` gathers the writes of one step (a rule's
run, its latch, its actuation state; a cap's run and its row) into one transaction: a crash keeps
all of them or none, never a latch without the run that closes the valve.

The same command, the same id (the maintainer's ruling 2). Each run and each command is named, and its id
derived as a version 5 UUID in the install's namespace (`meta.command_namespace`, written before
anything is dispatched): a rule's run from the rule, the trigger's device and its report's basis
time; a cap's from the socket, its on-time and the attempt; each command from its run and its
publish slot, counted from the publishes the run's record holds (`applies.pubs`, and a waiting row's
`pub`), never from its attempts. A firing sent again after a crash that lost it carries its first
`commandId`, which the bridge's memory drops (GA-BRIDGE-4). A deliberate new attempt (a re-send, a
reissue) is a new name and a new id. A held run whose steps are all final is never handed back as a
new one's: the next firing on the same basis, or a cap's attempt derived again, takes the next name.

A running rule's or cap's run is kept past its hour and resumed with its attempts. The prune spares
every run `safety_state` or a cap not done holds; the safety rules keep each actuation's attempt,
whether it waits, and what its waiting notice said. A kept attempt above its run's last outcome (that
outcome's write lost to a crash) is taken up: it waits on its row where one was kept, and else ends
`failed(no_ack)`, since it may have run; one that may have run while its device is not yet described
in this life is judged once its declaration is known. Unknown is not false (the maintainer's ruling 8): the
trigger is read three-valued, a key with no report in this life leaving its terms undetermined, so a
run is wanted while its trigger is true or undetermined, and not once a known term makes it false. A
reported `null` is a known value that holds no comparison.

A rule's seen bases commit with the rule, inside `configure`'s transaction, so a retained report
delivered again after a crash does not fire it (GA-SAFE-11).

Latches and untaken notices are graded across a restart (GA-SAFE-7, GA-SAFE-8, GA-SAFE-13).

A said stop is kept (`safety_said`), and a start is the broker's loss (the maintainer's ruling 4): each
rule's device not `live` 60 s after the start, whose stop was not said already, is said then; a stop
said before the restart is not said again, and its return is (GA-SAFE-10). That a stop is not said
again after a restart is graded only as a proposed clause (`said-stop-not-said-again`).

On-times and caps are kept (GA-LOAD-2): the downtime counts towards a socket's cap; a cap at work is
kept in `load_caps` with its run, attempt and state, so a turn-off declared not idempotent that may
have run is not sent again, and one refused is sent again; its last attempt on an on-time is kept
with the on-time (`load_on.attempt`), so a cap stopped and armed again goes on from it. The clock's
last reading (`caps_clock_ms`), kept on a step back, with each on-time's write and at most each 10 s,
moves every on-time back when a start finds the clock earlier (the maintainer's ruling 5).
A cap's re-send due during the downtime goes at the resume, as soon as its socket is heard (the maintainer's
ruling 7).

A witness's watch is kept (`witness_watches`) until its verdict; one armed before a restart is
judged `unknown` at its due, its sensor not seen `live` throughout (the maintainer's ruling 3; GA-WIT-1). A
verdict and its watch's delete commit together, and a watch whose step's verdict is kept is never
judged again. GA-WIT-1's restart clause takes `confirmed` or `unknown`.

The maintainer's ruling 1 stands as slice 7a built it: a step a start finds neither waiting nor final is
counted as may have run (`failed(no_ack)`), so a non-idempotent own actuation is not sent again; a
resumed rule's or cap's run ends such a step through it.

`proposed-rows.json` gains ten mutations, none coupled: `loses-a-fired-run`,
`draws-a-fresh-command-id`, `forgets-a-running-rule`, `forgets-what-it-saw`, `forgets-a-latch`,
`forgets-a-notice`, `forgets-a-said-stop`, `forgets-an-on-time`, `forgets-a-cap`, `forgets-a-watch`.
Two are graded only by a proposed clause, which a subject keeping applier 0.14's text never fails
its id for: `draws-a-fresh-command-id` by `same-command-same-id` (GA-SAFE-3), and
`forgets-a-said-stop` by `said-stop-not-said-again` (GA-SAFE-10). The matrix's verdict counts such a
mutation caught when its clause is recorded not held and the id itself passes.

GA-SAFE-3's crash clause stalls the tables `subject.json` names in `stall_tables` (the reference:
`applies`), every table when it names none, and is not graded where the lock cannot be taken;
whether the valve closed before the crash is evidence only.

### What slice 5b adds

Discovery (applier, *Discovery*). The finder at `{root}/finder/` is judged as a bridge is, by its own
`BridgeRules` with no identity to match: live on a live status, dead 30 s after its last, at once on a
will naming its latest instance or a graceful status, and on a status without `v`; a retained status
never revives it (GA-BUS-8). Its faults (a skewed clock, a refused subscription) are its own, never a
bridge's `bridge_fault`. A dead finder's last list is still shown.

`candidates` is the owner's only (`not_permitted` for a client): `finder` (`live`, `dead` or `none`),
its sources and faults, the candidates listed now, and `ignored_keys`. What is listed is decided in one
place, `Discovery.list`, which `candidates`, `ignore_candidate` and `connect` all read: a candidate
sharing a key with a connection of any registered bridge, live or dead (a device's `connections`, or a
transport's), or with an ignored key, is hidden; each listed one carries `offers`, the live bridges of
each type it matches, those claiming Provision where the match says `connect`. A candidate is never a
device: a plan step naming one is `skip(unknown_target)`, and no event carries it. Connections are kept
apart from the model, in `connections` (migration `0017`), written behind and droppable (the maintainer's
ruling K5), and read back at a start, so a dead bridge's devices still hide their candidates.

`ignore_candidate` (`{ id }`, a listed candidate) adds its keys to `ignored_keys`; `unignore_candidate`
(`{ key }`) removes one. Both are `upsert` only and commit with the owner's write set into
`ignored_keys` (migration `0017`), never into the model: the revision does not move and no `model`
event is served. A change set of only ignores needs no `expected_revision` and is never stale
(GA-CFG-2); `configure.request.json` requires `expected_revision` unless every change is an ignore,
and any other set without it is `invalid_request`.

`provision.connect` checks, in this order: the candidate listed now, else `invalid_request`; the
bridge this applier's, claiming Provision, of a type the candidate matches with `connect: true`, else
`not_claimed` (an unknown bridge included); the address exactly the listed one, present where it has
one and absent where it has none, else `invalid_request`. The bridge is sent the owner's address and
the candidate's keys. A `connect` ends at a reply other than `accepted` (the bridge's `failed(busy)`
to a second one in flight, `invalid_request`); at `connected` or `connect_failed` carrying its
`request_id`; or as `connect_failed(lost)` 70 s after its publish, at any death of its bridge while
it is open, at a broker loss while that bridge is live (K3: a bridge already dead at the publish is
answered `unreachable` at once and waits its 70 s, unless it comes back and dies again), or at the
resume after a restart (K2). A later `connected` is issued all the same. The record is GA-PROV-3's:
the reply, `accepted` once an event carrying the `requestId` arrives; the applier's own `lost` is no
outcome of the bridge's and leaves it as it was. An end's event and its row commit as one write set;
a `connect` never published (its row late past the caller's gate) is written ended.

The shapes of the `provision` event (`what`, `cause`), of `candidates`' `ignored_keys` and `offers`,
and of the ignore values are provisional. Fourteen mutations: `trusts-a-dead-finder` (GA-DISC-5),
`plans-on-a-candidate` (GA-DISC-1), `shows-candidates-to-a-client`, `hides-the-finders-sources`,
`lists-a-held-candidate` (GA-DISC-2), `forgets-an-ignore` (GA-DISC-3), `connects-to-the-wrong-bridge`,
`event-without-request-id`, `never-ends-a-connect` and `ignores-the-address` (GA-DISC-4) in
`subject.json`; `forgets-connections` (GA-DISC-2), `ignore-moves-the-revision` (GA-DISC-3),
`checks-revision-for-ignores` (GA-CFG-2, coupling GA-DISC-3) and `forgets-a-connect` (GA-DISC-4) in
`proposed-rows.json`, proposed for applier 0.16.

### What the Zigbee-fidelity slice adds

The applier takes what the real bridges send, not only what the simulated bridge shares with it, and
`describe` is at applier 0.15 (`standard_version` `0.15`).

- **Commands.** An action's arguments go on the wire by their count (bridge, *Commands*): none, the
  argument itself for one (bare, even when it is an object), an object for several. An extension
  action takes exactly the arguments its `args` name; one it does not name is `refuse(invalid_args)`,
  one named without `optional: true` is required. Message Expiry is the ack bound rounded up to whole
  seconds.
- **The `args` table**, as the maintainer ruled: an array is the allowed values; `{ min?, max?, step? }`
  a range; `"any"` or `{}` no limit, any scalar; an object of named fields an object argument; `optional: true` an
  argument that may be left out. A value off a range's `step` is refused before dispatch, never
  rounded. A step of 0 or less, or a range key beside a field, is malformed. `describe` gives each
  action's `args` in this form. `common.json`'s `argConstraint` is the schema.
- **Key schemas.** An extension key's schema is a scalar's with a scalar `type`, or with no `type` and
  a non-empty `enum` of scalars, as the Zigbee bridge gives an enum expose.
- **What a bridge says beyond its declarations** (GA-DESC-19). `describe` gives a device's
  `awaited_keys`, `settings` and `undescribed` (each name with its `first_seen`). A change to
  `awaited_keys` or `settings` is a model change; one to `undescribed` alone moves no revision. The
  bridge's `undescribed` event is relayed once per name, in events only, and a name first met in a
  `devices` document, live or retained, is announced too. The names announced are kept per bridge
  device in `undescribed_announced` (migration `0018`), so a restart announces none again.
- **Keys a safety rule reads** (GA-SAFE-14). `configure` refuses a rule, latch or witness on a key its
  device does not declare with `invalid_request` and `data { key, device, awaited }`; an error's
  `data` now reaches the caller. A declaration change that takes the key away disables a rule (as
  before) or a witness, with a `rule_disabled` notice naming the key; a disabled witness shows
  `disabled` in `describe`, judges nothing, and stands again once the owner sets it anew. A witness
  with no `key` reads its sensor's first key, and is disabled when that key changes.

Six mutations: `hides-awaited-keys`, `drops-the-undescribed-event` (GA-DESC-19) and
`accepts-a-safety-rule-on-an-undeclared-key` (GA-SAFE-14) in `subject.json`; `wraps-a-lone-argument`
(GA-EVT-3), `forgets-announced-names` (GA-DESC-19) and `floors-message-expiry` (GA-BUS-5) in
`proposed-rows.json`, proposed for applier 0.16.

The simulated bridge moved to the real bridges' shapes with it: its transport is of kind `zigbee`; a
command is `failed(unreachable)` at once only on a down transport or `available: false`; a `remove` of
a device id it never had is `failed(unknown_device)`; it refuses a wrapped one-argument value; and a
named device, `presser`, loses its onoff actions to a press in click mode and gets them back in switch
mode. `reinterview` publishes a status with no reading, which the applier reads as neither removal nor
death.
