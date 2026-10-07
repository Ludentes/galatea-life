---
title: The reference applier — design
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/specs/2026-09-27-conformance-harness-wave-0-design.md
  - docs/reviews/2026-09-28-mcp-revision-pin.md
  - docs/specs/2026-09-28-storage-design.md
  - standard/applier.md
  - standard/bridge.md
  - conformance/README.md
---

# The reference applier — design

Classification: **architectural**. `reference/` holds no applier; the only applier in the
repository is the harness's minimal stand-in ([`conformance/sim`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/sim)). This is the first build of the
core (roadmap, *The core*), chosen first by the maintainer on 2026-09-28 because first light, the
Zigbee bridge's applier side and the steward's real neighbour all rest on it.

## What it delivers

A reference implementation of [`standard/applier.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/applier.md) 0.14, with [`standard/bridge.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/bridge.md) 0.5, over bridges (not an adapter, not a
meta-applier), in TypeScript, graded by the conformance harness at Act and then Safe, **except the
PC text**:

- **In:** everything an applier over our own bridges needs for first light and for the gate to
  refuse: the device model, the bridges' bus, liveness, adoption, plans, tokens, apply and outcomes,
  events and history, restarts, `configure`, provisioning and discovery; then Safe (safety rules,
  latches, loads and the heating cap, witnesses).
- **Left for the PC workstream** (the maintainer, 2026-09-28): computers, players, waking and
  `media.launch`, plugins (install, uninstall, activate, staging, tombstones), and the PC clauses of
  general ids. The PC session builds them on this applier, with the harness's PC simulators, on its
  own branch. This design leaves them room (*Room for the PC work*) and builds none of them. The
  ids that are PC-only: GA-DESC-10, 11, 15, 16, 17, GA-APPLY-12, 13, GA-EVT-7, GA-ADOPT-4, 5,
  GA-PROV-4 and GA-BUS-15. GA-DESC-14 was PC-only until applier 0.14 gave extensions to any
  device; its plugin clause (`requested_tier`) is still the PC build's. The PC clauses inside general ids are graded by the PC session's tests;
  this build's tests of those ids carry a `covers` note that leaves them out.
- **Not in the first release:** the meta-applier (GA-META-*, GA-BIND-3) and the adapter clauses
  (GA-DESC-12, the adapter parts of GA-STATE-5, and GA-STATE-3, which is an adapter's and a
  computer's only). So the house's scenarios that need a meta-applier or the Home Assistant
  adapter (HS5 beyond the box's own lights, HS6, HS7, HS9's house gate, HS11, HS16) wait for a
  later build; the flat's do not.

`subject.json` claims `Act` from slice 1 and `Safe` from slice 6, so the harness grades those ids.
Until the PC slice lands, the report shows the PC ids untested, and no conformance claim is made:
a claim needs every id of the level to pass (applier, *Conformance*). The report is still the
measure of progress, slice by slice.

**Each slice grows the harness with it.** Wave 0 tests 8 applier ids. Each slice's plan writes the
harness tests for the ids it implements first (tests first), and the negative mutations that arm
them, and adds to the simulated home what those tests need (an IR device, a momentary gate relay, a
heating socket, a finder). The harness then grades the reference applier, not only its own
stand-in.

## Approaches considered

**A. A new package, one process, one serial core** (chosen). `reference/applier` is its own pnpm
package. Every change to the applier's state (a `configure`, an apply, a bridge's message, a timer
firing) runs as one step: synchronous, in memory, and never interrupted, since Node is
single-threaded and a step awaits nothing. A step hands what it changed to the store's single
writer, which commits it behind (the storage design, *The applier, safety first*). The standard's
"one step" requirements then hold by construction: a token's check and its use (GA-TOKEN-4), a
change set applied whole or not at all (GA-CFG-2), a revision bump with its `model` event
(GA-DESC-2).

**B. Grow the harness's simulated applier into the reference.** Rejected. The stand-in is minimal
on purpose: it plays the steward's neighbour in the steward's harness, and a stand-in that grows
every rule of the standard stops being a small, trustworthy fixture. The builds' boundary rule also
keeps a build out of [`conformance/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance) (workstreams, *Repositories*). The reference may copy code from
it (the bridge link, the MCP wiring) and then owns the copy.

**C. An actor per bridge and per device.** Rejected for now. It spreads a single decision (a plan
reads liveness, latches, tokens and adoption at once) across mailboxes, and a home has tens of
devices, not thousands. A split is a refactor inside the core later, if a measurement asks for it.

## Where it lives

```
reference/applier/
  package.json          @ludentes/galatea-life-applier; bin: dist/main.js
  subject.json          the harness's subject file (database: true, the mutations it implements)
  migrations/           numbered SQL files, applied at start (the storage design, *Inside a build*)
  src/
    main.ts             reads the environment, wires the modules, prints "ready"
    core/               the store and its writer, the owner's line, the event log
    model/              devices, the id map, declarations, tiers, revision
    bus/                the MQTT 5 client: bridges, finder, ingest, commands, requests
    state/              values, liveness verdicts, causes, assumed states
    gate/               plans, the reason order, tokens
    dispatch/           apply, outcomes, ack and late-ack timers, idempotency
    provision/          provisioning and discovery
    safety/             safety rules, latches, loads, witnesses (Safe)
    config/             configure: validation, dry runs, atomic application
    mcp/                the MCP binding: tools, authentication, errors
    mutations.ts        the negative mutations, off unless the harness asks
  test/                 unit tests per module (vitest), on an in-memory clock and PGlite
```

**Dependencies:** `@modelcontextprotocol/server` 2.2.0 and `@modelcontextprotocol/node` 2.1.0, as
the harness; `mqtt` 5, as the harness; `@ludentes/galatea-life-test-clock` (the subject contract names it); and
`@ludentes/galatea-life-schemas`, for the generated types and to validate the requests the applier receives
over MCP (a bridge's messages are parsed per entry and field instead, *The bus*); and `pg`
(node-postgres) for the store, as `docs/specs/2026-09-28-storage-design.md` decides. Nothing else at
runtime; PGlite is a test dependency only. A build may depend on these two
conformance packages: they are the standard's machine shapes and the harness's clock, and neither
imports a build.

## The core

- **Clock.** Every time the applier reads, elapsed time included, comes from `@ludentes/galatea-life-test-clock`
  (`clockFromEnv`): the harness's source under the harness, the system clock outside it
  (GA-HARN-1). `configure`'s `time_source` retargets it, and outside the harness `configure` refuses
  `time_source`. Periodic work reschedules a `setTimeout` from its own callback, so a stepped hour
  runs it once. A timer never reads Node's monotonic clock. Where the standard asks for "never less
  than the monotonic time elapsed" (the heating cap, GA-LOAD-2), the cap is kept as a start time on
  the applier's clock and persisted; a step forward shortens it, which is what the harness tests,
  and a step backward is floored at the time already counted.
- **Steps.** A step is synchronous: it reads and changes the applier's memory, and awaits nothing,
  neither the bus nor the store. It publishes and ends, and the PUBACK, or the connection's loss,
  arrives as a step of its own, so a half-open broker link cannot hold a leak rule or a liveness
  verdict behind it. It hands its writes to the store's writer and ends, so a hung store cannot hold
  one either. Long waits (a PUBACK, an ack, a commit, a long-poll) are never inside a step: a step
  registers a deadline or a waiter and ends, and a caller that must wait (an `apply` for its PUBACKs)
  waits outside.
- **Store.** Postgres, reached through `GALATEA_DATABASE_URL` as the applier's own role, whose
  schema the installation makes and names after it (the storage design). The applier names no
  schema: its search path finds its own. The schema comes from numbered SQL files in `migrations/`,
  applied at start in one transaction by a runner of about thirty lines, each recorded in
  `migrations`; an applied file is never edited. The view `history_v` is the history the `reader`
  role may read, and all it may read; the tables behind it stay free to change. The applier cannot
  start without its store, since its configuration is there. Its tables follow GA-PERSIST-1's list:
  the configuration (devices and their declarations, bridges, clients, rules, loads), the id map and
  retired identifiers, idempotency keys with their outcomes, used tokens, latches, unacknowledged
  notices, heating on-times, assumed states, incomplete safety rules, ack deadlines, adoption state,
  `ignored_keys`, the bridges' last `connections`, the last `basis_time` per safety-read key, and the
  event log. Plans are not kept (`unknown_plan` after a restart). Each item is written to the store
  by the slice that introduces it, so nothing is kept only in memory by design; slices 6b and 6c
  left four pieces of memory behind them that a restart needs, which slice 7 keeps, and the tests
  that restart the subject to prove it all are slice 7's (see *Slice 7*). The PC items of GA-PERSIST-1
  (the wake's check-ins, `tool_hash`, tombstones, `activate`) are added by the PC slice.
- **The writer** is the schema's single writer. It commits write sets one at a time, each in one
  transaction, in the order the steps gave them. A failure that passes (the store down, a timeout, a
  server shutting down, a full disk) is retried with backoff, from 250 ms to 5 s, until the write set
  commits; since a commit whose answer was lost is retried too, every write set is safe to run twice.
  A **fault**, a statement Postgres refuses for good (a constraint, a missing table, a privilege),
  would stop every write after it, safety's included, while the applier ran on state the store does
  not hold. So the applier reports it and exits (the maintainer, 2026-09-29), and a restart reloads
  from what is kept. Every statement is bounded to 5 s on the server and on the client.
- **What waits for its commit** (the storage design). An owner's change by `configure`, and from
  slice 3 adoption, reaches memory only once its write set commits, and the next owner change waits
  in line, unvalidated, until then; a change that waits out 10 s in line gets an MCP internal error
  and is never applied. A caller whose change has not committed within 10 s gets the same error; the
  change stays queued and takes effect when the store returns. From slice 4, a used token and an
  idempotency key with its outcome gate their dispatch the same way. Everything else is written
  behind: events, bridges' model changes, and protection's records.
- **Event log.** Events get an increasing `seq`, given in memory in the order they happen, and the
  applier's time. `events` is served from memory, so the steward hears of a safety rule firing
  while the store is down (the storage design); each event is written behind. `history` reads the store, after the writer has committed what was
  handed to it before, and fails while the store is down. `events` returns those after a cursor,
  which is the last `seq` given; a cursor with an event after it older than the retained window is
  `cursor_expired`. Kept 3600 s for `events` (GA-EVT-4) and 7 days for `history` (GA-EVT-5), pruned
  by a periodic step. A long-poll (`wait_s` up to 30) is a waiter released by the next event or its
  timeout, never a step. A cursor whose next events were pruned (the log records the last `seq` it
  pruned), or one ahead of the log, from another store, is `cursor_expired` too, so the steward's
  recovery always runs. Each life of the applier starts `seq` a million past the last one's, past any
  `seq` it could have served and not kept, so a cursor from before a restart never skips a new
  event. `history` filtered by device matches an event's target, and for `rule_fired` and `latch`
  the devices its rule actuates (slice 6), which GA-LEASE-6 reads back; a `state` event's `speech`
  key never reaches `history`.
- **Before anything else is written behind** (slice 2, the bridges' model changes): a cap on the
  writer's backlog, below the million a life's `seq` moves by, with a notice to the owner when it is
  reached, since a full disk can last days. Past the cap, the writer drops only write sets that can
  be derived again: a bridge's facts and event rows; never an owner's change, a latch or a notice.
  Since events were then lost, every cursor older than the next start expires, as after a stop that
  was not clean (*Restart loss*), and the owner gets a notice when the cap is reached (the
  maintainer, 2026-09-29; built in slice 2b).
- **Restart loss** (built in slice 2a). An event served from memory but not yet written when the
  process dies is gone. The next life starts at `last_seq + SEQ_LIFE_GAP`, so a cursor below that
  silently skips the lost event and gets no `cursor_expired`, and the steward's lease and latch
  recovery runs only on `cursor_expired`. Slice 2 closes it: a clean `Store.close` with an empty
  backlog persists a clean-stop marker, the start clears it, and when it is absent the log sets
  `trimmedThrough` to the new life's starting `seq` (`last_seq + SEQ_LIFE_GAP`), so every cursor of
  the last life expires. (`last_seq + 1` is not enough: the lost event's `seq` is above the
  committed `last_seq`, so a cursor on it, or past it, would still read on without
  `cursor_expired`.) `revision` is lost the same way: it moves at commit and is written behind, so a
  revision served and not written before a crash could be served again for another model. After a
  stop that was not clean (one taking over the clean-stop timeout, 3 s, counts), `revision` jumps by
  `SEQ_LIFE_GAP` too, and the jump is written at start, as `seq`. That jump changes `revision` with
  no change of the model, which this build accepts under GA-DESC-2: a `revision` that moves for no
  model change is safe (a steward re-reads), where one that repeats for another model is not.
  The cap-limit gap: `SEQ_LIFE_GAP` is 1e6 (the maintainer kept it there, 2026-09-30), so after an
  outage of the store past 1e6 served events, followed by any stop, a reboot included, the next life
  starts below some lost event's `seq`, and a cursor read on past lost events without
  `cursor_expired`. Only the clean-stop marker is safe against it, and a stop after so long an outage
  is not clean.
- **Reserved keys in event bodies** (built in slice 2a). A body with a `seq`, `time` or `type` key
  overwrites the event's own today. Before bridge-supplied fields enter bodies, the log spreads the
  body first or refuses reserved keys.

## The bus

One MQTT 5 client, with Session Expiry 0, Retain Handling 0 and Retain As Published off, so a
retained delivery can be told from a live one. It subscribes, per registered bridge, only to the
topics it reads (`status`, `lwt`, `devices`, `devices/+/status`, `devices/+/ack`, `reply`,
`event`), never to a filter that matches `command` or `request/` (GA-BUS-9), and to the finder's
topics. It publishes commands and requests at QoS 1, not retained, with Message Expiry as the
bridge standard gives it, and reads the PUBACK reason code: success is `dispatched`; `0x10` and
`0x87` are `unreachable`, and `0x87` also raises a `bridge_fault` event; a connection lost before
the PUBACK counts as `dispatched`, and the command is never sent again (GA-BUS-5, GA-BUS-9). The
MQTT client's own store of unacknowledged publishes must not replay them on reconnect; slice 4
tests this against the client library rather than trusting its defaults.

Ingest parses per entry and per field: a malformed entry is dropped with a `bridge_fault`, and the
rest of the message stands (GA-BUS-1). It never gates on the strict `bridge/*.json` schemas, whose
enums are closed: an unknown value is taken as the least it can mean (GA-BUS-3), any RFC 3339
offset is a time, and a message that throws is caught, as a `bridge_fault`, one message at a time.
The rules in the bridge text and the applier's *Bridges* section are each a function of the latest
facts and the clock, so each is unit-tested on its own: bridge death at 30 s, on its will with a
matching `instanceId`, or on a graceful status; revival only on a status that arrives live and whose
`publishedAt` is no earlier than the death less 5 s (GA-BUS-8), a status that does not revive
changing nothing, except that a bad or skewed one is a fault; `v` and `bridgeId` checks; a fast clock, and a `publishedAt` more than 5 s from its
arrival either way, a slow clock included (GA-BUS-2); `seq` gaps, an `instanceId` not seen before in
an event or in a status arriving live (never a retained one), and a reconnect each asking for a
`snapshot`; an empty retained `lwt` is a will cleared, not a death; losing the broker makes every
bridged device dead. The names the bridge sends in camelCase become the applier's snake_case at
ingest, once.

A bridge is dead until a status arrives live, at its first registration as after a reconnection:
a retained status delivered on subscribing never makes it live (GA-BUS-8: a retained status
says what was, not that the bridge is there now). The 30 s window starts at the SUBACK, and a bridge dead only because the applier connected or
reconnected raises no `bridge_fault`. The harness's applier setup therefore asks its simulated
bridge for a live status once the bridge is registered, and starts each test from live devices.

The consumer's own rules, learned from MQTT clients in the field, which neither standard states (listed under
*Standards fixes this build shows*; the maintainer, 2026-09-29):

- Subscribe at QoS 1, and check every SUBACK: a topic not granted QoS 1 is a fault, and that bridge
  is not counted as heard.
- A keepalive of at most 10 s, so a half-dead link is found within 1.5 × 10 s.
- The ClientID is the configured identity, never generated; a DISCONNECT `0x8E` (the session taken
  over) is logged as a fault, and lengthens the backoff.
- Reconnect with exponential backoff and jitter, reset only once the CONNACK and every SUBACK are in.
- The client's options are pinned so nothing is queued while offline or replayed after a
  reconnect; a `snapshot` request, which expires in 10 s, is not sent at all while disconnected.
- A device status whose `deviceId` is not its topic's `{d}`: the topic wins, and it is a
  `bridge_fault`.
- A `publishedAt` that does not parse is a `bridge_fault`, and neither a heartbeat nor a revival.
- An empty retained `status` is not a heartbeat and erases no will; an empty `lwt` is a clear.
- Data re-delivered unchanged (by a snapshot or a reconnect) writes no event and nothing to the
  store.

## The gate and dispatch

- **Plans** hold their request, the model revision, the client and the steps, and expire after 60 s
  on the applier's clock. The reason order of the standard is one ordered list of checks, each a
  pure function of the step and a snapshot of the applier's state, so a new reason is one entry and
  the order is visible in one place. Planning writes nothing (GA-PLAN-1).
- **Tokens** are checked at plan and at dispatch: the proof is HMAC-SHA256 over the RFC 8785
  canonical form of the token without `proof`, keyed by the key registered for the issuing client.
  The check and the record of its use are one step (GA-TOKEN-4).
- **Apply** re-evaluates each step at dispatch, publishes, and answers with each step's
  synchronous outcome once it has every PUBACK. Final outcomes arrive as `outcome` events. Each
  step's deadline (`ack_within_s`, then the late-ack window) is a timer on the clock, persisted, so
  a restart resumes it. Idempotency keys are per client, kept 3600 s, and compare the request's
  canonical form without the key and the tokens (GA-APPLY-4).
- **Causes.** Each dispatched step opens an attribution window on its target and key until the
  device reports the value, the ack says it did not act, or `ack_within_s` passes. Inside the
  window, a report that moves towards the action's value is the apply's; one that moves away from
  it, such as a person switching the kettle off while the routine's step is still open, is
  `external`, and so is a report outside every window (GA-EVT-1).
- **Ack rules by action.** The rule that turns acks and reports into a step's final outcome is
  looked up per action: the default rule for every action, the open-loop rule for `feedback: open`
  devices, and later the PC session's rules for `power.wake`, `media.launch` and `session.lock`
  (*Room for the PC work*).

## Configure, the model and adoption

`configure` validates the whole change set, then applies it in one transaction, or refuses it and
changes nothing (GA-CFG-2); `dry_run` returns the diff it would apply. A stale `expected_revision`
is checked first, except for a change set of only `ignore_candidate` and `unignore_candidate`,
which GA-CFG-2 exempts (slice 5). Each `kind` has a validator and an applier function, in one table.

The shape of each `kind`'s `value` is left open by the standard. Wave 0 made the change envelope
provisional (`{ op, kind, value }`); this build's first plan writes a provisional schema for each
`value` it accepts into [`conformance/schemas/applier/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/schemas/applier), so the harness and the build share them,
and lists each under *Standards fixes this build shows*. They keep the shapes the harness already
sends: `client` as `{ id, credential, kind, token_key? }`, `bridge` as `{ id, identity }`, `adopt`
as `{ device, class, … }` and `time_source` as a `host:port` string.

Tiers are derived, not stored: the default tiers table is data, matched first row wins, and
`configure` stores only what the owner set (GA-DESC-3). The extension row and its floor (applier
0.14) are built: `confirm`, or the floor where it is higher, which the owner may lower an extension
action to and no further (GA-DESC-14). The PC rows (computers, hosted devices, a plugin's
`requested_tier` in the floor) join that same table with the PC slice.

## Safe

Safety rules run as steps like any other, fired by a newer report (a later `basis_time`, never
an assumed or fast-clock value), and dispatch through the same dispatch module as a client's apply,
with cause `{ safety_rule }`. Latches, the heating cap, notices that are never dropped and
witnesses are each a module with its own timers on the clock. The rule language (trigger,
conditions, the latch's condition) is not defined by the standard: this build defines a small
provisional one in the Safe plan, of comparisons on its own devices' keys joined by `all` and
`any`, and lists it under *Standards fixes this build shows*.

**The rule language** (slice 6a, [`conformance/schemas/applier/configure.safety_rule.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/schemas/applier/configure.safety_rule.json)). A rule
is `{ id, trigger, conditions?, actions, latch?, notice?, accepts_other_admins? }`. An expression is
a comparison `{ device, key, op, value }`, with `op` one of `eq`, `ne`, `lt`, `le`, `gt`, `ge` and
`value` a string, number or boolean, or `{ all: [...] }` or `{ any: [...] }` of comparisons, nested at
most two deep. A comparison holds only on a reported value: a key with no value, or only an assumed
one, holds none, `ne` included; an order compares numbers only. An action is `{ target, action,
args? }`, as a request names it. The language leaves out, on purpose: time, durations and schedules
(a rule fires on a report, and the heating cap is GA-LOAD-2's, not a rule's); arithmetic and one key
compared with another (a threshold is a constant); `not` (write the opposite comparison); an
occurrence (GA-EVT-8 refuses an event key); liveness, freshness or an assumed value as a term (a
rule fires whatever the reporting device's liveness, GA-SAFE-11, and the liveness notices are
GA-SAFE-10's); another applier's device (GA-SAFE-6); args computed from a reading; and delays or
order between actions beyond request order. Every scenario that names a safety rule, latch, cap or
witness (HS4, HS8, HS12, HS13, HS14, HS17) is written in it, or needs no rule (the cap, the witness);
the walk is in the slice 6a plan.

## Room for the PC work

The PC session adds, without rewriting what is here:

- **Model:** the PC device fields (`host`, `plugin`, `version`, `wake_via`, `accounts`,
  `staged_for`, `internal`, `applier_host`, `proposed_infrastructure`) are stored and
  passed through `describe` from the first slice, since they are plain fields; only the behaviour
  behind them is the PC slice's. `extensions` is any device's since applier 0.14, and is built: a
  plugin's are its manifest's, which the PC slice brings.
- **Tiers:** the PC rows join the default tiers table.
- **Ack rules:** `power.wake`, `media.launch` and `session.lock` register their own rules.
- **Bus:** the `installed`, `uninstalled` and `install_failed` events and the `activate` request
  have handlers to register; until then the ingest records them as unhandled, never as a fault.
- **Store:** the PC items of GA-PERSIST-1 add tables.
- **Harness:** the simulated PC bridge, the wake relay and the test plugins are the PC session's.

## Negative mutations

The reference applier implements the negative subjects of the ids each slice builds, each behind
`GALATEA_MUTATION` and only while `GALATEA_TEST_RUN_ID` is set, as the subject contract says. Each
mutation is one named switch read at the point it breaks, listed in `mutations.ts` and
`subject.json`. So the build's negatives run proves both the harness's tests and the build.

## TLS and the MCP binding

Under the harness the applier serves plain HTTP on loopback, which GA-SEC-1 allows. Outside it,
the applier refuses to listen on any address but loopback without a certificate and key
(configured by path), and serves HTTPS with them. The MCP server serves revision 2026-07-28 and the
2025 fallback through the SDK's handler, as the harness's stand-in does (GA-BIND-1); every request
carries its bearer, checked against the registered clients and the owner's configuration
credential on every request, at every revision (GA-AUTH-3).

## The slices

Each slice is one plan, reviewed by the maintainer before code, and ends with the harness grading
its ids `pass` and its negatives failing exactly those ids.

| Slice | Delivers | Ids |
|---|---|---|
| 1. Skeleton | package, subject file, clock, queue, store, event log, MCP server and auth, `configure` for clients, bridges and `time_source`, `describe` and `state` of an empty model, the provisional `configure` value schemas | GA-BIND-1, GA-SEC-1, GA-AUTH-3, GA-CFG-1, 2, GA-LVL-1, GA-DESC-2 (its configure clause), GA-EVT-4 |
| 2. The bus, the model and plain adoption | MQTT ingest, bridge liveness, snapshots, faults, the id map, devices, declarations and derived tiers, liveness verdicts, `adopt` of a proposed device | GA-BUS-1 to 3, 6 to 8, 10, 12, 14, GA-STATE-1, 2, 4 to 6, GA-DESC-1, 3 to 5, 7, 9, 13 (their non-PC clauses), GA-CFG-3, GA-EVT-2, 5, GA-ADOPT-1 (its adopt clause) |
| 3. Adoption | forget, route conflicts, replacement, notices | GA-ADOPT-1 (the rest, but its Safe clauses), 2, 3, 6, GA-BUS-11 |
| 4. Plans and apply | plans, the reason order, tokens, dispatch, outcomes, acks, late acks, idempotency, causes, `whole_state`, the ack's detail | GA-PLAN-*, GA-TOKEN-*, GA-APPLY-1, 2, 4 to 11, 14 to 16, GA-EVT-1, 3, 6, GA-BUS-4, 5, 9, 13, GA-HARN-1 |
| 5. Provisioning and discovery | `provision` and its key, replies and provisioning events, the `window_closed` notice, the finder, candidates, connections, ignores, `connect`; their persistence across a restart; planned as 5a (provisioning) and 5b (discovery), *Slice 5* | GA-PROV-1 to 3 (`install`, `uninstall` and GA-PROV-4 deferred to the PC build, the maintainer 2026-10-05), GA-DISC-1 to 5, GA-CFG-2's ignore clause, GA-EVT-5's `provision` |
| 6. Safe | safety rules, latches, loads and the heating cap, witnesses, never-dropped notices; a safety rule following its device through adoption and replacement | GA-SAFE-* (GA-SAFE-7's extension actions included), GA-LOAD-2, GA-WIT-1, GA-DESC-6, 8, GA-ADOPT-1 and 2 (their Safe clauses), GA-EVT-8's safety-rule clause |
| 7. Restarts | the harness's restart, crash and stalled store; a start in two phases; every durable item read back, Safe's included, and the four 6c and 6b kept only in memory; the restart clauses of slices 4 to 6 graded across a real restart | GA-PERSIST-1 (its non-PC items, but slice 5's), and the restart clauses of GA-TOKEN-4, GA-APPLY-4, GA-APPLY-16, GA-EVT-4, GA-SAFE-1, 3, 7, 8, 10, 11, 12, 13, GA-LOAD-2 and GA-WIT-1 (*Slice 7*) |

First light needs slices 1 to 4 and the Zigbee bridge; the gate refusing on a real device needs 6.

Slice 2 is planned and built as two plans (the controller's ruling, 2026-09-29, when its scope
proved too large for one): **2a, the bus** (GA-BUS-1, 2, 3, 6, 7, 8, 10, 14, GA-STATE-1, 2, 5,
GA-DESC-1, GA-ADOPT-1's adopt clause, and GA-EVT-2 for the causes the bus produces, with the
restart-loss fix and reserved keys in event bodies), then **2b, declarations and notices**
(GA-DESC-3, 4, 5, 7, 9, 13, GA-STATE-4, 6, GA-CFG-3, notices with GA-BUS-12, GA-EVT-5, and the
writer's backlog cap). A clause of a 2a id that needs a notice (GA-BUS-6's missed notices) is
graded with 2b.

Slice 4 is planned and built as three plans (the controller's brief, 2026-10-01: each part gives a
working, graded applier). **4a, plans, the reason order and tokens** (nothing dispatched): GA-PLAN-1,
2, 3, 4 (but `power.wake`'s order, the PC build's) and 8's plan clauses; GA-TOKEN-1's plan clause,
GA-TOKEN-2 but "already used", GA-TOKEN-3; GA-HARN-1 (graded now that a plan has an `expires_at`
to step past); the plan clauses of GA-BUS-7 and 14 (`skip(dead)`); GA-BUS-11's one device and
routes, under route first; a device's own `args` constraints; and the id-length rules. **4b, apply and dispatch**: `apply`
and `outcome`, re-evaluation at dispatch (GA-APPLY-9), GA-APPLY-2, request order (GA-PLAN-7),
PUBACK handling (GA-BUS-5, 9, and the snapshot request's `0x87`, which slice 2a ignored), acks and
their source (GA-BUS-4, 13), the outcomes (GA-APPLY-1, 5, 7, 8, 14, 15), the token's use
(GA-TOKEN-1's apply clause, GA-TOKEN-2's "already used", GA-TOKEN-4), and causes (GA-EVT-1, 3,
6). **4c, the rest**: idempotency keys (GA-APPLY-4, 10), late acks (GA-APPLY-11), reissue after the
bound (GA-APPLY-6) and `whole_state` (GA-APPLY-16). The split follows the seams: 4a is pure over the
model and writes nothing but routes; 4b is the first to publish a command and hold a timer; 4c
adds what needs 4b's outcomes to exist. 4b inherits from 4a the plans held in memory (`plans`, by
`plan_id`, kept 60 s past their expiry for `plan_expired`), `planSteps` and `judge` to re-run at
dispatch with the same snapshot type (`GateDevice`), `tokenFault` with its `used` hook for
GA-TOKEN-4's record, `sets` and `holds` for `acked` (GA-EVT-3), and the harness's `sign`; and two
hazards of one device on two bridges, which 4a's folding leaves for it to
keep: a command goes, and its ack is taken, only through the bridge that carries the device (a
folded copy's bridge is sent nothing and its acks are no one's), and a folded copy's bridge dying
never changes the device's liveness. 4b keeps both. 4c
inherits 4b's held applies and outcome records (`applies`, by `apply_id`, kept 3600 s), the steps
still waiting with their command ids (`waiting`), the step's `kind` and the ack rules in
`src/dispatch/rules.ts`, the attribution windows a `late_ack` extends to 60 s after `failed(no_ack)`,
and the `idempotency_key` that 4b takes and does not yet honour; and the open device's assumed
state (GA-STATE-4), which `whole_state` reads. Slice 5 inherits from 4c the idempotency key's claim (`Dispatcher.claim`
and `release`, the body in RFC 8785 form, held 3600 s and rebuilt at a start), which `provision`'s
own `idempotency_key` (GA-PROV-3) reuses for `install` and `uninstall` too, with its record kept
beside the provisioning request rather than an apply; no late window or reissue, since a
`provision` is no apply.

**Applier 0.14 and bridge 0.5** came after slice 4c, and were reconciled as one plan
before slice 5: extensions on any
device, their tier and idempotency, `confirmed_by`, occurrences and changed declarations, graded as
GA-DESC-1, 3, 4, 14, 18, GA-EVT-3, 5 and 8, with the simulated bridge brought to bridge 0.5.

Slice 2 carries plain adoption because the harness adopts the fixture's devices before every
applier test (`startOnSeam` in [`conformance/harness/src/home.ts`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/src/home.ts)), so no bus test can run without
it. Slice 1 builds what GA-HARN-1, GA-EVT-2 and GA-EVT-5 need (the clock, causes on every change
event, `history`), but their harness tests need devices, so they are graded in the slice that
brings them. Safe comes before restarts so that the restart slice restarts everything, latches,
notices and the heating cap included (HS4's box rebooting mid-leak), and leak protection comes a
slice sooner (the maintainer, 2026-09-28, after the scenario walk).

Slice 6 is planned and built as three plans (the controller's brief, 2026-10-02: each part gives a
working, graded applier). **6a, rules fire and guard**: the rule language and `configure` of safety
rules with their refusals (GA-SAFE-6 but a computer's administrators, GA-SAFE-11's two rules on one
key, GA-SAFE-13's toggling action, GA-EVT-8's event key, GA-ADOPT-1's unadopted device and the
forget of a device a rule names, GA-ADOPT-6's `open_loop` notice for a rule actuating a device on an
`unknown` transport); a rule following its device through `replaces` (GA-ADOPT-2); firing on a new
report, once per trigger becoming true (GA-SAFE-1, 11); dispatch through the dispatcher with cause
`{ safety_rule }`, `refuse(safety)` until complete (GA-SAFE-2, 3), no reissue (GA-SAFE-5); the
completion notice and `rule_fired` (GA-SAFE-8's completion clause); the Safe claim itself, `box`,
the bridges' `ungoverned` and the socket's default load (GA-DESC-6, 8). **6b, it holds**: latches
(GA-SAFE-7, 9, `clear_latch`, the latch over extension actions), GA-SAFE-12's re-sends with
GA-SAFE-8's waiting and `late_ack` notices, the liveness notices (GA-SAFE-10), GA-SAFE-13's rule
disabled on a declaration change, and a rule's args checked against its device's declared args at
`configure`, on a declaration change and at dispatch (M2, 6a's preflight). **6c, loads, witnesses and computers**: the heating cap (GA-LOAD-2,
`max_on_s`), GA-SAFE-13's `load_cap` clauses, witnesses (GA-WIT-1), and GA-SAFE-6's computer
clauses (`os` administrators, `applier_host`). The split follows what each part needs: 6a needs only
the dispatcher as 4c left it; 6b needs 6a's runs to hold and resend; 6c needs neither, but its own
timers on the clock and the PC bridge's administrators.

**Safe is claimed from 6a** (the controller's ruling for this build). A subject that does not claim
Safe answers every Safe change `not_claimed` (GA-LVL-1), so no Safe test could run against it, and
the harness grades only claimed ids; claiming only in 6c would build 6a and 6b ungraded, their
negatives meaningless. So `subject.json` claims Act and Safe from 6a, `graded-ids.json` lists only the
ids built so far, and `pnpm conformance` grades those; the run's report shows the Safe ids not yet
built as `untested`, and the slice is not done until none is. The harness's setup acts as a Safe
owner on a subject claiming Safe: it sets `box`, and adopts each socket with `load: other`, since
one never configured is `heating` (GA-DESC-8), whose tiers no Act test expects. The Safe `configure`
kinds 6a does not build (`max_on_s`, `witness`, `clear_latch`) are `invalid_request` until their part.

6a inherits from slice 4c the dispatcher (`Dispatcher.apply`'s steps, `settle`, the late windows and
reissues), whose held applies now carry a rule's run (`rule_id`, under no client); 6b inherits from
6a the runs (`SafetyRules`, a run's apply and its devices guarded), the last basis seen per key and
each trigger's last reading (`safety_seen`, `safety_state`, migration `0011`), `judgeOwn` for an
actuation at dispatch, the completion notice and `rule_fired`, and the gate's `guarded`; 6c inherits
the Safe claim (`claimsOf`, `box`), the socket's default load (`loadIn`) and the dispatch of the
applier's own actuations under no client, which the cap's turn-off reuses.

**Clauses across a restart.** Several ids of slices 4 to 6 hold "across a restart" (GA-TOKEN-4,
GA-APPLY-4, GA-APPLY-16, GA-DISC-2 and 3, GA-PROV-3, GA-LOAD-2, and the latches, notices and
incomplete rules of GA-PERSIST-1). Their slice writes the item to the store and tests every other
clause, with a `covers` note naming the restart clause as untested; slice 7 adds the restart to those
tests and drops the note. The notes slice 7 takes: GA-APPLY-4 and GA-APPLY-16 (`apply.ts`,
`dispatch.ts`), GA-TOKEN-4 ("graded by the reference applier's unit tests"), GA-SAFE-1 ("a restart's
fire"), GA-SAFE-7, 8, 9, 10, 12 and 13 (the shared `NO_RESTART`), GA-SAFE-11 ("the last seen across a
restart"), GA-LOAD-2 and GA-WIT-1 in `tests/applier/safety.ts`, and the unit tests' file notes
(`latches`, `liveness-notices`, `load-cap`, `load-cap-toggles`, `resend`, `rule-check`, `witness`,
`broker-host`). GA-DISC-2, 3 and GA-PROV-3 are slice 5's, which builds them with their persistence.
Two `covers` notes say "slice 7" for what is an adapter's or a child's (GA-APPLY-7's engine word,
GA-DESC-6's engine and child paths), a numbering from before the slices were fixed; slice 7a words
them as the adapter's and the meta-applier's builds.

Slice 6c holds two things in memory only that slice 7 must keep, since a restart without them breaks
a MUST: the cap's state on each socket ("a turn-off declared `idempotent: false` sent once",
GA-LOAD-2), and a witness's watch (a step dispatched before a restart otherwise gets no verdict,
GA-WIT-1). Slice 6b holds a third: which stops of a rule's device were said (GA-SAFE-10's "is live
again" comes only after one). Two more are seeded at start without a notice, which slice 7 leaves so:
the witnesses' and the rules' bound notices (a restart is no change of the owner's), and the broker's
host's administrators as last judged, which come from the stored device documents, so an
administrator added while the applier was down is said, and only one whose document's write a crash
lost is missed. A bridge's planned deaths for GA-SAFE-10's 10-minute loop also stay in memory: a
reload just before a restart does not count towards a loop, which errs towards one notice fewer, not
one protection fewer.

## Slice 5

Slice 5 builds what *Provisioning* and *Discovery* ask of an applier over bridges: `provision` and
its idempotency key (GA-PROV-1 to 3), the finder, candidates, ignores and `connect` (GA-DISC-1 to 5),
and their persistence, graded across a restart with slice 7a's harness. Left out:
- **`install` and `uninstall`**, deferred to the PC build by the maintainer's ruling on the spec review
  (2026-10-05, its I2). Until that build adds GA-PROV-4, `provision` answers both `invalid_request`
  ("not built in this applier"), as it answers every unbuilt operation today. Routing an `uninstall`
  without GA-PROV-4's refusal (a safety rule naming a plugin device) and its forgetting would send
  what a MUST forbids. So GA-PROV-1's Host clause and GA-PROV-3's install path are the PC build's,
  and this build's tests of those ids carry a `covers` note saying so.
- GA-PROV-4 itself, `tool_hash` and `activate`, which are the PC build's.
- An adapter's and a meta-applier's discovery (`finder: none`, *The meta-applier*), which are their
  builds'.

Classification: architectural. It adds a module (`provision/`), two operations, a configure kind
pair, the finder's topics on the bus, two migrations and two simulated neighbours.

The design passed its spec review (Opus, 2026-10-05: 0 Blocker, 6 Important, 10 Minor) after one
round of fixes, each folded into the text below. The maintainer ruled on the review's I2 and on K1 to K6 the
same day (*Decisions for the maintainer*).

### What exists

Read on `feat/reference-applier-slice-5` (b8ba7d4, main with slice 7a).

| Where | What it has | What slice 5 needs |
|---|---|---|
| The applier's operations | `provision` and `candidates` registered as tools (`TOOLS`, `OWNER_TOOLS`), annotated, and answered `invalid_request` "not built yet" (`NOT_BUILT`) | both built, but `install` and `uninstall` |
| The bus (`bus/client.ts`) | subscribes per bridge to `BRIDGE_TOPICS`, publishes commands and the snapshot request; routes only `{root}/bridges/` | a generic `request(bridge, op, body)`; the finder's three topics |
| Ingest (`bus/wire.ts`, `model/home.ts`) | `parseStatus` drops `levels`, `bridgeType` and each transport's `connections`; `parseDevices` drops each device's `connections`; a `reply` other than a snapshot's is dropped ("the other replies are slice 5's"); an `event` other than `occurrence` is deduplicated by `seq` and left unhandled | the levels and type of each bridge's latest status; the connections, kept apart from the device document (they are no model); replies and provisioning events handed on |
| Bridge liveness (`bus/bridge-rules.ts`) | `BridgeRules`, a pure function of messages and the clock | reused for the finder, which "the applier judges ... as it judges a bridge" |
| Idempotency (`dispatch/dispatcher.ts`) | `Dispatcher.claim` and `release` (slice 4c), keyed per client, a record naming an `apply_id`, loaded from `applies` | the same claim, for the owner's `provision`, its record a request's |
| Configure (`config/configure.ts`) | the `KINDS` table; the stale check before `planChanges`; `modelKey` | `ignore_candidate`, `unignore_candidate`, and GA-CFG-2's exemption |
| Events (`core/events.ts`) | `history` matches a target by an event's `target`, `device` or `devices` (`names`) | a `provision` event's `transport` matched too |
| Notices (`core/notices.ts`) | kept until taken, never dropped | GA-PROV-2's `window_closed` |
| Store | migrations `0001` to `0014`; slice 7b reserves `0015` | `0016` and `0017` |
| Schemas ([`conformance/schemas/applier/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/schemas/applier)) | `provision.request.json` (only `idempotency_key`), `provision.response.json` (any object), `candidates.request.json` (any object), `candidates.response.json`, whose `finder` is an object or null, against the text's `live`, `dead` or `none`; `configure.request.json` requires `expected_revision`, against *Discovery*'s "needs no `expected_revision`" | provisional shapes; the two fixed |
| The simulated bridge ([`conformance/sim`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/sim)) | claims `Serve` only; its control `join` adds a device with a `joined` event (no window); every request but `snapshot` is answered `failed(unsupported)`; `holdRequests` answers nothing; `publishAs` lets a test publish as another bridge | levels, a `bridgeType`, connections, and answers to each provisioning request |
| A simulated finder | none | new |
| The harness's tests | none for any GA-PROV, GA-DISC or GA-FIND id, nor for the bridge's Provision ids; GA-EVT-5's `covers` leaves `provision` to "the slices that raise them"; GA-PERSIST-1's says "ignored_keys, connections and provision records with slice 5" | eight new tests, three extended |
| The Zigbee bridge | claims Serve only: its `joined` admissions are built (GA-BRIDGE-35), but `join`, `join_close`, `remove` and `unblock` are its plan 3, not built; it ships no manifest and sends no `connections` | nothing; no real bridge yet sends `connect`, `connections` or a window |
| The PC bridge | claims Serve and Host: answers `install` and `uninstall`, and ends them in `installed`, `install_failed` and `uninstalled`, each with its `requestId` | nothing in this slice (install deferred); the PC build meets it |

So the applier's side is unbuilt, the harness can grade none of it, and no real bridge yet sends the
provisioning this slice builds. The brief's premise that the Zigbee bridge already implements
provisioning on the bridge's side does not hold: its Provision level is its plan 3.

### The model

**Candidates.** They come only from the finder's retained `{root}/finder/candidates`, `{ publishedAt,
candidates: [...] }`, "the whole list" (bridge, *The finder's topics*). The applier keeps the latest
list it received, live or retained, and nothing else of the finder's: no candidate is stored, since
GA-PERSIST-1 does not list them and the retained topic brings them back. Each entry is parsed per
field: one without an `id`, a `keys` list or a `matches` list is dropped, and logged (the maintainer's ruling
K6). A candidate is known by the finder's `id` while it is listed ("never changed while the
candidate is listed"), and matched to everything else by its `keys`: "Hearings with the same key are
one candidate". It lives as long as the finder lists it; a dead finder's last list stays, "marked
`finder: dead`", and "a candidate on it may still be taken" (*Discovery*). A candidate is never a
device: it is not in the model, and it reaches the model "only through a bridge's `devices` and the
owner's adoption" (GA-DISC-1). A step naming a candidate's `id` names no device, so it is
`skip(unknown_target)`, as GA-PLAN-2 says of every unknown target; that is "nothing is planned on
it" (the backlog asks 0.15 to say so).

**What `candidates` returns.** `{ finder, finder_sources, finder_faults, candidates, ignored_keys }`.
It lists every candidate "that shares no key with `ignored_keys`, nor with the `connections` it last
saw on a device or transport of any bridge registered with this applier, live or dead, kept across a
restart" (GA-DISC-2). Each is the finder's fields in snake case, plus `offers: [{ bridge_type,
connect, bridges }]`, one per match, where `bridges` are "this applier's live bridges whose latest
`status` gives that `bridgeType` and, where the match says `connect`, claims Provision". `finder` is
`none` until any finder message has arrived in this life, then `live` or `dead`; `finder_sources` and
`finder_faults` are the latest status's, the second "with `clock` added while its clock is off";
`ignored_keys` is every key ignored, sorted. Only the owner's credential may call it
(`not_permitted` otherwise), and no event carries a candidate.

**Connections.** Each bridge's latest `connections` per device (from `devices`) and per transport
(from `status`), by the bridge's own ids, kept per registered bridge. A device that leaves its
bridge's `devices` "takes its `connections` with it"; one whose entry was dropped as malformed has
not left (GA-BUS-1: the rest of the message stands, and a dropped entry changes nothing), so its
connections stay; a `status` without a readable `transports` list changes no transport's, as it says
nothing of any transport today. A bridge deleted from the configuration takes all of its. They are no
part of the model: a change of them alone moves no `revision` and raises no `model` event, since
`describe` does not carry them.

**Ignores.** `configure` takes `{ op: "upsert", kind: "ignore_candidate", value: { id } }`, which
adds the listed candidate's `keys` to `ignored_keys`, and `{ op: "upsert", kind:
"unignore_candidate", value: { key } }`, which removes one (provisional value shapes, as every
`configure` kind's; a `delete` of either is `invalid_request`). "An `id` the applier does not list,
or a key not in `ignored_keys`, is `invalid_request`" (GA-DISC-3). They are configuration, committed
with the change set as every owner's change is, but "neither is a model change": `modelKey` leaves
`ignored_keys` out, so they move no `revision`, and "a change set of nothing else needs no
`expected_revision` and never returns `stale_revision`" (GA-CFG-2). So `configure.request.json` makes
`expected_revision` optional, and the applier answers a change set that holds anything else without
it `invalid_request`. A change set that mixes ignores with other kinds is checked as any other.

**A `provision` request's life.** One unit, the provisioner, holds every request from the owner's
call to its end:

1. **Allowed and well formed.** The owner's credential only (GA-PROV-1, `not_permitted` otherwise).
   The body is checked against the provisional `provision.request.json`: exactly one of the
   operations of *Provisioning*, with `idempotency_key` optional and nothing else at the top level (so
   `expected_revision` and `dry_run` are refused, as the text says it takes neither). `install` and
   `uninstall` are `invalid_request`, not built (above).
2. **Keyed.** With an `idempotency_key`, the claim is taken next, before any check of the model (the
   spec review's I1). A key held with the same body is answered from its record, whatever has changed
   since (the bridge may have dropped Provision, the device may have gone), and nothing is sent
   (GA-PROV-3); a key held with another body is `idempotency_conflict`; a key whose request is still
   waiting for its commit or its reply waits for it, then answers from the record. A new claim goes
   on to the checks, and is released if they refuse.
3. **Checked.** Each applier id is resolved to its bridge: `transport` to the bridge and bridge
   transport that hold it; `device` to the bridge that carries it, its route under GA-BUS-11, and its
   bridge device id; `near` likewise, and it must be on the same bridge as `transport`; `identifier`
   with its `bridge`; `connect` as *connect* below says. An id the model does not hold, or a `near` on
   another bridge, is `invalid_request`. Then the level: the bridge's latest `status` must claim
   Provision, else `not_claimed` (GA-PROV-1).
4. **Recorded, then published.** A fresh `requestId` (a random UUID) and the request are committed to
   `provisions` before the publish, keyed or not (the maintainer's ruling K1), so the record GA-PROV-3 keeps
   and the end GA-DISC-4 promises survive a crash. The commit waits as an owner's `configure` does
   (*What waits for its commit*): a caller whose request has not committed within 10 s gets the MCP
   internal error, which means the outcome is not known; the request stays queued, its claim held, and
   is published once its row commits, its reply then recorded, as a `configure` "takes effect when the
   store returns". A repeat under its key meanwhile waits for that commit and that reply (the spec
   review's I4). The request goes to `{root}/bridges/{b}/request/{op}` at QoS 1, not retained, with
   the 10 s Message Expiry of every request, the applier's snake case turned into the bridge's camel
   case (`window_s` to `windowMs` in milliseconds, `block_rejoin`, `accept_unattested`).
5. **Answered.** The bridge's `reply` with that `requestId`, from that bridge's own `reply` topic
   only, within 2 s of the publish, is returned as `{ request_id, op, status, data?, reason? }`.
   No reply within 2 s, or a publish the broker refused (`0x87`, which is also GA-BUS-9's
   `bridge_fault`), or one with no subscriber (`0x10`), or not sent while the broker is away, is
   `{ request_id, op, status: "unreachable" }`: `unreachable` is not one of the standard's error codes,
   and the owner needs the `request_id` to read later events. A publish whose connection closed
   before its PUBACK may have arrived: it waits out its 2 s for a reply.
6. **Ended.** Only an event that carries the `requestId` can end a request after its reply, and of
   the operations built here only `connect`'s do (`connected`, `connect_failed`); `join`,
   `join_close`, `commission`, `remove` and `unblock` end at their reply or `unreachable` (the spec
   review's I3). Their events (`window_closed`, `commissioned`, `commission_failed`, `left`) carry no
   `requestId` in bridge 0.5, so they are relayed as `provision` events and update no record; the
   backlog asks 0.15 whether they should carry it.

**The `provision` event.** Every bridge event in `joined`, `left`, `window_closed`, `commissioned`,
`commission_failed`, `connected`, `connect_failed` and `blocked_rejoin`, taken once by its `seq` as
today, is one `provision` event `{ bridge, what, transport?, devices?, device?, identifier?,
request_id?, reason?, window_s?, cause }`, the bridge's ids turned into the applier's (a device the
bridge names that the model does not hold yet gets the id the id map will give it); `interviewed` is
not one of the applier's kinds and is not relayed, and `installed`, `install_failed` and
`uninstalled` wait for the PC build. Provisional, since the text names neither field (the spec
review's I5):
- `what` names the kind.
- `cause` is `{ provision: request_id }` for an event carrying the `requestId` of a request this
  applier sent; `device` for `joined`, `left` and `blocked_rejoin`, which the hardware did; `bridge`
  for `window_closed`, `commissioned` and `commission_failed`, which report the bridge's own work, and
  for an event carrying a `requestId` this applier does not hold. GA-EVT-2 asks every event reporting
  a change to carry a cause; the backlog asks 0.15 to name these.
- `history` with `targets` matches it by its `devices`, its `device` and its `transport` (`names` in
  `core/events.ts` gains `transport`).

An event carrying a `requestId` updates that request's record; one whose `requestId` the applier
does not hold is relayed all the same, with it.

**`window_closed`.** Besides its event, each closed window is a notice with cause `window_closed`
naming, by the applier's ids, every device the bridge's event names, "kept as a safety notice is"
(GA-PROV-2): `Notices.raise`, never dropped, kept until taken. A window in which nothing joined is a
notice too (the maintainer's ruling K4). A `window_closed` the applier never heard (it was disconnected) is
not recovered: its devices arrive with the next snapshot as GA-BUS-6's `missed_device` notice instead,
which the backlog asks 0.15 to state.

**The key's record** (GA-PROV-3). The owner's keys are claimed through a module of their own,
`core/keys.ts` (`Keys`: `claim`, `release`, `hold` for a loaded key, `prune`), with the semantics of
slice 4c's `Dispatcher.claim` and `release`: `held`, `wait` or `new`, another body
`idempotency_conflict`. Its scope is the owner, apart from every client's; bodies are compared as
their RFC 8785 serialisations without the key; a key is held 3600 s from its first use, and is free
again after that whatever its record says, as GA-PROV-3's "within 3600 s" gives. The record is the
request's row: the reply, or `unreachable`, or, for a `connect`, `accepted` once an event carrying the
`requestId` arrives, each replaced by a later reply or event carrying it.

5a builds `Keys` and uses it for the provisioner only; it does not move the dispatcher onto it, since
slice 7b rewrites the dispatcher's load and prune (the spec review's M9). The dispatcher's claim moves
onto `Keys` in whichever of slice 5 and slice 7b lands second, as one task of that slice's plan, its
tests guarding the move. The expected merge order is 7a, then 7b, then 5; 5a depends on nothing of
7b, and its migration and its prune (`provision/records.ts`, called from the applier's periodic prune)
touch nothing 7b changes.

**`connect`** (*Taking one*, GA-DISC-4), after steps 1 and 2 above, checked in this order:

1. `candidate` must be listed now, or `invalid_request`.
2. `bridge` must be this applier's, its latest `status` must claim Provision and give a `bridgeType`
   that the candidate's `matches` lists with `connect: true`; otherwise `not_claimed`, an unknown
   `bridge` included, by the text's "goes to `bridge` only if it is this applier's ... Otherwise it is
   `not_claimed`" (the spec review's M2).
3. `address` must be given wherever the candidate has one, and equal to the candidate's address in
   the list as it is now (as canonical JSON); and must be absent where the candidate has none (a
   Bluetooth candidate). Otherwise `invalid_request`: "a key announced from elsewhere since cannot
   redirect it" (the spec review's M3).
4. The bridge's `connect` request carries that `address` and the candidate's `keys`, and nothing of
   the owner's; no credential rides on it.

A qualifying bridge that is `dead` is answered `unreachable` at once, after the publish ("with the
`request_id` the applier published, since the bridge may still have the request"); other operations
to a dead bridge wait their 2 s, as GA-PROV-1 says, since only GA-DISC-4 says `unreachable` for a dead
bridge. An accepted or unanswered `connect` waits for its end: if neither `connected` nor
`connect_failed` arrives within 70 s of the publish, "or the bridge dies first", the applier issues
`connect_failed` with reason `lost`, and records it; a `connected` that comes later "is issued
too", and its device arrives unadopted, as every new device does. A bridge already dead at the
publish has not died "first": its `connect` waits its 70 s (the maintainer's ruling K3). A broker loss makes
every bridge dead, and so ends every `connect` in flight `lost`, which is what the text says of "a
`connected` the bridge sent while the applier was disconnected".

### The modules

All in `src/provision/`, each a pure core with its timers on the applier's clock, wired by `Applier`
as the other modules are:

- **`Finder`**: the finder's liveness and its latest status and list. Interface: `message(path,
  payload, retained)`, `tick()`, `lost()`, `refused(reason)`, `view()` (`{ finder, sources, faults,
  candidates }`). Its liveness is a `BridgeRules`, given two switches so it can judge a finder: no
  `bridgeId` to check (below Box "nothing checks `finderId`"), and `graceful: true` alone a planned
  death (a finder's status has no `state`); its skew made readable, for `clock`. A status without a
  known `v` makes it dead, and its faults stay out of every `bridge_fault`, since "with no devices
  behind it, that is not a `bridge_fault`". A finder subscription the broker refuses (a SUBACK below
  QoS 1) is logged and leaves the finder as it was, `none` or `dead`, never `live`, and raises no
  `bridge_fault` (the spec review's M5); it is asked for again on the bus's backoff, as a bridge's.
  Nothing is stored.
- **`Discovery`**: `list(view, connections, ignored, bridges)`, the candidates as GA-DISC-2 lists
  them, a pure function; `listed(id)` for `ignore_candidate` and `connect`. The deletion test keeps
  it: the same filter serves three callers (`candidates`, `configure`'s ignore, `connect`'s check).
- **`Provisioner`**: `provision(args)`, `reply(bridge, body)`, `event(bridge, event)`,
  `bridgeDied(bridge)`, `lost()`, `load()`, `resume()`, `prune()`. It owns `provisions`, the 2 s and
  70 s timers and the owner's claims.
- **`Keys`** (`core/keys.ts`), above.

Elsewhere: `wire.ts` parses `levels`, `bridgeType` and each `connections`; `Home` holds a bridge's
latest levels and type, and its connections apart from each device's document, hands a non-snapshot
`reply` and each provisioning event to hooks, and tells of a bridge's death as it does today; the bus
subscribes to `{root}/finder/status`, `lwt` and `candidates` on every connection, with the bridges'
options and SUBACK check, and gains `request(bridge, op, body)`, which the snapshot uses too;
`configure.ts` gains the two kinds and the exemption.

### The store

- **`0016_provisioning.sql`** (5a): `provisions (request_id PRIMARY KEY, op, bridge, idempotency_key,
  body, result, created_ms, ends_ms, ended)`, with a unique index on `idempotency_key`. A keyed
  request whose key's last use is past its 3600 s deletes that row in the write set that inserts the
  new one, so a key names one row (the spec review's I4); the claim in memory keeps two from being
  pending at once. A row is written before its publish (*A `provision` request's life*, step 4). Its
  result is updated behind, never dropped. Rows are pruned 3600 s after `created_ms`, never before
  their end.
- **`0017_discovery.sql`** (5b): `ignored_keys (key PRIMARY KEY)`, written in the `configure`
  transaction; `connections (bridge, kind, entity, keys, PRIMARY KEY (bridge, kind, entity))`, `kind`
  being `device` or `transport`, written behind in the same write set as the bridge's facts, and
  droppable at the writer's cap as those are (the maintainer's ruling K5).

Slice 7b reserves `0015`. The runner applies every file it has not recorded, in name order, so the
two slices' files do not collide whichever merges first; neither edits an applied file.

### Restarts

What is kept, from the text: "idempotency keys for their retention, with ... the `requestId` and
result of a `provision`", "`ignored_keys` and the `connections` last seen on each bridge"
(*Restarts*, GA-PERSIST-1); and GA-DISC-3's ignore "across restarts of the applier and the finder".
What is not: the finder's state and list (retained, sent again on subscribing), and a request's 2 s
wait (the caller's call ended with the process).

- `load` reads `provisions` (the keys into `Keys`, the `connect`s not ended), `ignored_keys` and
  `connections`; `resume` judges. A candidate sharing a key with a stored connection stays hidden
  from the start, before any bridge's documents arrive, "so a held device is not offered as new while
  the bridges' retained documents load" (GA-DISC-2).
- **A request whose reply had not come** is `unreachable` in its record, as the caller was told or
  would have been. A later reply or event carrying its `requestId` replaces it, as before.
- **A request committed and not yet published** at a crash (its caller given the internal error):
  it was never sent, and the restart does not send it; its record says `unreachable`, so the owner who
  repeats it under its key learns that it may not have arrived and, by the text, sends a new key to
  try again.
- **A `connect` in flight at a stop** ends `connect_failed(lost)` at the resume, issued then and
  recorded, the applier having been disconnected (the maintainer's ruling K2). A `connected` arriving after it
  is issued too, as after any `lost`.
- **The same command, the same id** (the maintainer's ruling 2, 2026-10-05). A provisioning request is sent
  at most once: its `requestId` is minted once and committed with the request before its only
  publish; the applier never re-sends a request on its own (there is no reissue, and a restart re-arms
  no publish); a repeat under the key is answered from the record. So a request never goes out twice
  under two ids, and needs no derived id. A repeat without a key is, by the text, "a new request each
  time", and gets a new id, as GA-SAFE-12's deliberate re-send gets a new command.

### The simulated neighbours

- **The simulated bridge** gains, all through its options and in-process methods: `levels` (default
  `Serve`, so every existing test is unchanged) and `bridgeType`; `connections` on a fixture device
  and on its transport; and an answer for each provisioning request, scripted per op with a default:
  `join` `accepted` and a window that `join_close`, or its `windowMs`, closes with `window_closed`
  naming every device the control `join` added in it and the effective `windowMs`; `join_close`,
  `unblock` `ok`; `remove` `accepted` then `left` (carrying no `requestId`, as bridge 0.5's does);
  `commission` `accepted` then `commission_failed(unsupported)`; `connect` `accepted` then, as
  scripted, `connected` naming a new device whose `connections` are the candidate's keys, `devices`
  published first (GA-BRIDGE-40), or `connect_failed`, or nothing; and `dropReply(op)`, which drops
  the next reply of that op. A request repeated by `requestId` within 10 s gets the first reply
  (GA-BRIDGE-4), and every request is in `requests`, so a test counts what reached the bridge.
- **The simulated finder** ([`conformance/sim/src/finder/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/sim/src/finder)): connects as the finder, its will on
  `{root}/finder/lwt`; publishes `status` every 10 s on the harness's clock, with `testRunId`, and
  `candidates` retained; a test sets its sources, faults and candidates, skews its clock, drops `v`,
  silences it, kills it (the will), stops it gracefully, and restarts it with a new `instanceId`.
  A test opts in with `fixture.finder: true`, which puts it on `ctx.finder`.
- **Other bridges** a test needs (a dead bridge holding a key, a bridge of the wrong type, one
  without Provision) are played by `publishAs`, as GA-BUS-11's test plays its second bridge: a
  retained `status` and `devices`, never live.

### The harness's tests

Each id's test grades the text, so a subject that keeps more or loses less still passes, and each
restart clause sits in one id's test. Each test that moves the harness's clock names its `chunkMs`
(the time server's default chunk is 20 s): 5000 wherever a bridge must stay live through the advance,
since the simulated bridge's status every 10 s must land inside the 30 s death window.

- **GA-PROV-1**: a client's `provision` is `not_permitted`; `join` on the sim's transport reaches
  that bridge as `request/join` with `windowMs`, and returns its reply with a `request_id`;
  `not_claimed` against a bridge whose status lacks Provision; a held reply is `unreachable` 2 s after
  the publish (no clock step: the 2 s passes on the clock as it runs). 5b adds `connect`'s named
  bridge. `covers` leaves the Host clause (`install`, `uninstall`) to the PC build.
- **GA-PROV-2**: a window opened, a device joined in it, `join_close`; a `window_closed` notice naming
  the device's applier id, still listed until taken. An empty window's notice is K4's, not the text's
  plain reading, so it is not graded.
- **GA-PROV-3**: a `remove` keyed, its reply dropped, repeated with its key after the bridge's 10 s
  window (the standard's subject, `provisions-twice`, written for an `install`; the mutation is the
  same, the operation the one this build has): the first answered `unreachable` with its
  `request_id`, the repeat answered from the record with the same `request_id`, and the bridge's
  `requests` holding one `remove`. A second key, answered `accepted`, repeated after the simulated
  bridge stops claiming Provision: still answered `accepted` from its record, nothing sent (the spec
  review's I1). Another body under a held key is `idempotency_conflict`, nothing sent. Across a clean
  restart, and across a crash (`restartApplier({ crash: true })`, the record having committed before
  its publish), each repeat is still answered from its record, nothing sent (the spec review's M7).
- **GA-EVT-5**, extended: a `joined` `provision` event in `history` with its cause, with `targets`
  naming the joined device and without.
- **GA-PERSIST-1**, its `covers` reworded: "ignored_keys and connections are graded under GA-DISC-3
  and GA-DISC-2, a provision's record under GA-PROV-3, a connect in flight under GA-DISC-4".
- **GA-DISC-1**: the finder announces a candidate whose keys match no device; `describe` has no
  device of it, and a client's `plan` naming its `id` gives `skip(unknown_target)`, never `op`.
- **GA-DISC-2**: a steward's `candidates` is `not_permitted`; `finder_sources` shows a source `off`;
  candidates sharing a key with the live bridge's device, with its transport, and with a dead bridge's
  device are hidden, the others listed with their `offers` (the live Provision bridge of the type,
  and not the dead one); nothing of a candidate appears in `events`; across a restart whose `between`
  clears the dead bridge's retained `devices`, the held candidate stays hidden.
- **GA-DISC-3**: ignoring a listed candidate hides it and every candidate sharing a key, after the
  finder moves its address and after the finder's restart gives it a new `id`, and across a restart
  of the applier; `ignored_keys` holds its keys; `revision` unmoved and no `model` event; an `id` not
  listed and a key not ignored are `invalid_request`; `unignore_candidate` lists it again.
- **GA-CFG-2**, extended: a change set of only ignores at a stale `expected_revision`, and with none,
  is applied; any other change without one is `invalid_request`.
- **GA-DISC-4**, `chunkMs` 5000: `not_claimed` for an unknown bridge, a bridge of the wrong type, one
  whose match says `connect: false`, and one without Provision; `invalid_request` for an id not
  listed, a missing address, an address the finder moved since, and an address on a candidate that
  has none; `unreachable` with a `request_id` for a qualifying dead bridge; the bridge's request
  carries the owner's address and the candidate's keys; `connected` carries the `request_id` and
  names a new unadopted device. **The 70 s clause** (the spec review's I6): the simulated bridge
  scripted to answer `accepted` and then nothing, and kept live through the advance (its statuses
  every 10 s of the stepped clock; the test asserts no `liveness` event for its devices meanwhile, so
  a death cannot be what ends it); the clock advanced 65 s, no `connect_failed`; then to 70 s plus one
  chunk, exactly one `connect_failed(lost)` with the `request_id`; a later `connected` issued too.
  **The death clause**, separate: a second `connect`, its bridge's death (the simulated bridge killed,
  its will), `connect_failed(lost)` within 1 s of the death. **Across a restart**: a `connect` in
  flight, the applier restarted, the clock past 70 s from the publish: exactly one
  `connect_failed(lost)` carrying its `request_id`, whichever way K2 had been ruled.
- **GA-DISC-5**, `chunkMs` 5000: `live` on a live status, `dead` 30 s after the last, at once on a
  will naming the latest `instanceId` (one naming another ignored) and on a graceful status; a status
  without `v` makes it dead; a `publishedAt` skewed by 60 s or more gives `clock` in `finder_faults`
  (asserted present while skewed, never asserted absent after a clock advance, since an advance may
  itself read as skew); a dead finder's list still shown, `finder: dead`; across a restart of the
  applier with the finder silenced first, its retained status does not make it `live`.

### Mutations and the matrix

| Mutation | Breaks | Row | Part |
|---|---|---|---|
| `provisions-for-anyone` | GA-PROV-1 | the standard's | 5a |
| `hides-new-devices` | GA-PROV-2 | the standard's | 5a |
| `provisions-twice` | GA-PROV-3 | the standard's (graded with a keyed `remove`) | 5a |
| `forgets-a-provision-key` | GA-PROV-3 | proposed: a keyed request repeated after a restart reaches the bridge again | 5a |
| `plans-on-a-candidate` | GA-DISC-1 | the standard's | 5b |
| `shows-candidates-to-a-client` | GA-DISC-2 | the standard's | 5b |
| `hides-the-finders-sources` | GA-DISC-2 | the standard's | 5b |
| `lists-a-held-candidate` | GA-DISC-2 | the standard's | 5b |
| `forgets-connections` | GA-DISC-2 | proposed: the connections are not read back, so a candidate a dead bridge holds is listed after a restart | 5b |
| `forgets-an-ignore` | GA-DISC-3 | the standard's (the restart, as the row says) | 5b |
| `ignore-moves-the-revision` | GA-DISC-3 | proposed: an ignore moves `revision` | 5b |
| `checks-revision-for-ignores` | GA-CFG-2 | proposed: an ignore-only set at a stale revision is `stale_revision` | 5b |
| `connects-to-the-wrong-bridge` | GA-DISC-4 (may also GA-PROV-1) | the standard's | 5b |
| `event-without-request-id` | GA-DISC-4 | the standard's | 5b |
| `never-ends-a-connect` | GA-DISC-4 | the standard's | 5b |
| `ignores-the-address` | GA-DISC-4 | the standard's | 5b |
| `forgets-a-connect` | GA-DISC-4 | proposed: a `connect` in flight at a restart never ends | 5b |
| `trusts-a-dead-finder` | GA-DISC-5 | the standard's | 5b |

Thirteen are the standard's rows and go into `subject.json`; five are proposed for applier 0.15 and
graded through `proposed-rows.json` meanwhile (the maintainer's ruling 6). Eighteen runs join the matrix, four
with 5a and fourteen with 5b. Five tests restart the subject (GA-PROV-3 twice, GA-DISC-2, 3, 4, 5),
about 5 s each.

### Approaches

- **A. A `provision/` module of three units, wired by `Applier`, the finder judged by `BridgeRules`
  and the owner's keys through `core/keys.ts`** (chosen). Each unit owns one concern and its rows; a
  new provisioning kind is one change in the provisioner; the bridge's rules are reused, not copied.
- **B. Everything in `Home`**, which already ingests every bridge topic. Rejected: `Home` is the
  largest file in the build, and the finder, the requests and the owner's keys are not the model's.
- **C. The finder as a registered bridge**, through `BridgeView`, so its liveness and ingest come
  free. Rejected: it has no devices and no `bridgeId`, its topics are elsewhere, it is not configured,
  and every bridge rule would gain a finder exception.

For the key: sharing `Dispatcher.claim` by a reserved client was weighed and rejected, since the
dispatcher's keys are loaded from `applies` and named by an `apply_id`; a provisioning record is
neither.

### The split

Two plans, each a working, graded applier:

- **5a, provisioning**: the
  levels and type parsed; `Bus.request`; replies and provisioning events handed on; `Keys`; the
  provisioner but `connect`; `0016`; the `provision` event, its cause and history targets, and
  GA-PROV-2's notice; the simulated bridge's levels and answers; GA-PROV-1 (but `connect` and Host),
  GA-PROV-2, GA-PROV-3 with its restarts, GA-EVT-5's `provision`, GA-PERSIST-1's `covers`; four
  mutations.
- **5b, discovery**: the finder's
  topics, `Finder`, `Discovery`, the connections parsed and kept, `0017`, `candidates`, the ignores
  with GA-CFG-2's exemption and the schema fix, `connect` with its 70 s and its restart; the simulated
  finder and the simulated bridge's connections and `connect`; GA-DISC-1 to 5, GA-CFG-2's exemption,
  GA-PROV-1's `connect` clause; fourteen mutations.

5b needs 5a's provisioner; 5a needs nothing of 5b, nor of 7b. The seam is the finder: 5a sends what
the owner names, 5b adds what the finder heard.

### Decisions for the maintainer

The maintainer ruled on 2026-10-05: each of K1 to K6 as proposed, and the spec review's I2 (`install` and
`uninstall` deferred to the PC build), which made K7 moot.

- **K1. Every provisioning request is committed before its publish**, keyed or not, so GA-PROV-3's
  record and GA-DISC-4's end survive a crash; `provision` then fails with the internal error while
  the store is down. Not chosen: only a keyed request waits.
- **K2. A `connect` in flight at a restart ends `connect_failed(lost)` at the resume.** Not chosen:
  it waits out its 70 s.
- **K3. A `connect` to a bridge already `dead` at the publish waits its 70 s.** Not chosen: it ends
  `lost` at once.
- **K4. A closed window in which nothing joined is a `window_closed` notice too.** Not chosen: a
  notice only when a device joined.
- **K5. The connections are written behind, droppable at the writer's cap.** Not chosen: never
  dropped.
- **K6. A malformed candidate entry is dropped and logged**, and `finder_faults` stays as the text
  defines it. Not chosen: a code of the applier's own in `finder_faults`.
- **K7** (moot): `install`'s `host`; it returns with the PC build.

### Standards fixes this slice shows, for applier 0.15

Kept in the maintainers' backlog for the next revision:

- The `provision` request's and response's shapes, and `candidates`'s request: the schemas are
  skeletal; this build writes provisional ones. The response carries a `request_id` for every
  operation, and `unreachable` as a `status`, since it is not an error code.
- `candidates.response.json`'s `finder` is an object or null; the text says `live`, `dead` or `none`.
- `configure.request.json` requires `expected_revision`; GA-CFG-2 and *Discovery* say an ignore-only
  set needs none.
- The `provision` event's fields: the field naming its kind (`what` here), its cause, and which
  fields `history`'s `targets` match.
- The value shapes of `ignore_candidate` and `unignore_candidate`, and which `op` they take.
- The finder's `status` and `candidates` have no schema under [`conformance/schemas/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/schemas).
- Say that a provisioning request's record exists before its publish (K1), as GA-TOKEN-4 says a
  token's use precedes its dispatch, and what a `connect` in flight at a restart becomes (K2), and at a
  bridge dead at its publish (K3).
- Whether a window in which nothing joined is a notice (K4).
- `commissioned`, `commission_failed`, `window_closed` and `left` carry no `requestId`, so a keyed
  `commission`, `join` or `remove` is recorded only from its reply, and the owner cannot tie a
  `commissioned` to the request that asked for it. Say whether they should carry it.
- GA-DISC-1's "nothing is planned on it" against GA-PLAN-2's "an unknown target is
  `skip(unknown_target)`": say that a step naming a candidate is that skip.
- A `window_closed` the applier did not hear (disconnected) is not recovered: its devices come with
  the snapshot under GA-BUS-6's `missed_device`, not GA-PROV-2's `window_closed`. Say so.
- The proposed rows: `forgets-a-provision-key`, `forgets-connections`, `ignore-moves-the-revision`,
  `checks-revision-for-ignores`, `forgets-a-connect`; and that `provisions-twice`'s subject could name
  any keyed operation, not only `install`.

### Open questions

- No real bridge yet sends `connect`, `connections`, a `bridgeType` or a join window: the Zigbee
  bridge's Provision is its plan 3, and no manifest-shipping bridge exists. This slice is graded on the
  simulated bridge alone; the first real check is the Zigbee bridge's plan 3 against this applier.

## Slice 7

Slice 7 grades what *Restarts* asks of an applier: "An applier MUST keep across a restart: its
configuration; idempotency keys for their retention, with the outcomes ...; used token ids; held
latches; unacknowledged notices; the wall-clock time each heating load was first reported `on`, so
that downtime counts towards its cap; and each `feedback: open` device's assumed state; a safety rule
not yet complete, which resumes waiting for its final outcomes and then issues its notice; pending ack
deadlines; each held apply's outcomes; the id map, retired identifiers and each device's adoption
state; ... the last `basis_time` seen for each key a safety rule reads". "Plans need not survive;
applying one that did not is `unknown_plan`." The harness "restarts the subject through a hook the
subject's packaging provides"; here that hook is the subject's process, which the harness already
owns (`SubjectProcess` in [`conformance/harness/src/subject.ts`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/src/subject.ts): start, `restart` with a `between`
run while it is down, `crash`, `stop`).

**What the code already does** (read on main dfdfeab, the audit below). Most of slice 7 was built by
the slices before it: each wrote its item, and `Applier.start` already reads each back, module by
module (`loadConfig`, `Home.load`, `Notices.load`, `EventLog.load`, `Dispatcher.load`,
`SafetyRules.load`, `LoadCaps.load`), with unit tests of several across a restart on one database
(`dispatch.test.ts`, `notices.test.ts`, `applier.test.ts`, `safety.test.ts`). No harness test
restarts the applier yet. Reading the start found three defects and four gaps, and the spec review a
fourth defect:

- **A rule incomplete for over an hour is lost at a restart.** `pruneRecords` deletes every `applies`
  row past `HELD_MS` (3600 s), and `loadRecords` reads none older, while memory holds a running rule's
  run past its hour (`Dispatcher.prune`; slice 6b: "a rule's run is held past the dispatcher's hour
  while it runs"). A leak
  rule whose valve stays dead for two hours, then a reboot: `SafetyRules.load` finds no run, so the
  valve is no longer guarded (GA-SAFE-2), the close is never sent on its return (GA-SAFE-12), and no
  completion notice comes (*Restarts*: "resumes waiting for its final outcomes and then issues its
  notice"). A cap's run can outlive its hour too: each attempt is its own run, in flight for its
  turn-off's `ack_within_s`, which `configure.ack_within_s.json` does not bound, and the dispatcher's
  `running` port spares only a rule's run (`SafetyRules.runs`).
- **A resumed run starts its attempts again at 1.** `SafetyRules.load` rebuilds each actuation as
  `{ attempt: 1, began: now }`, so the next re-send reuses a step id an earlier attempt's `outcome`
  event already carried (`s1.2`); an `unanswered` idempotent actuation already sent once more is sent
  once more again; a `late_ack` that landed one is forgotten; and the waiting notice, whose text is not
  remembered (`waitSaid`), is withdrawn and raised again at every restart.
- **The start's hooks run before their modules have loaded.** `Dispatcher.load` settles a step it finds
  `dispatched` with no waiting row as `failed(no_ack)` at once, and that settle calls `stepEnded`,
  `capEnded` and `ended` while `SafetyRules` and `LoadCaps` hold nothing yet: the rule then judges the
  outcome from the stored run, but a cap kept in flight (once slice 7 keeps caps) would never hear it.
- The four gaps: the cap's state, the witnesses' watches, the said stops, and the clock's last reading
  behind each on-time (*Time across a restart*).
- And one the spec review found: **a crash just after a rule fires can leave its latch without its
  run.** A firing hands the writer, one after another, the seen rows (`SafetyRules.reported`), the
  trigger's state (`keepState`), the latch (`Latches.set`), the run (`Dispatcher.actuate`'s `save`),
  its first waiting row and the state naming the run. The writer keeps their order, so a crash loses a
  suffix: the seen rows, the trigger and the latch can be kept and the run lost. After the restart the
  latch is held, the report that fired is no new report, and the trigger reads true, so the rule never
  fires again and no run completes: clients are `refuse(latched)` with the valve's close never
  confirmed, and no completion notice ever comes (*Restarts*: "a safety rule not yet complete, which
  resumes waiting for its final outcomes and then issues its notice"). Fixed in *A rule fired just
  before a crash*.

**The audit.** Every durable item of GA-PERSIST-1 this build owns, where it is written and how, what
the start does with it, and the harness test that shows it across a real restart. "Waits" is *What
waits for its commit*; "behind" is the writer's line.

| Item | Where (migration) | Written | Read at start | Missing | Shown by |
|---|---|---|---|---|---|
| Configuration: clients, bridges, `time_source`, `box`, declarations, rules (with `disabled`), witnesses, routes | `clients`, `bridges`, `meta`, `declarations`, `safety_rules`, `routes` (0001, 0003, 0005, 0011, 0012) | waits (an owner's change); a rule's disable behind | `loadConfig`, then every rule checked again (`disableRules`) | nothing | GA-PERSIST-1 (7a); GA-SAFE-13's disabled rule (7b) |
| The id map, minted ids and folded copies | `devices` (0002, 0005) | behind (a bridge's facts); waits (a route, an adoption) | `Home.load` | nothing | GA-PERSIST-1 (7a) |
| Retired identifiers | `previous_identifiers` (0004) | waits (a replacement) | `loadConfig` | nothing | GA-PERSIST-1 (7a) |
| Adoption state and its class | `adoptions` (0002) | waits | `loadConfig` | nothing | GA-PERSIST-1 (7a) |
| Idempotency keys with their outcomes | `applies.idempotency_key`, `body` (0007) | waits, before the first step | `Dispatcher.load` | nothing | GA-APPLY-4 (7a) |
| Each held apply's outcomes | `applies.outcomes` (0006) | the apply waits; later outcomes behind | `Dispatcher.load` | a running rule's or cap's run past 3600 s (above) | GA-PERSIST-1 (7a); GA-SAFE-12 (7b) |
| Used tokens | `used_tokens` (0006) | waits, before the dispatch | `Dispatcher.load` | nothing | GA-TOKEN-4 (7a), across a crash with a stalled store too |
| Ack deadlines | `waiting.deadline_ms` (0006) | behind, handed before the publish | `Dispatcher.load`, each armed again | the hooks' order (above) | GA-PERSIST-1 (7a) |
| Late windows (GA-APPLY-11's 60 s) | `late` (0008) | behind | `Dispatcher.load` | nothing | GA-PERSIST-1 (7a) |
| Assumed states, in dispatch order | `assumed` (0009) and each waiting row's frame | behind, with the outcome | `Dispatcher.load` | nothing | GA-APPLY-16 (7a) |
| The event log, `last_seq`, `revision`, the clean-stop marker | `events`, `meta` (0001) | behind; the marker at a clean close | `EventLog.load`, `Applier.start` | nothing | GA-EVT-4 (7a), across a crash with a stalled store (a plain crash without a database) |
| Unacknowledged notices and standing keys | `notices` (0003) | behind | `Notices.load` | nothing | GA-SAFE-8 (7b) |
| Held latches, and the keys kept after a clear | `safety_latches`, `safety_raised` (0013) | behind | `Latches.load` | nothing | GA-SAFE-7 (7b) |
| The last `basis_time` per safety-read key | `safety_seen` (0011) | behind; a rule's seed behind its `configure` | `SafetyRules.load` | the seed's commit (the backlog's item) | GA-SAFE-11, GA-SAFE-1 (7b) |
| Incomplete safety rules | `safety_state` (0011) and the run | behind | `SafetyRules.load` | each actuation's attempt, `again`, `late`, `why`, and `waitSaid`; the run past 3600 s | GA-SAFE-12 (7b) |
| Heating on-times | `load_on` (0014) | behind | `LoadCaps.load` | the clock's last reading | GA-LOAD-2 (7b) |
| The cap's state per socket | none (memory) | | | all | GA-LOAD-2 (7b) |
| Witness watches | none (memory) | | | all | GA-WIT-1 (7b) |
| A firing's records together | separate write sets (`reported`, `keepState`, `Latches.set`, `actuate`) | behind | as above | one write set | GA-SAFE-3 (7b), across a crash with a stalled store |
| The stops said of a rule's devices | none (memory) | | | all | GA-SAFE-10 (7b) |

Left as they are, by the slices that made them: a reissue held for an idempotent step ends at a
restart (slice 4c: "nothing about them is kept, so a restart ends them"), which GA-APPLY-6 allows:
it limits reissues and requires none; plans are not kept (`unknown_plan`); `events` older than the window
and history pruned; and slice 5's `ignored_keys`, `connections` and `provision` records, with slice 5.

**Approaches.** Three ways to bring the applier back:

- **A. Each module reads its own rows, in two phases** (chosen). The shape the code already has,
  with one change: `load` reads rows into memory and does nothing else (no outcome settled, no
  notice, no event, no timer), every module in dependency order (the configuration and the model;
  notices; the event log; the dispatcher; the rules, with their latches and runs; the caps; the
  witnesses); then `resume`, in the same order, judges what is due: the dispatcher settles the
  steps it found orphaned and arms each deadline, the rules re-judge each resumed run, the caps arm
  their re-sends, the witnesses arm their watches or judge those due; then what `Applier.start` does
  after the loads today (`disableRules`, GA-ADOPT-3's once, the broker host's check, the bound
  notices seeded, the revision's jump) runs as the applier's own resume. `EventLog.load` keeps its
  own write of `last_seq` and the marker, which must land before anything is served. Each module
  keeps owning its tables, so a new durable item is one module's change, and the hooks of one module
  never reach another that has not loaded. The split of every module that exists is 7a's (the
  dispatcher, the rules, the caps, the witnesses' seeding, the applier's tail), a refactor that keeps
  every behaviour and closes defect 3; 7b only adds Safe's new rows to the loads and their judging to
  the resumes. The other defects are each fixed in the module that has them.
- **B. One start-up reconciliation pass.** A single function reads every table and hands each module
  its state. It would make the order visible in one place, but it duplicates what each module knows
  of its rows, and every new item touches it and its module. Rejected: A's two phases give the same
  ordering with less coupling.
- **C. Rebuilding from the event log.** Rejected: the log is not a record of state. Its rows are
  written behind and dropped past the writer's cap (*Before anything else is written behind*),
  `history` is pruned after 7 days while a latch or an on-time can be older, and much of the state
  (an assumed value's dispatch order, a token's deadline, a cap's attempt) is in no event.

**Kinds of restart.** Each test grades only what the standard's text says, so a subject that keeps
more, or loses less, than this build still passes; the reference's own policy (every cursor
`cursor_expired` after a crash, the 10 s internal error of *What waits for its commit*, `revision`'s
jump after an unclean stop) is shown by the applier's unit tests, not graded. The harness gives three
kinds, through `SubjectProcess` and a new applier-seam helper, `restartApplier(ctx, { kind,
between })`, which reconnects the owner's and the client's seams to the same port and asks the
simulated bridge for a live status until the fixture's devices are live again, as the setup does (a
retained status never revives a bridge, GA-BUS-8):

- **A clean stop** (SIGTERM, `SubjectProcess.restart`). The kind every item test uses: *Restarts*
  says what an applier keeps "across a restart", and a clean stop is one. It proves each item read
  back (the audit's last column).
- **A crash** (SIGKILL). `SubjectProcess.restart` gains an option, `restart(between?, { crash: true })`,
  which kills where it would stop, and runs `between` while the subject is down in both kinds;
  `crash()`, a kill with no start after it, stays as it is. Used only where a subject has no store the
  harness can stall (below), by GA-EVT-4's test, whose check holds whatever was lost.
- **A crash with write sets in the backlog**, for a subject whose `subject.json` says `database: true`
  only. The harness stalls the subject's store with a lock on its schema's tables (all, or the ones a
  test names) from its admin session (a new `stallStore(ctx, tables?)`; the writer's statements time
  out after 5 s, a failure that passes, and are retried), then SIGKILLs the subject, releases the lock
  and starts it again. A role made `NOLOGIN` would not do: a refused login is class `28`, a fault,
  which stops the applier. It is the only kind that loses writes, so it grades what the text says of
  loss: GA-TOKEN-4's "dispatched at most once" (one physical actuation of a token across the stall, the
  crash and the restart, whatever the apply in the stall answered), GA-EVT-4's events (a cursor of the
  last life reads every event it was served after it, or is `cursor_expired`), and GA-SAFE-3's rule
  fired just before the crash, which completes. It asks nothing written behind to survive, since
  nothing must: the maintainer accepted on 2026-09-29 that "a restart while the store is down loses
  the writer's backlog".

**Work in flight at the stop**, each from the standard's text, and a ruling where the text picks none:

- **A step waiting on an ack.** Its deadline is kept ("pending ack deadlines"), on the applier's clock.
  A bound not yet passed at the start is waited for; the step's bridge is dead until heard, and "a
  step that waited across the restart waits for its bound" (slice 4b). A report that matches it,
  retained ones included, acks it: *Outcomes* asks that "the device's own reported state now
  matches". A bound that passed while the applier was down is `failed(no_ack)` at the resume, as soon
  as the applier can say anything; GA-APPLY-8's "reported within 1 s after" cannot hold across a
  downtime, which this build accepts and the backlog names for 0.15. The late window then opens, kept
  in `late`, and a matching report within its 60 s is a `late_ack` with the apply as its cause
  (GA-APPLY-11), whether the report was made during the downtime or after.
- **A step with no waiting row and no final outcome** (its row's write lost, or a later step of a run
  never sent): `failed(no_ack)` at the resume, as slice 4b rules for an apply. For a rule's run or a
  cap's, this is GA-SAFE-12's "may have run": sent again only if idempotent. The build cannot tell a
  step whose publish's row was lost from one never published, since both rows are written behind
  and only their order is kept; the safe reading of GA-SAFE-5 ("issues each non-idempotent actuation
  once") is that it may have run (ruled by the maintainer, 2026-10-05, *Decisions*).
- **A safety rule's run, part-sent.** Its run, and each actuation's state (attempt, whether an
  `unanswered` one was sent once more, a `late_ack`, why it is not sent again, and what the waiting
  notice said), are kept in `safety_state`, so the resumed run numbers its attempts on, never reuses a
  step id, and raises no waiting notice it already raised. It "resumes waiting for its final outcomes
  and then issues its notice": its devices are guarded until then (GA-SAFE-2), an actuation waiting for
  a re-send is sent at once on its device's return from `dead` (GA-SAFE-12), and its completion notice
  and `rule_fired` follow (GA-SAFE-8). A running rule's run, and a cap's, are never pruned from the
  store, nor left unread at a start, while it runs.
- **A rule fired just before a crash.** The firing's records (the seen rows of the report, the
  trigger's state, the latch, the run with its first waiting row, and the state naming the run) go to
  the writer as **one write set**: `Store.group(fn)` gathers every write set handed during the
  synchronous `fn` (here `SafetyRules.reported`, which runs the firing) into one, in order, never
  dropped at the cap if any part may not be. A crash then keeps all of it (the run resumes) or none (no
  latch, no seen basis, the trigger false, so the report delivered again at the start is new and fires
  the rule again). Chosen over the other way, a resume that fires again a held latch whose run is
  missing, which cannot tell a run lost from one completed without more state, while every statement
  the group joins is already an upsert or a `GREATEST`, so the joined set is still safe to run twice.
  The cap's beginning (7b's cap row and its run) is grouped the same way. Firing again after such a
  crash sends the same command with the same `commandId` (the next item), so a bridge that still
  remembers it does nothing more; only past the bridge's memory can a non-idempotent actuation run
  twice, the cost the maintainer accepted with ruling 2 (*Decisions*).
- **The same command, the same id** (the maintainer's ruling 2, 2026-10-05: "the same command MUST produce
  the same id"). The bridge standard's `commandId` is "a UUID, unique per command" (the bridge
  schema's `uuid` format), and GA-BRIDGE-4's bridge "remembers each `commandId` for at least
  `resultWithinMs`: a repeated one returns the first ack, or, while the first is still running,
  nothing more, and does nothing". Today every `commandId` is a fresh `randomUUID()`, so a command
  sent again after a crash that lost its record is a new command to the bridge. Slice 7 derives it
  instead, as a name-based UUID (RFC 9562 version 5, SHA-1, which keeps the UUID format and length
  whatever the name's length) in a namespace of the install's own, a random UUID kept in `meta`
  (`command_namespace`) and committed before the first command:
  - a rule's run's `apply_id` from the rule, the device and `basis_time` of the report that made its
    trigger true (`rule/<rule_id>/<device>/<basis_time>`); a rule fires at most once on one report,
    GA-SAFE-11's seen basis making it so;
  - a cap's run's `apply_id` from the socket, its on-time's start and the attempt
    (`cap/<device>/<since_ms>/<attempt>`);
  - every step's `commandId` from its run and its step id (`<apply_id>/<step_id>`), the step id
    carrying a re-sent actuation's attempt (`s1.2`), so GA-SAFE-12's deliberate re-send is a new
    command with a new id, and the first attempt's resend after a crash is the same command;
  - a held reissue's (GA-BUS-4) from the command it reissues and its count
    (`<command_id>/reissue/<n>`), a new command as the standard asks ("a reissue after the bound uses
    a fresh `command_id`").
  A client's apply follows the same rule at no cost, its `apply_id` random but committed before its
  dispatch, so its steps' ids are derived the same way; nothing in this build sends a client's step
  again after a restart, so this changes nothing a client sees today, and the principle goes to the
  backlog for applier 0.15. Distinct commands keep distinct ids: they differ in run or step id, and
  each run's name differs by its cause. The bridge's memory is only at least `resultWithinMs` from
  the first receipt: a restart slower than that may run the command again, as ruling 1's classes
  then say.
- **A cap's turn-off, due during the downtime.** Each socket's cap is kept in `load_caps` (attempt,
  when it began, `flight`, `wait` or `done`, its run, what stopped it, what its notice said), written
  behind with each change. A cap's run is spared like a rule's: the `running` port answers for a run a
  kept cap names, and the store's prune and the start's read spare it. At the resume a cap in flight is judged by its run's outcome (a run gone
  counts as may have run), one waiting is armed for its time or sent at once, one done stays done
  until the on-time resets. So a non-idempotent turn-off that may have run is never sent again
  (GA-LOAD-2). A cap the downtime made due begins at the first tick, whose socket is dead until its
  bridge is heard: its turn-off is `skipped(dead)` and sent at once on the socket's return, with
  slice 6c's notice saying so.
- **A witness watch, due during the downtime.** Every watch restored at a start spans a downtime, and
  is `unknown`, since GA-WIT-1's verdict is `unknown` "when its sensor was not live", and the applier
  did not see it live while it was down (ruled by the maintainer, 2026-10-05). So `witness_watches` keeps only what that
  verdict needs: the run, the step, its target and action, the witness as dispatched (the verdict
  carries it), and the due time; not the reading at dispatch nor the sensor's liveness. A watch due
  before the resume is judged at it; one due later at its time. The verdict is reported at the resume
  when the downtime passed it, not "within 1 s after `within_s`", which a downtime cannot keep
  (accepted as above).
- **A latch.** Held across the restart ("held latches"): `refuse(latched)` before and after, cleared
  only on reported values (GA-SAFE-7), and a rule latched does not fire again (GA-SAFE-11). Written
  behind like every latch (slice 6b), so a crash with the store down can lose one: the cost the
  maintainer accepted on 2026-09-29.
- **A held reissue.** Ends at the restart (slice 4c); the step's late window is kept.
- **A report made while the applier was down** (HS4's box rebooting mid-leak). Its `basis_time` is
  later than the last seen, kept per key, so it is a new report: the rule fires at the start, its
  bridge once heard, with no client connected (GA-SAFE-1, GA-SAFE-11). A report the applier already
  saw, delivered again retained, fires nothing.
- **A device a rule reads or actuates, at the start.** Every bridged device is dead until its bridge
  is heard, as after a broker loss, which GA-SAFE-10 gives a grace: "a graceful bridge reload or a
  broker loss only after 60 s". The build takes a start as one: 60 s after the resume, each rule's
  device still not `live`, whose stop was not already said, is a stop notice; a device said stopped
  before the restart and `live` after it is "live again", from the said stops kept in
  `safety_said`; a device `live` before the restart and `live` after it is not "live again", since
  none of its stops was said. Without this, a sensor whose bridge died while the applier was down would never be
  said at all (ruled by the maintainer, 2026-10-05).

**Time across a restart.** Every due time is kept as an absolute time on the applier's clock
(`deadline_ms`, `until_ms`, `since_ms`, `set_ms`, a watch's and a cap's), and the applier's clock
is the harness's under the harness (GA-HARN-1), so a test steps the clock while the subject is down
(7b's tests depend on the time server's rule that it stops waiting for a client quiet 500 ms, which
lets it step while the subject is down) and the downtime counts: "the wall-clock
time each heating load was first reported `on`, so that downtime counts towards its cap". A step
backward while the applier was down would shorten every on-time, against slice 6c's floor, which
`LoadCaps.observe` keeps within one life only. Slice 7 keeps the clock's last reading in `meta`
(`caps_clock_ms`), written behind and coalesced at each tick while any on-time is counted, and a
start whose clock reads earlier moves every on-time back by the difference, as `observe` does
(ruled by the maintainer, 2026-10-05; the alternative was to accept the shortfall, as the standard's
"wall-clock time" would).

**What else slice 7 fixes.** The backlog's "A rule's seen-report seed is written behind its
`configure`, not with it": the seed rows go into the `configure` transaction, so a crash between the
two never lets a retained report fire a rule configured after it (GA-SAFE-11), with the slice 6a
re-review's probe `rereview-held-report.test.ts` committed as its regression test.

**Negative mutations.** The standard's *Negative subjects* has one row for a restart clause this
build owns, `sends-a-bare-setpoint` (GA-APPLY-16: "After a restart, `climate.set_setpoint 22` on an
IR air conditioner declared `whole_state: true`, last sent `mode: cool`, is published with no
`mode` in its `state`"), which goes straight into `subject.json`, and GA-PERSIST-1's row has none
(`forgets-a-tool-hash` couples it from GA-DESC-11, the PC build's). The harness fails a mutation no
manifest row names ("no row of the manifest names this mutation"), and so would the matrix (`breaks
no graded id`), so each other mutation below is proposed as a row for applier 0.15, and graded meanwhile through a build-local `proposed-rows.json` beside
`known-outside.json`, which `full-matrix.mjs` and `matrix-verdict.mjs` read as rows and
`subject.json` does not list, so `pnpm conformance` stays as it is (ruled by the maintainer, 2026-10-05). When 0.15 adds
the rows, the mutations move to `subject.json` and the file empties. Each forgets one item at the
start, or keeps or writes one wrongly. None couples another id: each restart clause sits in exactly
one id's test, so a mutation fails only the id it breaks.

| Mutation | Breaks | The subject | Part |
|---|---|---|---|
| `sends-a-bare-setpoint` | GA-APPLY-16 | the standard's row: the assumed state is not read back | 7a |
| `forgets-a-used-token` | GA-TOKEN-4 | a token used before a restart dispatches again after it | 7a |
| `uses-a-token-behind` | GA-TOKEN-4 | the token's use, and its apply, are written behind the dispatch, so an apply dispatches while the store is stalled and, after a crash, the same token dispatches again | 7a |
| `forgets-an-idempotency-key` | GA-APPLY-4 | a repeated key after a restart dispatches again | 7a |
| `forgets-an-ack-deadline` | GA-PERSIST-1 | a step waiting across a restart never ends `failed(no_ack)` | 7a |
| `forgets-a-retired-identifier` | GA-PERSIST-1 | replaced hardware listed again after a restart takes back the id it gave up | 7a |
| `skips-lost-events` | GA-EVT-4 | the start keeps every cursor of the last life whatever the stop, so after a crash with events unwritten a cursor reads on past them with no `cursor_expired` | 7a |
| `forgets-a-latch` | GA-SAFE-7 | a latch held before a restart is not after it | 7b |
| `forgets-a-notice` | GA-SAFE-8 | an untaken notice is not listed after a restart | 7b |
| `forgets-what-it-saw` | GA-SAFE-11 | the last `basis_time` seen is not read back, so a retained report delivered again fires the rule | 7b |
| `forgets-a-running-rule` | GA-SAFE-12 | a rule waiting to re-send across a restart is not resumed | 7b |
| `loses-a-fired-run` | GA-SAFE-3 | a firing's records go to the writer as separate write sets, so a crash keeps the latch and loses the run, and the rule never completes | 7b |
| `draws-a-fresh-command-id` | GA-SAFE-3 | every `commandId` is a fresh random UUID, so a firing sent again after a crash that lost it is a new command, and the bridge runs it twice | 7b |
| `forgets-a-said-stop` | GA-SAFE-10 | a device said stopped before a restart is not said live again after it | 7b |
| `forgets-an-on-time` | GA-LOAD-2 | each on-time starts again at the restart | 7b |
| `forgets-a-cap` | GA-LOAD-2 | a non-idempotent turn-off that may have run is sent again after a restart | 7b |
| `forgets-a-watch` | GA-WIT-1 | a step dispatched before a restart gets no verdict | 7b |

GA-PERSIST-1's own test grades the items no other id names (the configuration, the id map, retired
identifiers, adoption, a held apply's outcomes, an ack deadline and its late window, and a plan made
before the restart applied or `unknown_plan`, since plans need not survive),
and never the assumed state, a token or a key, which their ids grade. GA-SAFE-9's latch event and
GA-SAFE-8's completion notice are not graded across a restart; GA-SAFE-7's `refuse(latched)` and
GA-SAFE-12's and GA-SAFE-3's completions are. GA-SAFE-3's half-kept firing also grades the maintainer's
ruling 2 (the firing sent again with the same `commandId`, the simulated bridge running it once)
ahead of applier 0.15's text, through `proposed-rows.json`. Seventeen mutations, `sends-a-bare-setpoint` the only one
in `subject.json`, add nearly a quarter to the matrix's time (66 runs today, the clean build and 65
mutations).

**The split.** Two plans, along the seam slices 4 and 6 used (each part a working, graded applier):

- **7a, the restart, the start's two phases, the gate and dispatch.** The harness's
  `restart(between?, { crash })`, `restartApplier`, `stallStore`; `load` and `resume` for every
  module that exists (the dispatcher, the rules, the caps, the witnesses' seeding, the applier's
  tail), behaviour kept and defect 3 closed; GA-PERSIST-1's own test; the restart clauses of
  GA-TOKEN-4 (a clean stop, and the stall), GA-APPLY-4, GA-APPLY-16 and GA-EVT-4 (the stall, or a
  plain crash where there is no database); the stale "slice 7" `covers` wording;
  `proposed-rows.json` and the matrix's reading of it; seven mutations. No migration: everything it
  grades is already kept.
- **7b, Safe across a restart.** Migration `0015`: `load_caps`, `witness_watches`, `safety_said`,
  and each actuation's state and `waitSaid` on `safety_state`; the clock's last reading;
  `Store.group` and the firing and the cap's beginning as one write set each; the store's prune, the
  start's read and the `running` port sparing a running rule's or a kept cap's run; the new rows in
  the rules', caps' and witnesses' loads and resumes; the start's liveness grace; the seed inside
  `configure`; the restart clauses of GA-SAFE-1, 3, 7, 8, 10, 11, 12, 13, GA-LOAD-2 and GA-WIT-1;
  the derived command ids; ten mutations.

7b needs 7a's harness helpers and two-phase start; 7a needs nothing of 7b. The restarts add about
5 s to each test that makes one (a stop of at most 3 s, a start, the bridge heard again), fifteen
tests in all, inside the subject contract's 5 minutes on 4 workers by the harness's current margin,
which each part's plan measures.

## Error handling

- A request the schema refuses is `invalid_request`, with the schema's first error as the message;
  the operation's own checks come after.
- A message from a bridge that cannot be parsed never throws out of ingest: it is a `bridge_fault`,
  and the step ends.
- A step that throws, before it hands its writes over, is a bug: the applier logs it, hands nothing
  to the writer, answers the caller with an error if there is one, and keeps running. A test fails
  on any such log line. A write set that throws after it was handed over stops the applier (see
  *A store fault*).
- The broker lost: every bridged device is dead, the client reconnects with backoff, and a
  reconnect asks every bridge for a snapshot.
- **The store unreachable** (its container down, the disk full, an upgrade under way; the storage
  design, *When the store is unreachable*). The writer retries, and nothing the applier does waits
  for it but what *What waits for its commit* names. A caller that waits more than 10 s for such a
  commit gets an MCP internal error (JSON-RPC -32603), which means the outcome is not known, never a
  result the applier could not keep. `describe`, `state`, `events` and authentication answer from
  memory; `history` fails until the store is back. A restart while the store is down loses the
  writer's backlog, and with it, from slice 6, the latch that should keep a shut valve shut
  (GA-PERSIST-1); the maintainer accepted that cost on 2026-09-29, with the other: no protection
  runs until the store is reachable after a restart.
- **A store fault**, a statement refused for good: the applier reports it and exits (*The core*,
  *The writer*). A write set that throws anything the store's driver did not give is a bug met
  after its step handed the write over: skipping it would lose a write and retrying it would stall
  every write behind it, so the writer takes it as a fault too, and the applier exits.

## Testing

- **Unit tests** per module, on an in-memory clock and PGlite (Postgres compiled to WASM, in
  process, a fresh database for each test), with no broker and no Docker: the bus rules, the reason
  order, the token check, the tier table, each `configure` kind. PGlite 0.5.8 is Postgres 18.3, the
  production major.
- **The harness** gives the applier what `db-init` would, for each test (`database: true` in
  `subject.json`): a fresh database, a role, and a schema of the role's name owned by it, with the
  `reader` role on the server, on a server named by `GALATEA_TEST_PG_URL`. The subject gets
  `GALATEA_DATABASE_URL`, logging in as the role; the database is kept across the subject's restarts
  within the test and dropped at its end, then the role. So a harness run is the job on a real
  Postgres that catches what PGlite hides: a schema named in SQL, a missing privilege. Without a
  server, [`conformance/harness/scripts/with-postgres.mjs`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/scripts/with-postgres.mjs) starts a throwaway `postgres:18-alpine` on
  loopback for the command it wraps.
- **The harness**, the measure of done: `node conformance/harness/dist/cli.js run --subject
  reference/applier` and `negatives`, which each slice's plan extends with its ids' tests.
- **Speed:** the build's `run` and `negatives` stay under 5 minutes on 4 workers (the subject
  contract, *Speed*).

## Standards fixes this build shows

Filled here provisionally, to be proposed for the next applier revision:

- The shape of each `configure` `kind`'s `value`, the `adopt` declarations and the dry run's diff.
- What a `delete` names: this build takes `{ id }` for a client and a bridge.
- Which `configure` changes are model changes: this build moves `revision`, and emits a `model`
  event, for a client added or removed or its `kind` changed, and a bridge added, changed or
  removed; not for a rotated credential or token key, a `time_source`, or an upsert identical to
  what is held. The standard says a model change moves `revision` (GA-DESC-2),
  but not which `configure` kinds are part of the model.
- The form of an `events` cursor: this build's is the `seq` of the last event read, as a decimal
  string. The standard needs no form, but it does not say what a cursor from another store returns;
  this build answers `cursor_expired`, so the client recovers. Nor does it say whether a cursor
  outlives a restart: here it does, since each life starts `seq` past the last one's.
- Paging `events`: the standard sets no limit on how many events one call returns; this build
  returns them all, which a slice with a busy bus must revisit.
- The MCP tool's `inputSchema`: this build publishes `{ type: "object" }` and validates inside; the
  binding does not say whether a tool's schema must be the operation's.
- GA-SEC-1 on one host: the harness checks only that plain HTTP is not served off loopback. That TLS
  is used, with the certificate validated, off loopback is a deployment's, checked by hand.
- The level of a device's `load`: declaring it is Act, since it raises the device's tiers
  (GA-DESC-13), and only its on-time cap and `max_on_s` are Safe, against GA-LVL-1's "a load" (the
  maintainer, 2026-09-28, after the scenario walk). So a heating socket gets its raised tier from
  slice 2, before the build claims Safe. GA-LVL-1's wording is fixed in the next applier revision.
- The safety rule language: trigger, conditions and the latch's condition.
- Whether a client's bearer credential and its token key are one secret or two: this build
  registers two, since a steward that leaks a bearer should not also leak the power to mint a
  person's yes. `token_key` is optional in `client`: a client registered without one issues no
  token that passes (`refuse(token)`), so wave 0's setup, which registers `{ id, credential, kind }`,
  keeps working. From slice 4a the harness registers its own client with a `token_key`
  ([`conformance/harness/src/home.ts`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/src/home.ts); the simulated applier ignores the field) and signs its
  tokens with it. The key is the HMAC key as its UTF-8 bytes, which the binding does not say; a
  token that is not of the token's shape (`token.json`, provisional) counts as none.
- How long an apply's record is held for `outcome`: this build holds it as long as its idempotency
  key, 3600 s.
- Whether a witness's verdict follows the step's first final outcome as a second `outcome` event:
  this build sends it as one, with the witness verdict, and `outcome` carries it beside the step's
  own outcome, as the step's `witness` (provisional, 2026-10-05).
- The applier's side of the MQTT connection (the maintainer, 2026-09-29; see *The
  bus*): its subscription QoS (1) and a SUBACK check, its keepalive (at most 10 s), what it does on
  a DISCONNECT `0x8E`, its backoff, that it queues and replays nothing, a device status whose
  `deviceId` differs from its topic (the topic wins, a `bridge_fault`), a `publishedAt` that does
  not parse (a fault, not a heartbeat), an empty retained `status` (nothing), and that unchanged
  data re-delivered is silent. Neither standard states these; the next revisions should.
- The `adopt` value: `{ device, class, declarations?, replaces? }`, provisionally
  (`configure.adopt.json`). Until its slice this build refuses a null class (the PC slice's
  plugin devices and wake relays). From slice 2b it takes `declarations` (`declarations.json`), each
  field checked as its own `configure` kind would be; an empty `{}` is the same as none. From slice
  3 it takes `replaces` and a delete, which un-adopts the device and drops its declarations; every
  `configure` value schema is closed (`additionalProperties: false`), so a field this build does not
  know is refused, not dropped.
- The `model` event of an adoption carries `{ revision, device, class }`, one per device adopted; a
  device a bridge adds or changes is a model change too, `{ revision, device }`. The standard says
  what an adoption's event carries, not whether a bridge's new device moves `revision`.
- The fields of `liveness` (`{ target, old, new }`), `transport` (`{ transport, up, state }`, the
  applier's transport id) and `bridge_fault` (`{ bridge, what }`) events: the standard names what
  they carry, not their keys.
- The least an unknown value means: a transport's kind `other`, its state `down`, `feedback`
  `closed`, `proposedClass` null, `classEvidence` `none`, an action's `confirms` `false`.
- Which fields of a `devices` entry an applier cannot do without: `id`, `stableIdentifier`,
  `transport`, `capabilities`, `actions`. An entry without one is dropped whole, a malformed action
  alone.
- A status without an `instanceId` is a bad status: a `bridge_fault`, no heartbeat and no revival,
  the bridge dead until a valid one arrives. The bridge standard requires the field of `status`, but
  not what the applier does without it.
- Whether silence raises a `bridge_fault`: the standard says a will never does and does not say for
  30 s of silence. This build raises none, only `liveness` events; a status that is bad, or a live one
  more than 5 s off its arrival, is a fault, raised once while it stands, even when it does not
  revive the bridge.
- What a missing piece means: an unknown `feedback` is `closed` and an absent or malformed
  `otherAdmins` is "unknown" (malformed is also a fault), never empty; a `devices` list (a roster or
  the document) that is missing or malformed retracts nothing, and only a well-formed list without
  the entry removes a device; a transport a status omits reads `down`; a transport that appears or
  changes `kind` is a model change, kept in the store. A reading from a fast clock never becomes a
  device's last seen value. Neither standard says any of these.
- The declaration kinds (slice 2b, provisionally): `tier` `{ device, action, tier }`, `load`
  `{ device, load }`, `infrastructure` `{ device, infrastructure }`, `fresh_s` `{ device, fresh_s }`,
  `ack_within_s` `{ device, action, ack_within_s }`, and `personal` and `self_changing`
  `{ device, key }`, each with a delete but `tier`'s; `adopt`'s `declarations` holds the same fields,
  and `opens_with`. The standard lists what the owner declares, not the shape of a change.
- "`configure` only raises it" (GA-DESC-3): this build refuses a tier below the device's current
  one as `invalid_request`, and a tier's delete, rather than clamping either; the standard does not
  say which. Tiers are derived, the higher of the table's and the owner's, so a change of `load` or
  `infrastructure` re-applies the table in the same change set (GA-DESC-13).
- Which action opens a water or gas valve on an `onoff` relay: the *Default tiers* row names "the
  action that opens it" and nothing says how the applier knows it. This build takes `opens_with`
  (`onoff.turn_on` or `onoff.turn_off`) in `adopt`'s declarations, on a water or gas valve only,
  default `onoff.turn_on`.
- Which `configure` changes of a device are model changes: this build moves `revision`, with a
  `model` event naming the device, for every declaration that changes what `describe` gives.
- A device whose bridge gives no `reachMs` (GA-BRIDGE-38 requires it; the schema leaves it
  optional): its reach is unknown, so `describe` omits `reach_s`, the build raises a
  `bridge_fault`, GA-CFG-3's reach clause is not checked, and its `ack_within_s` is the class's
  default. Taking it as 0 would call a sleepy device always reachable.
- A device on an `ir` transport its bridge declares `feedback: closed` (GA-DESC-7): taken as
  `open`, and a `bridge_fault`, raised once while it stands. A `feedback: open` device's readings
  are dropped with a `bridge_fault`, since the bridge standard says a bridge publishes none for one.
- The `freshness` event: `{ target, fresh_s, fresh_basis, declared_fresh_s? }`, on a change of a
  device's effective bound; each life starts every bound unknown, so the first bound known is a
  change (an event burst at start, like liveness), and an open device's bound is unknown. The standard names
  the event and not its fields.
- Notices (GA-BUS-12, GA-BUS-6): a notice is taken for every client once one client names it in
  `notice_taken` (the standard says "until a client lists" it); a notice raised "once while the
  entry stands" is keyed by its bridge, device and code, and the key's standing is kept in the
  store, so a restart does not raise it again. A device the applier missed is a notice with cause
  `missed_device`, naming the unadopted devices a re-sent `devices` document (retained on
  subscribing, or answering a snapshot) holds that the model did not, except the whole first
  document of a bridge the owner has just registered.
- A notice with cause `store`, when the writer's backlog reaches its cap: *Notices* lists no cause
  for it, and an unknown cause is shown all the same.
- The cap on a bridge's unlisted device topics: facts are kept for at most 1024 device topics the
  bridge's `devices` document does not list, the oldest going first, with a `bridge_fault`. The
  standard sets no bound.
- A refused subscription (a SUBACK that does not grant QoS 1) is asked for again on the backoff,
  without a reconnect, until it is granted, and raises one `bridge_fault` while it stands. A grant
  below QoS 1 is a standing fault that is not retried: asking again cannot raise the broker's
  maximum, so that bridge stays unheard until the next connection.
- GA-LVL-1's wording: a socket's `load` is taken at Act, not Safe (the maintainer, 2026-09-28; see
  above). The next applier revision words the clause so.
- `history` may have a gap after an outage of the store past the writer's cap (C3, the maintainer,
  2026-09-29): the cap drops events' rows, which can be derived again, and the owner is told by the
  `store` notice. The standard's `history` clauses need a carve-out for it.
- The cause `missed_device`: a device that joined while the applier was away. `window_closed`
  belongs to GA-PROV-2's closed join windows, so this build gives the missed device its own cause,
  which *Notices* does not list; the next revision may rename it.
- Unknown to first-bound `freshness`: the change from an unknown bound to the first bound known in a
  life is a `freshness` event, "reported as events" in the standard.
- The bounds of a device-fault notice: a fault's `code` is cut to 128 characters and at most 64
  device faults stand per bridge, with one `bridge_fault` past that. The standard sets no bound.
- A grant below QoS 1 is a standing fault that is not retried (see the refused subscription above).
- `forget` (slice 3): `{ device }`, refused (`invalid_request`) while its bridge's `devices` lists
  the device, and before this life has heard that document; a forget has no delete. It removes the
  device, its adoption, its declarations and its previous identifiers; one listed again before the
  forget commits stays, unadopted, and the configure's model event says `adopted: false` for it,
  not `forgotten`. The standard names the kind, not its shape, nor whether a forget is undone. The
  cost of refusing before the document is heard: a registered bridge whose retained document is
  gone (the broker lost it, or the bridge is dead for good) blocks every forget of its devices until
  the owner removes the bridge.
- A delete of an `adopt` un-adopts the device and drops its declarations, a model change with the
  event `{ revision, device, adopted: false }`. The standard does not say what un-adopting means.
- A replacement (GA-ADOPT-2): allowed while the old device is still listed (its hardware then takes
  a minted id, `{bridge}:{device}/{n}`), and across bridges; refused when the old device is not
  adopted, the new one is, the new one's stable identifier is one the id retired, or the new one is
  the same hardware on another bridge (a second route, which slice 4's routes take); a change set
  may not replace one id twice, nor forget an id it replaces. The new device takes the class and the
  declarations, all but an owner-set `fresh_s`, which described the old hardware; the new device's
  own declarations are dropped. A kept `ack_within_s` is not checked again against the new
  device's reach: the effective value is floored by the reach anyway (GA-CFG-3's floor, applied in
  `describe`). Its `model` event is `{ revision,
  device, class, replaces }`, where `device` is the new hardware's id before the move. The standard
  says what is inherited, not these edges.
- The id map is kept by bridge device (`UNIQUE (bridge, bridge_device)`), not the `{bridge}:{device}`
  formula: a replacement re-points an id, and hardware whose formula id another device holds takes
  a minted one. Bridge device ids never contain `/`, so a minted id never meets one.
- A transport leaves the model, with a model event `{ revision, transport, removed: true }`, when no
  device names it and its bridge no longer lists it (or is removed). A device naming a transport its
  bridge's status does not list is dead, with a `bridge_fault`. The standard gives a transport no
  removal.
- `route_conflict` (GA-BUS-11): the event carries `{ stable_identifier, bridges, devices }`, once
  per identifier while the set of bridges showing it stays the same (a new bridge is news; a further
  copy on a bridge already named is not); on the same bridge the build also raises a notice with
  cause `route_conflict`, since one bridge showing one identifier twice is the bridge's fault, which
  the owner must act on. From slice 4a the copies with neither adopted are one device, as the
  standard says: a device newly showing the identifier of another bridge's unadopted device is
  **folded** into it, held under an id of its own (its row's `folded_into` names the device) but
  exposed only as that device, its readings no one's events. The event names both bridges and the
  one device. **Route first** (the maintainer, 2026-10-01): the one device is adopted only once a
  route names the bridge that carries it, so its steps read `refuse(not_adopted)` until then, and
  an adopted device's route is neither deleted nor changed. A copy that arrives beside an adopted
  device stays a device of its own, and adopting it beside the other is refused, so no hardware has
  two adopted ids; once the device's adoption is deleted, the copy folds into it. A copy whose
  bridge no longer lists it counts as no copy, and two entries of one `devices` document showing
  one identifier fold into nothing (hardware admitted anew there).
- `duplicate_route` (GA-BUS-11, the reason order): under route first a single applier never reaches
  it, since an adopted device is always routed and an unadopted one is `not_adopted` first. The
  reason stays in the order, and in the reference applier's gate, for a meta-applier, whose
  children's copies of one hardware it cannot fold. The standard does not say which applier meets
  it.
- Routes (GA-BUS-11): the `configure` kind `route { stable_identifier, bridge }`, provisionally
  (`configure.route.json`), with a delete naming the identifier alone. The bridge must be registered
  and show exactly one copy. **A route never moves an adopted device** (the maintainer, 2026-10-01:
  "an adopted device keeps its bridge … never merged"): a route, or its delete, is refused while a
  device showing the identifier is adopted, and nothing folds into an adopted device; an adoption
  with `replaces` moves an adopted device onto its own hardware on another bridge, its route, if
  any, following. The identifier's unadopted device (the copy on the route's bridge, else the one
  the others fold into) takes the copy on that bridge: the id moves to that hardware, and the
  hardware it had folds into it under the id the copy had; every other bridge's exposed copy folds
  too. The owner's change writes the rows in its own write set, with the `model` events `{ device }`
  and `{ device, folded_into }` (a delete's names the device), and memory places exactly the rows
  written, each with its hardware's document at the commit, a newer one written behind; the id
  keeps its verdict, and each value its new hardware reports otherwise is a `state` event. A
  folded copy is shown again, a model change, when it stops sharing the identifier, when its device
  is forgotten or replaced, or when it lands on its device's own bridge. An adopted, routed device
  cannot be moved onto its folded copy, which `replaces` cannot name: the owner deletes the
  adoption, routes and adopts again. The standard names the route but not its shape, which id the
  one device takes, or whether a route may move an adopted device.
- Other admins (GA-ADOPT-3): a change of `other_admins` alone is state (GA-DESC-2), written behind
  with no `revision`, and an `other_admins` event `{ target, other_admins }`. The notice, cause
  `other_admin`, is raised at adoption or replacement (for `unknown` too), judging the tier at the
  higher of before and after the change set; when an admin is added against the last list known,
  an `unknown` between two reads kept as the bridge's lost view; and once, at the first start of this
  build, for the devices adopted before, which catches up on the notices slices 2a and 2b never
  raised (adoption itself came in 2a), a device whose row that start did not hold being judged when
  its document arrives. A list become `[]` after such a notice withdraws the untaken one and raises
  its own. A `[]` lapsing to `unknown` raises none. The standard does not say what "added" means
  across `unknown`, nor what the start-up once is keyed on.
- `open_loop` (GA-ADOPT-6): raised at an adoption on an `unknown` transport, and for each adopted
  device when its transport first reads `unknown`, once while it is adopted, across a restart; an
  adoption on a transport that answers clears the key an earlier hardware of the id left standing.
- `configure.bridge`'s `identity` is one MQTT topic level of `[A-Za-z0-9._:-]`, at most 128: no
  `+`, `#` or `/`, which would subscribe to other bridges' topics. The standard does not bound it.
- Ids past 128 (slice 4a): a bridge `id` is at most 32 characters, and a bridge's device or
  transport whose applier id, `{bridge}:{id}` or a minted `/{n}`, would pass the standard's 128 is
  not modelled, a `bridge_fault` while it stands; so is replaced hardware whose new id would pass
  it. The standard lets a bridge's own id fill 128, so the prefixed id cannot always fit. The cost
  is real: a plugin device's id is up to 114 characters (`<id>:<version>:<key>`, GA-BRIDGE-69), so
  a bridge id over 13 characters can leave a conforming PC bridge's plugin devices unmodelled. The
  next bridge revision should bound a bridge's own device ids.
- Arguments (slice 4a): a standard action's argument that is missing, extra, of the wrong type or
  out of range is `refuse(invalid_args)`, not a request error; the ranges are the vocabulary's
  (`level`, `volume`, `position` 0 to 100, `rgb` `#rrggbb`, `mode` one of five, `urgency` one of
  three). Then a device's own `args` constraints (slice 4a, for every device): on the wire `"any"`,
  a list of values, `{ min?, max?, optional? }`, or an object of an object argument's fields, the
  forms the PC bridge publishes; a constraint that cannot be read is dropped with a `bridge_fault`,
  its argument left to the vocabulary; a field an object's constraint does not name is refused;
  `notify`'s `from` is never refused, since a device that does not list it is sent none. An
  extension action is checked only against its device's constraints, never against its extension's
  JSON Schema, which would need a JSON Schema validator in the gate for what the bridge refuses
  anyway (GA-BRIDGE-4); a manifest's schema is the PC build's. The standard lists the reason but not where each check lives, and gives the
  constraints only in prose (`[off, cool]`, `16–30`).
- `already` (slice 4a): judged only on a live, closed device, for a stateful action, on the key it
  sets (`cover.open` and `close` on `position` 100 and 0), within the default tolerance (1 for
  `level` and `volume`, 0.5 for `setpoint`, 2 for `position`, exact otherwise; `rgb` case-blind).
  `media.launch` is never `already`. An owner's `tolerance` comes with the `configure` kind that
  sets it, and a plugin action's `confirmed_by` with the PC build's plugin actions; both land in
  `holds` (`src/gate/actions.ts`).
- Plans (slice 4a): held in memory, never across a restart (a plan the applier no longer holds is
  `unknown_plan`), 60 s past their expiry so that a late apply is `plan_expired`, at most 64 per
  client, its oldest dropped. Only a client plans; the owner makes no plan. A client's `token_key`
  may not be its credential.
- An inline request (slice 4b): `apply` with `{ request }` is planned in the same call, so every
  step is judged at dispatch, and a `dead` target is `skipped(dead)`, as a step `skip(dead)` in a plan
  is; a planned `op` whose target died since is `unreachable` (GA-APPLY-5, GA-APPLY-9). A step judged
  at dispatch whose device left the model is `skipped(unknown_target)`, and a reason beyond
  GA-APPLY-9's list that applies then (`invalid_args`, `duplicate_route`, `tier`) is its outcome too:
  the same `judge` runs.
- The token's use (slice 4b), **a known departure pending GA-TOKEN-4's rewording** (the maintainer,
  2026-10-01): a step's token is reserved in memory when its apply starts, so applies running at once
  never both take it, and its use is recorded in the store before anything is sent; the store not
  keeping it within 10 s fails the whole apply, nothing sent. GA-TOKEN-4 says "used when its action is
  dispatched, and not before"; recording it behind, after the PUBACK, would let a crash forget a use
  and dispatch a confirmed action twice, so the safe order is kept and the next applier revision
  words the requirement to match. The record is deleted when the step ends `unreachable` at its
  PUBACK; a crash before that leaves a never-dispatched token used, the safe way. A token another
  apply already used is `refused(token)` at dispatch whatever the token check said, for an action
  that needs one; a token on a `reversible` action that stands is used too.
- PUBACK (slice 4b, GA-BUS-9): a step is `dispatched` on a success code or when the connection is
  lost before one (never sent again), and `unreachable` on `0x10` and on any code from `0x80` up.
  Only `0x87`, which the standard names, is a `bridge_fault`, raised once while it stands and cleared
  by a success; any other refusal (a quota, a packet id in use) is the applier's own condition,
  logged. A snapshot request's `0x87` is the same fault under its own key. mqtt 5.16 hides `0x10`
  from its publish callback, so the code is read off the PUBACK itself. An ack, a report, a bound or a
  bridge's death that comes before the PUBACK waits on it: a success takes it, a refusal drops it,
  since nothing was delivered.
- Acks (slice 4b): an ack is taken only from the bridge the command went to, on the topic of the
  device it went to; one with another device's topic is a `bridge_fault`, and an ack for a command
  id the applier did not send it, a folded copy's bridge included, is no one's and silent. A
  `failed` without a `reason` is a fault, taken as `failed(no_confirmation)`. The optional non-terminal
  `received` and a result the applier does not know are no terminal ack. A second terminal ack is
  a duplicate (GA-BUS-6), so a `failed(no_confirmation)` is the terminal ack taken, and an
  `applied` after it is not. A `detail` is cut to 1024 UTF-16 units and a `reason` to 128, never
  inside a surrogate pair; a `detail` holding U+0000 or a lone surrogate is dropped with a fault; a
  `commandId` longer than 128 is no one's. Fault texts name no command id, so one stands per kind
  while it lasts. An ack still counts for 900 ms after the step's bound (GA-BUS-4's 1 s, for a
  bridge on MQTT 3.1.1 that counts from receipt), and the step is `failed(no_ack)` or `unanswered`
  then, inside GA-APPLY-8's 1 s.
- `acked` (slice 4b, GA-EVT-3): a report matching the action acks a stateful step on a closed
  device, before or after its `applied`, judged by when it arrives, after the publish, not by the
  bridge's clock; one that arrives before the PUBACK waits on it. The standard says "made after
  dispatch" without saying which clock.
- The bridge's death (slice 4b, GA-APPLY-8): a closed device's waiting step ends `failed(no_ack)`
  when its bridge goes from alive to dead in this life, by its will or its liveness lost. The
  applier losing its broker is no bridge found dead (the maintainer, 2026-10-01, following
  GA-BUS-9's text): every bridged device reads dead meanwhile (GA-BUS-7), and a step in flight waits
  for its bound. At a start every bridge is dead until heard, and a step that waited across the
  restart waits for its bound. An open device's step waits for its bound, since nothing it could
  hear ends it sooner.
- Causes (slice 4b, GA-EVT-1, GA-EVT-6): a step's window is its bound, `ack_within_s` from
  dispatch, not persisted beyond its waiting step. "Towards" is a match, or for a numeric key a
  value strictly nearer the one wanted than the last. The side effects are `set_level` and
  `set_color` turning `on` true. The latest window naming a key decides, in dispatch order, after a
  restart too. A `self_changing` key keeps an apply's cause only on the action's own key, so a side
  effect on one is `device`.
- Held applies (slice 4b): an apply's outcomes are held, and served by `outcome` to the client that
  made it alone (`unknown_apply` to another), for 3600 s after it was made, in the store, with the
  steps still waiting and their deadlines (GA-PERSIST-1). A step's waiting row is written before its
  command is published, and its final outcome before the row is deleted, so a restart finds every
  step either waiting or final; one it finds neither, still `dispatched`, is `failed(no_ack)`.
  Nothing about an apply is told until its tokens are kept. The `outcome` event carries `{ apply_id,
  step_id, target, outcome, reason?, detail? }`, one for each outcome a step takes, `dispatched`
  included. An apply request holding a string with U+0000 or a lone surrogate is
  `invalid_request`, since its actions are kept with its outcomes.
- A command's Message Expiry (slice 4b, GA-BUS-5) is its `ack_within_s` rounded down, at least 1 s,
  so the broker never delivers it after its step has failed.
- For the next applier revision, reviewed with GA-TOKEN-4's rewording (the maintainer, 2026-10-01):
  the *Negative subjects* row of `toggles-to-reach-a-state` couples GA-APPLY-9, since the mutation's
  text dispatches the toggle, and until then the reference applies it to the planner only; the row
  of `never-fails-a-silent-ack` couples GA-BUS-4, GA-APPLY-7 and GA-APPLY-15, so the harness may
  check a `failed(no_ack)` at the bound inside them; until then they are graded by other paths (the
  ack in the grace after the bound, a `failed(no_ack)` reached through the bridge's death).
- Idempotency keys (slice 4c, GA-APPLY-4, 10): a key is claimed in memory in one step, so a repeat
  that comes while its first apply still runs, its PUBACKs out included (preflight I1), waits for it
  and answers as it did; a request error,
  the store's included, frees the key, and an apply kept with its key holds it 3600 s whatever its
  outcomes. The body compared is the request in RFC 8785 form without `idempotency_key` and without
  each action's `token`. Every apply (each carries a key: *Apply* requires one) is written to the
  store, its tokens with it, before its first step; the steps that end at once are told only after
  that write. The standard
  says "returns the first apply" without saying what a repeat during the first returns, or what a
  failed request leaves.
- Late acks (slice 4c, GA-APPLY-11): a late window opens only when the step's own `failed(no_ack)`
  was the outcome taken, on a closed device, for a stateful action, and is kept in the store until
  it closes or its 60 s pass. A match is one `late_ack { apply_id, step_id, target, key, value,
  cause }`, with the apply's cause on the state change if no window claims it, and the step's
  outcome never changes. A bridge's `failed` ack saying the device did not act closes the window
  even when it comes after the `failed(no_ack)` (*Outcomes*, after GA-APPLY-11; preflight I4), unless
  a reissue already went out, which may have acted. The standard names the event but not its fields.
- Reissue (slice 4c, GA-APPLY-6), where *Reissue* is silent, following the per-step retry deployed
  dispatchers run (three attempts, 500 ms apart): three attempts in all, each reissue 500 ms after the last attempt's bound
  and grace, so never inside the first command's bound even when its bridge was found dead before it
  (GA-BUS-4; preflight I2); only on a closed device, for an action whose effective declaration is
  idempotent (an extension action never is, whatever its bridge declares, GA-DESC-4), and, where its
  declarations changed after its dispatch, only if both the old and the new say idempotent
  (GA-DESC-18); a step that used no
  token and whose device reported no value moving away from it, judged again by the gate; each under
  a fresh command id with its whole bound inside the step's late window, so a match it brings is the
  step's `late_ack`, and with an attribution window of its own bound, so a report moving towards it
  or a side effect is the apply's (preflight M2). A later action dispatched to the device on the same
  key, or one with it as a side effect, stops the pending reissues (preflight B1; see the next
  revision's items below). A reissue's acks are no one's, a broker's refusal ends the reissues, and
  nothing about them is kept, so a restart ends them.
- Assumed state (slice 4c, GA-STATE-4, GA-APPLY-16): kept per key, in the store, for an open device
  only, set when a step ends `sent` or `unanswered` (every key a whole-state command carried, or the
  action's own key), never on `failed` or `unreachable`; `state` lists it after the observed values,
  each marked `assumed: true` with its `basis_time`, and a change of it is no `state` event. A
  whole-state command's `state` is the assumed values, overlaid by the device's actions dispatched
  and not yet ended, from any apply, then the action's own key. Both follow the order commands were
  dispatched in, kept across a restart on each waiting row and each assumed value, not the order
  their outcomes came in: an action in flight overlays an assumed value only if it was dispatched
  after the command that value came from, and an ending command makes a key assumed only if no
  command dispatched after it set that key already (preflight I3). A step's outcome, the values it
  makes assumed and its waiting row's delete are one write set (preflight M3). The actions in flight
  are rebuilt at a start from the waiting rows, which keep the frame they sent. On a closed device
  the frame carries what is in flight and the action's own key, and nothing becomes assumed: the
  standard's "the latest earlier action ... unless it ended failed or unreachable" would also keep
  one that ended `acked`, whose value is then observed; no closed whole-state device exists yet, so
  this build leaves observed values out of the frame (preflight M7). A device's assumed state goes
  with its forget (the controller's ruling M8).
- For a later applier revision (0.14 left them as they were), with GA-TOKEN-4's rewording and 4b's
  two rows: *Reissue* stops a
  reissue once "a later action setting the same key has been dispatched to it", beside a value
  moving away (preflight Q1, the controller's ruling; this build does so already). And the
  *Negative subjects* rows of seven older mutations are incomplete: each fails, through a real
  coupling, ids its row does not name (`one-bad-entry-silences` GA-BUS-3, GA-DESC-5;
  `rejects-unknown-kind` GA-BUS-1, GA-BUS-14, GA-DESC-5; `fresh-by-arrival` GA-BUS-2, GA-STATE-6;
  `plans-through-broker-loss` GA-BUS-6, 8, 9; `reissues-inside-the-bound` GA-BUS-9;
  `ignores-owner-bound` GA-EVT-5, GA-STATE-6; `kills-a-mute-transmitters-devices` GA-ADOPT-6,
  GA-STATE-4). The rows gain those couplings; until then the reference applier's
  `known-outside.json` lists them, and its full matrix fails only on a new one (the maintainer, Q2). Applier
  0.14 adds two: `reissues-on-timeout` fails GA-DESC-18, whose no-reissue clause a blind reissue
  breaks, and its row names GA-APPLY-6 alone; `fresh-by-arrival` fails GA-EVT-8, whose harness test
  needs a silent sensor to go stale before an occurrence, which freshness by arrival never lets it.
- Extension names (applier 0.14, bridge 0.5): parsed on the last dot; an extension whose capability
  is another's with a segment added is dropped with a fault, so the last dot is never in doubt; an
  extension action its device's `extensions` do not declare, a stateful one without a `confirmedBy`
  naming one of their `state` keys, a key of a `kind` this build does not know and a key whose schema
  is not a scalar's are each dropped alone with a fault, and a list cut past 64 entries says so. A
  step without the argument its `confirmed_by` names is `refused(invalid_args)`, since nothing could
  ack it; extension arguments are otherwise checked against the device's `args` only. The standards
  say what a bridge must send, not what an applier does with what breaks it.
- The owner's `idempotent: true` on an extension action, at adoption (GA-DESC-4): not offered by this
  build, so every extension action is not idempotent and GA-DESC-18's fallback of it is vacuous. The
  `adopt` declarations would gain an `idempotent` map if a case needs it.
- Changed declarations (GA-DESC-18, GA-APPLY-9): "whose action's declarations changed since the
  plan" is judged on a fingerprint of a fixed list of wire fields under a version tag (`fingerprintOf`):
  the action's entry, its extension schema, the key it sets with its extension `kind` and schema and
  whether the bridge marks it personal or self-changing, and the device's `feedback` and `reachMs`.
  A description, another key or another action moves none of it, nor does a later build parsing more
  of a document. It is taken when the apply starts, which is the plan's view, since a plan of an older
  revision is `stale_revision` first and nothing awaits between. At dispatch `declaration_changed`
  comes before `already`, `unsupported_action`, `toggle_only` and the token, so a changed step is
  never told as a success; only `not_adopted`, `safety`, `latched` and `dead`, which do not hang on
  the action's declarations, outrank it (the maintainer, 2026-10-01). A dispatched step keeps its
  dispatch-time `confirmed_by`, kind and bound, and is reissued only on the declarations it was
  dispatched on, where they and the current ones both say idempotent.
- An owner's lowered tier falling back (GA-DESC-18): the tier is kept with the fingerprint of the
  action's declarations it was set on (`tier_basis` in the declarations), and one below the table
  falls back when the fingerprint moves. It is dropped then, in memory at once and in the stored
  configuration in the owners' line, so it stays fallen back, the bridge's return to the declarations
  it was set on included, until the owner sets it again, as GA-DESC-11's dropped tier does (the maintainer,
  2026-10-01). A tier at or above the table is kept as it is.
- Occurrences (GA-EVT-8, GA-EVT-5): one of a key the device does not declare an `event`, of a device
  not held, or with a value that is not a scalar or a timestamp that is not a time, is a fault and no
  event; an `event` key in a device's status is dropped with a fault, and so is its value where a
  status brought it before the device was described or its bridge re-declares a `state` key an
  `event`, so `state` never returns it and `already` never matches it. An occurrence is hidden from
  `history` if its key was personal when it happened, kept on its row (`events_only`, migration
  `0010`, which the reader role's `history_v` honours), or is personal now, which `history` filters
  when it is read (the maintainer, 2026-10-01). A reading of a key no
  declaration names is still taken from a status: GA-BRIDGE-76 is the bridge's, and a bridge before
  0.5 sends such keys.
- GA-EVT-8's "`configure` refuses a safety rule that reads it" is slice 6a's, and GA-SAFE-7's latch
  over extension actions slice 6b's; GA-META-8's relay of occurrences is the meta-applier's.
- **Safety rules** (slice 6a). The rule language above is this build's, provisional, as is
  `configure.safety_rule.json` and its delete `{ id }`. The owner's word on the box is the
  `configure` change `box: true`, as the standard's *The broker is the floor under the gate* says;
  the build refuses it while its broker connection is plain TCP to a host off loopback. A bridge's
  status without an `ungoverned` list is malformed (only the current standard exists, and its status
  requires the list): a fault, counted as one path the applier cannot read, so it claims no Safe over
  it. A rule's delete is taken whatever is claimed, so an owner whose claim lapsed can still remove
  one; a rule configured stays and fires while the claim lapses, since protection is not what a lapsed
  claim withdraws; adding or changing one is `not_claimed` (the maintainer, 2026-10-04; for applier 0.15).
- What a rule does when it fires, where the standard is silent: it fires when its trigger becomes true
  on a new report and its conditions hold at that moment (false then, it waits for the trigger's next
  time); a trigger already true when the rule is configured fires on the next new report of one of its
  keys, and a report the applier already held when the rule was configured is not new, so a retained
  status delivered again (a broker reconnect, a snapshot) never fires it; each actuation is always sent, never judged `already`; at dispatch only a device or action
  gone (`skipped(unknown_target)`, `skipped(unsupported_action)`), a device not adopted
  (`refused(not_adopted)`), args its device's declarations now refuse (`refused(invalid_args)`,
  slice 6b), an action now declared `toggles: true` (`refused(toggle_only)`) or a dead device
  (`skipped(dead)`) ends it first; its run is held under no client, its outcome events
  carry `rule_id` in place of `apply_id`, and the state changes it causes carry cause
  `{ safety_rule }`; every rule gives a completion notice, its text the rule's `notice.text` or one
  the applier writes, with each outcome; `rule_fired` is `{ rule_id, outcomes, notice, devices }`,
  `devices` being those the rule reads and actuates, by which `history` finds it (GA-LEASE-6). A rule
  deleted or changed while it runs stops running, its devices no longer guarded, with a
  `safety_rule` notice saying what its actuations had come to.
- **Safety rules: slice 6b**, where the standard is silent or loose (for applier 0.15):
  - A rule's args meet its device's declared `args` and `confirmed_by`, as a client's step's do:
    `configure` refuses them, a replacement included; a change of the device's declarations that
    refuses them disables the rule; at dispatch the step is `refused(invalid_args)` (M2). A rule is
    disabled for any such fault, not only GA-SAFE-13's toggle: an action gone, args refused, a key
    no longer reported, an event key; not for another admin added (GA-SAFE-6), nor a device the model
    no longer holds. It gives a `rule_disabled` notice, fires and re-sends no more, keeps its latch,
    is listed in `describe` with why, and runs again only when the owner sets it again, its
    declarations' return included; set again, it acts as a newly configured rule, firing on the next
    new report that makes its trigger true. Every rule is checked once at start, so a disable a
    crash lost is made again.
  - A latch's undo is an action changing a key the rule set to another value, by the key it sets or a
    side effect (`level.set_level` turns a light `on`), or any extension action on a device it
    actuated; an action changing no key is none. After a clear, each kept key's undo is `no_voice` with
    a person's token until an undo of that key is dispatched. The `latch` event is
    `{ rule_id, latch: set | cleared | cleared_by_owner, devices }`, `devices` those the rule
    actuated; `state` lists every held latch, `{ rule_id, devices, since }`. `clear_latch` is
    `{ rule_id }`, refused when no latch of that rule is held, a Safe kind and a model change; a rule
    deleted, or no longer declaring a latch, clears its own `cleared_by_owner`, and one changed
    otherwise keeps it under its new condition.
  - GA-SAFE-12: `failed(not_locked)` and `failed(no_graphical_session)` are final for a rule, not
    re-sent (GA-BRIDGE-66), the completion notice saying why; an actuation has landed on a `late_ack`,
    or on a report whose `basis_time` is no earlier than the firing (the text's "latest report" would
    take one from before the leak); a live device that keeps failing gets one attempt per
    `ack_within_s`; the owner's `clear_latch` ends a run that only waited for its latch; each attempt is a new step id (`s1.2`), judged at dispatch
    as the first, the run's slot holding the last attempt's outcome; a rule's run is held past the
    dispatcher's hour while it runs.
  - GA-SAFE-8: the waiting notice is one per rule, raised again only when what waits changes, a newer
    replacing an untaken older, withdrawn by the completion notice or the rule's change or delete; a
    `late_ack`, matched by its step, while the run runs counts as its actuation's landing and is said
    in the completion notice; after completion it is a second notice unless a later attempt landed,
    and names its rule even once the run was pruned.
  - GA-SAFE-10: "stops being live" is the first move out of `live`, said once; "live again" only
    after such a notice; a planned death is the bridge's (a graceful `offline`, or the broker's loss,
    which counts towards each bridge's 10-minute loop), a device dead for its own reason during a
    reload included; the bound notices are for a closed device only (an open one has no bound), and
    are not repeated across a restart; a disabled rule is said nothing of.
- **Loads, witnesses and computers: slice 6c**, where the standard is silent or loose (for applier
  0.15):
  - `max_on_s` is a Safe `configure` kind, `{ device, max_on_s }`, held only on a `heating` load and
    refused above 86400; without it a heating load's cap is 14400 s, shown in `describe`. The on-time
    is counted for every adopted socket (a closed one from its first report of `on`, an open one from
    a `turn_on` that ended `sent` or `unanswered`; new hardware replacing a socket while on, from the
    replacement), kept in `load_on` (migration `0014`), never lowered by a clock stepped back nor
    over-counted for one started just after the step. A socket made heating, or given a new cap,
    while on past it is said, in a `load_cap` notice, to be turned off at once. The cap's turn-off is
    a run under no client keyed by its socket (`load_cap: <device>` on its outcome events, the cause
    `"load_cap"` on the state change), judged by `judgeOwn`, so a running rule or a latch does not
    hold it (the maintainer, 2026-10-05); its outcome is judged by GA-SAFE-12's classes, as a rule's:
    one that did not run is sent again whatever its idempotency, one that may have run only if
    idempotent, no sooner than its `ack_within_s` after the last attempt began while the socket is not
    `dead`, at once on its return. A failure is one standing `load_cap` notice per socket, a new one
    only when what it says changes. A cap that cannot act, its turn-off a toggle or not offered, is a
    `load_cap` notice once while it stands; `configure` refuses `load: heating`, and `max_on_s`, on a
    toggling socket by every road, while a re-declaration that makes a heating load's turn-off a
    toggle is a notice. A cap stopped so, or whose turn-off ended `refused` or `skipped` or `failed`
    for good, is armed again when the socket's adoption, its turn-off's declaration or its place in
    the model changes while it stays on.
  - A witness is a Safe `configure` kind, `{ device, action, sensor, key?, expect, within_s }`,
    `expect` one of `"rises"`, `"falls"`, `{ becomes }`, `{ toward: { arg, by } }`, read on its `key`,
    one of the sensor's keys, or else on the sensor's first (`key` provisional, 2026-10-05); its
    verdict is a second `outcome` event of the step at `within_s` after dispatch, carrying `witness`
    with its verdict, and is kept beside the step's outcome for `outcome`; `unknown` unless the sensor
    was `live` from dispatch to verdict; `toward` is `confirmed` only when the reading moved at least
    `by` nearer the step's `arg`, and `unknown` when it was already within `by` of it at dispatch
    (provisional, 2026-10-05). Every dispatched step is watched, a rule's and the cap's included;
    watches are in memory only until slice 7 (see *Clauses across a restart*). A witness's bound
    notice follows it to another sensor and goes with it when deleted.
  - GA-SAFE-6's broker host is a computer, adopted or proposed as one, whose `infrastructure` (the
    owner's, kept when `false` too, else its bridge's `proposedInfrastructure`) is true and which is
    not the `applier_host`; its `os` entries or its `unknown` count for every device a rule actuates.
    `applier_host` is an Act kind, `{ device, applier_host }`, on one adopted computer at most. A
    computer newly counting, or an administrator added to it, is an `other_admin` notice for each
    rule without `accepts_other_admins`, carrying `rule_id` and naming the computer and the rule's
    actuated devices, and so is one that came while a change setting the rule waited for its commit;
    the refusal names `applier_host` as the other way out; what was last seen is in memory only,
    seeded silently at start from the stored device documents. The admin
    notice of a device a rule actuates names the rule and says its latch no longer binds that admin.

## Watch in production

Choices to revisit with field evidence.

- **The applier's MQTT keepalive stays 10 s** (the maintainer, 2026-09-30). A stalled
  link is found within 15 s, since mqtt 5.16 declares it dead 1.5 × keepalive after the last
  PINGRESP. Watch for devices reading `live` too long after a silent link failure. 5 s would halve
  that window, at the cost of more false disconnects on a loaded box or a flaky link, each making
  every bridge read dead until its next live status. The standard does not state the keepalive yet
  (final review M6 of slice 2a).
- **A reissue actuates a slow device again** (slice 4c). A device that acts after its bound and
  reports late is sent its idempotent action up to twice more; harmless by definition, but watch
  for bounds set too short, which show as `late_ack` events that follow a reissue.
- **Every apply waits for the store** (slice 4c). Every apply now fails within 10 s while the store
  is down, and queues behind the writes already pending. Measure GA-APPLY-1's 500 ms against the
  writer's backlog.
- **Nothing bounds the wait for a PUBACK** (slice 4b preflight M7). Only the connection's close ends
  a pending publish (`lost`), so on a half-dead link an apply, and every step after it, waits up to
  1.5 × the keepalive, and a step's own bound may pass meanwhile (its outcome then waits on the
  PUBACK). GA-APPLY-1's 500 ms is a SHOULD. Watch for applies slower than their bounds; ending the
  wait at the step's bound as `lost` is the fix if it shows.

- **A safety rule's actuation does not wait for the store** (slice 6a). Unlike an apply, a rule's run
  is written behind and its first step dispatched at once: a valve is not left open while the store is
  down. A run the store never kept is a run a restart does not know of. Slice 7 keeps the choice: the
  gap opens only for a crash while writes wait in the writer's line, which with a healthy store is the
  last few milliseconds, and with the store down is the backlog the maintainer accepted losing
  (2026-09-29). A command sent again after such a crash carries the same derived `commandId`
(the maintainer's ruling 2, 2026-10-05, *The same command, the same id*), so a bridge that remembers it does
it once; only a restart slower than the bridge's memory can run a non-idempotent one twice.

## Decisions this design makes, for the maintainer to overrule

- A new package, not the stand-in grown (approach B rejected).
- Synchronous steps, one writer behind them, and Postgres as the store, following the storage
  design (the maintainer, 2026-09-28 and 2026-09-29), which replaced this design's first choice,
  `node:sqlite`, one transaction per step.
- A store fault stops the applier (the maintainer, 2026-09-29); `events` is served from memory.
- The build depends on `@ludentes/galatea-life-schemas` and `@ludentes/galatea-life-test-clock`.
- Two secrets per client: a bearer and a token key.
- The slice order above, with restarts as their own slice after the behaviour they restart.
- No extension actions of the applier's own (the standard's MAY): none is needed.
- **Slice 7.** Each module reads its own rows back, in two phases, `load` then `resume` (approach A
  of *Slice 7*); the split into 7a and 7b; the cap's state, the witnesses' watches and the said stops
  in their own tables (`load_caps`, `witness_watches`, `safety_said`), and each actuation's state on
  `safety_state`, rather than derived from runs that are pruned and hold one attempt each; a running
  run never pruned nor left unread; a firing's records, and a cap's beginning, one write set each
  (the controller's ruling on the spec review, 2026-10-05: fixed, not accepted); the harness grading
  only the standard's text, the reference's own restart policy left to its unit tests; the harness's
  three kinds of restart, the stalled store by a table
  lock and used by GA-TOKEN-4's test only; each restart clause in exactly one id's test. These follow
  from the text or from engineering. The ones that pick between reasonable behaviours were ruled by
the maintainer on 2026-10-05, each as proposed, the second with an addition:
  - **A step found at the start with no waiting row and no final outcome** counts, in a rule's or a
    cap's run, as may have run, so a non-idempotent one is not sent again, though it may never have
    gone out. The other way, sending it as never run, would risk GA-SAFE-5's "once" to keep
    GA-SAFE-12's re-send.
  - **The applier's own actuations stay written behind** (slice 6a's choice, kept), **and the same
    command produces the same id** (the maintainer: "the same command MUST produce the same id"): a crash
    with writes still in line can lose a cap's or a rule's record, and the command sent again
    carries the first's derived `commandId`, so the bridge's GA-BRIDGE-4 memory drops it (*Work in
    flight at a stop*, *The same command, the same id*); only past that memory can a non-idempotent
    actuation run again. The other way, committing before a non-idempotent own actuation, would not
    turn a heater off or close a pulse valve while the store is down. A deliberate new attempt
    (GA-SAFE-12's re-send) is a new command with a new id; client applies' commands follow the same
    rule; the principle is proposed for applier 0.15.
  - **Every watch restored at a start is `unknown`**: its window spans the downtime, and the applier
    did not see its sensor `live` while it was down; so a watch keeps only its run, step, target,
    action, witness and due time. The other way, judging by the sensor's readings once it is heard
    again, would say `confirmed` of a window it partly did not watch, and would keep the reading at
    dispatch and the sensor's liveness too.
  - **A start counts as a broker loss for GA-SAFE-10**: each rule's device not `live` 60 s after the
    resume, its stop not already said, is a stop notice. The other way, only a device seen to stop in
    this life, never says a sensor whose bridge died while the applier was down.
  - **The clock's last reading is kept** (`caps_clock_ms`), so a clock stepped back while the applier
    was down never shortens an on-time. The other way, the standard's plain "wall-clock time", accepts
    the shortfall.
  - **Restart mutations without a row are graded through a build-local `proposed-rows.json`** in the
    matrix until applier 0.15 names them. The other way, a positive harness test only until the rows
    exist (as `fires-on-a-held-report`), leaves sixteen restart clauses with no negative.
  - **Due work found at the start is reported at the resume**, after its own bound when the downtime
    passed it (GA-APPLY-8's "within 1 s after", GA-WIT-1's "within 1 s after `within_s`"): no applier
    can keep a bound while it is down. The backlog asks applier 0.15 to say so in *Restarts*.
- **Slice 5.** A `provision/` module of three units (`Finder`, `Discovery`, `Provisioner`), the
  finder judged by `BridgeRules`, the idempotency claim moved to `core/keys.ts` for the owner's
  `provision` and a client's apply alike (approach A of *Slice 5*); connections kept apart from the
  model; the split into 5a and 5b. The maintainer ruled K1 to K6 as proposed on 2026-10-05,
  and deferred `install` and `uninstall` to the PC build (the spec review's I2), so K7 is moot.
