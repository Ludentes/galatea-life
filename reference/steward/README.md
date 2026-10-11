---
title: The reference steward
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
---

# The reference steward

A TypeScript build of the Galatea steward standard ([`standard/steward.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/steward.md)), graded by the
conformance harness. The design is `docs/specs/2026-10-02-reference-steward-design.md`; it is built
in slices, and `graded-ids.json` lists the ids it is graded on so far; its `partial` names, for each
id graded in part, the clauses left and the slice that grades them, and the matrix (and the
conformance run) fails when that record and the tests' `covers` disagree.

## What slice 1 does

It serves the MCP binding (revision 2026-07-28, and the 2025 revisions), resolves the caller from
the bearer on every request, and keeps the house and its events in Postgres, in its role's own
schema (`docs/specs/2026-09-28-storage-design.md`). Its steps work in memory and hand their writes to
one writer, which commits them in order and retries while the store is down.

On a store that holds no person, `GALATEA_OWNER_CREDENTIAL` makes the first owner: person `owner`,
their app `owner-app`, and an app credential bound to it. Once a person exists the variable is
ignored. The owner defines the house with `define`, from that app: home settings, rooms, persons,
endpoints, credentials and voice records. The first change set names a notice channel, a device of
the applier's with `notify`, since `define` refuses `notice_channels` without one. A change set
applies whole once it commits, at the revision it names, or returns a dry run's diff. While the
store is known to be down, or 16 changes already wait in the owners' line, `define` is refused at
once. One not answered within 10 s, waiting its turn or its commit, is answered with an MCP error
whose `data.pending` is true; it is still judged at its revision when its turn comes, and takes
effect when the store returns.

It reaches its one applier at `GALATEA_APPLIER_URL` over MCP, at 2026-07-28 or, for an applier
that does not serve it, a 2025 revision. It follows the applier's `describe`, `state` and events
into a mirror, and `describe` shows the applier's devices as targets. The house's revision moves on
every committed change and every change of the applier's model, never on a state change. It serves
its clients whether or not the applier is in reach, and logs once when it is not.

`describe` and `define` are built. The other operations are listed and answer `invalid_request`
("not built yet"), until the slices that build them.

## What slice 2b adds

`answer`, judged in the standard's error order, with the utterance record's checks that need no voice
record; asked plans and their answers read back at start. `apply`, by plan or inline, keyed per
credential for 3600 s: one inline applier apply per steward apply, keyed by the steward's apply id,
each step answered `yes` carrying a token signed with the shared proof (`@ludentes/galatea-life-binding`). Every
outcome carries its time; `outcome` returns an apply's current outcomes. The applier's events are
relayed into `events` with their causes.

## What slice 3a adds

Leases: each device a person's apply dispatched a stateful action to is leased at `person`
precedence from dispatch for the home's hold time, and so is a device an `external` or `load_cap`
change moved; an equal or higher precedence replaces a lease, and `state` shows each device's lease
and `lease` events each change. Rooms' occupancy, from their presence and motion sensors, for
`respect_occupancy` at plan and again at apply, the answers given kept; `state` shows each room's.
Notices: every notice the applier lists, and the steward's own, delivered on the home's `notify`
channels and tried again every 60 s until one is delivered, then taken (`notice_taken`). Every
`notify` the steward sends carries its own `from` (none to an applier older than 0.10); a caller's is
overwritten and marked `from_replaced`. Rules, which leases refuse, come with slice 3b.

## What slice 3b adds

Rules, defined by the owner with `define` (kinds `rule` and `rule_exception`) and listed in
`describe`: a trigger on a state, a state held for a duration, an event or a time, or none for a rule
of conditions only; conditions on state (`op` and `value`, or `not_in`) and time windows in the home's
timezone; actions as a request's, each with `respect_occupancy`; `active`; exceptions. A level rule
fires once each time it becomes true, and remembers in the store that it fired; an edge rule fires on
its trigger while its conditions hold. Nothing fires on a device that is not live, on an assumed
value or on a retired account's key, nor inside an exception. A firing is one applier apply keyed
`rule:<id>:<n>`, sent `via: rule`, at `rule` precedence, so a person's lease refuses it, and a lease's
end makes a level rule fire again; it takes no lease. Its `confirm` and `no_voice` steps carry an
authored token; a toggle and a room not known are skipped. Rules keep firing while the store is down.
A rule's retries and the notices of its failures come with slice 4.

## What slice 4 adds

What a rule's outcome does, for a rule of conditions only. An action declared idempotent that ends
`skipped(dead)`, `unreachable` or `failed(no_ack)` while the conditions hold is fired again, a minute
after its last try (or its `ack_within_s` when longer), until it lands or the conditions stop
holding; one that ends `unanswered` is fired again once. Any other outcome that is no success raises
the steward's own notice naming the rule, the action, its target and the outcome, delivered on the
home's channels, at most once for that action each time the rule becomes true: at once, or, for a
`failed(not_locked)` or a `failed(no_ack)`, once the late-ack wait has passed with no `late_ack`.
`refused(leased)`, `skipped(occupied)`, `skipped(in_use)` and `skipped(toggle_only)` raise none; a
rule acting on a toggle of a device that reports nothing gets one notice at its `define`, and when
such an action comes into its reach. Retries and held notices are kept in memory until slice 11.

## What slice 5 adds

Scenarios, in mode `single` only. A scenario has steps (actions, `if`, `delay` in seconds, `wait`
with a timeout, and `run` of another scenario, expanded in place; a cycle is refused), the targets it
`owned`, and `respect_occupancy`. `scenario_plan` gives one step per action step, judged as the
person at the endpoint named, an `if`'s steps marked `conditional`; `scenario_run` starts a run from
that plan, once per key for an hour, a start while the scenario runs returned with `ignored`. A run
acts as its starter at the starting endpoint, and names it in its cause; it leases what the scenario
owns that its starter's role could act on, until it ends; each action step is judged again when it is reached and sent as one applier
apply keyed `run:<run_id>:<n>`, the run waiting for the step's first final outcome before going on.
A yes to a toggle older than `ask_expiry_s` is asked again. An `if` on a device that is not live, or
on an assumed value, takes no branch without an `else`. A rule may start a scenario: the run acts as
the rule. `scenario_status` gives the failed and the sent steps, to the credential that started the
run and the owner's app (a rule's run to the owner's app alone); `scenario_stop` ends a run, one no
person started for a member and up. Every
run ends after six hours, and a run the steward was restarted under ends `interrupted`. A group a rule
or a scenario still names cannot be deleted.

## What slice 6 adds

Schedules. A schedule runs a scenario at a time of day (`HH:MM` in the home's timezone), on the
`days` it names (every day when it names none), with at most one exception a date that skips that
date's run or moves it to another time that date. One clock timer each, to its next run; a time a
daylight-saving gap leaves out runs at the first minute after the gap, and a time that occurs twice
runs once, at its first occurrence. Each schedule keeps the latest date whose run is handled (its
mark), written before its run starts, so a date never runs twice; a schedule made or changed acts
from its next run. A scheduled run acts as the scenario: `scheduled_run` precedence, `via:
schedule`, its cause `{ run, schedule }`, its steps authored as a rule's are, a notify's `from` the
scenario's. A schedule whose scenario is still running waits, tried every 10 s, and runs once it
ends within 5 minutes of its time, a restart within those minutes included; otherwise the date is a
`schedule_missed` event, `reason: scenario_running`, and no try falls after those minutes.
A scheduled or rule-started run whose steps did not land raises one failure notice, a step refused
because a person holds its device excepted. A skipped date is a `schedule_skipped` event. A run is otherwise
never started late: one whose time passed while the steward was down, or whose timer fired more than
a minute late, is a `schedule_missed` event (at most the latest 64 of one absence, the first
counting the earlier ones). A schedule whose scenario reaches a toggle on an open-loop device raises
one notice that it will never run from the schedule.

## What slice 7 adds

`history`, from the store: the steward's own events and the applier's it relays, with their causes,
oldest first, at most 10 000 a call (`more` says there are others; read on from the last one's time),
an optional `targets` filter matching an event's `target`, `device`, `devices` or `targets`. It keeps
90 days, a personal key's `state` events 7; a `speech` key's and a personal
key's `occurrence` are kept in `events` only. A `reader` role sees `history_v`, without a personal
key's events. A device a safety rule actuated holds a `safety_rule` lease, held by `{ safety_rule }`
with no end of its own (`expires: "safety_rule"`), until the rule's latch clears or, for a rule with no
latch, until its `rule_fired`; the latches `state` lists are read on every sync. After a gap (a
`cursor_expired`, a start, a session made again) the steward reads the applier's history from the last
of its events it had, at most 7 days back and 4096 events: each missed event is recorded marked
`recovered`, a missed `external` or `load_cap` change leases its device for what is left of its hold,
a safety rule's lease is granted or ended, and a level rule that went false and true again in the gap
fires once. An edge a rule triggers on, missed in the gap, fires once if it is at most 5 minutes old
(the schedules' grace); an older one is lost. An applier that refuses its history is said, and the sync goes
on. The steward's own lines go to an injected `logger`.

## What slice 10 adds

Work through a brain. A brain's `define` is taken only where the person it acts for is an owner
there (the build's ruling: the owner role only), and only for scenarios, rules, schedules, their
exceptions, rooms, groups and a target's names and room; any other kind is `not_permitted`. It is
never applied at once: it returns a plan with one `ask(confirm_define)` step carrying the diff, put
on the endpoint as any ask; `define { plan_id }` applies it once the person said yes, checked as
`apply` checks a plan, and unanswered or answered no it changes nothing and spends the plan
(`skipped: not_confirmed`). What a brain creates or changes is `brain_authored`; an owner's own
upsert of it clears the mark. A date a brain moved is marked, a skip never is. A device a brain put
into a room or a group is marked for that room or group only. A step of `brain_authored` work (a
rule's, a run such a rule or schedule starts, a run on a moved date, a step of a marked scenario,
and a step reaching a moved device through that room or group) is `refuse(tier)` above
`reversible`, gets no authored token, and is sent with `brain: true`; a notify's `from` carries
`brain_authored: true`.

## What slice 11 adds

Restarts (GA-PERSIST-2). A rule's notice held for a late ack (GA-RULE-8) is kept in `rule_pending`
(kind `held`) with the end of its wait, and read back at start: it is armed only once the start's
sync has read the applier's history, so a `late_ack` the applier gave while the steward was down
drops it, and one whose wait passed while down is raised then; one of a rule deleted meanwhile is
dropped. The firing it waits on is rebuilt in memory, so a late ack after the restart finds it. So
is a firing sent whose steps had no final outcome yet (kind `sent`, kept from the applier's answer
until every step it sent ends): an outcome the applier gave while the steward was down names its
rule and is judged once the start's state is read, so an `unreachable` is fired again (GA-RULE-7). The
applier's event the steward last had is kept beside its own cursor (`meta` `applier_last`), so a
start reads what the applier did while the steward was down even when none of it was relayed: a
client apply's step settled meanwhile moves to its outcome (slice 2b's preflight, M5). A scheduled
start that found its scenario just started, its date marked, waits with its row in
`schedule_pending` marked (migration `0012`), so a restart inside its grace goes on waiting and one
after it records the date missed (the milestone 5+6 review, M10). The harness restarts the steward
against every durable item built so far: the house, a lease, an apply's key, a plan answered before
the restart, history, a held notice, a firing in flight, a run ended `interrupted` with its lease released, and a held
trigger's duration started afresh. First light restarts the steward over the reference applier while
the bridge holds a notify's delivery, and reads its outcome back at the start.

## Build, test and grade

```sh
pnpm install
pnpm --filter @ludentes/galatea-life-steward build
pnpm --filter @ludentes/galatea-life-steward test          # unit and MCP tests, on PGlite: no server needed
pnpm build && pnpm --filter @ludentes/galatea-life-steward conformance:matrix   # the conformance pass: the clean build, then each mutation on the ids in its reach; needs Docker
pnpm --filter @ludentes/galatea-life-steward conformance:matrix --changed origin/main   # only the mutations the change puts in scope; once per pull request
pnpm --filter @ludentes/galatea-life-steward conformance:matrix --full          # every mutation against every graded id; weekly and before a release
pnpm --filter @ludentes/galatea-life-steward conformance                  # the graded ids and the negatives alone; not part of the gate
pnpm --filter @ludentes/galatea-life-steward first-light                  # the steward over the reference applier and the simulated bridge; needs Docker; by hand
```

The harness grades the steward against a stand-in applier it runs itself (the simulated applier,
scripted). **The matrix alone is the steward's conformance pass** (`docs/guides/2026-10-05-how-builds-are-checked.md`):
it runs every graded id on the clean build, and each mutation on the ids in its reach and its rows'
ids (*Skipping by reach* there; `--full` runs every id under every mutation), and fails when the clean build
fails an id, when a mutation is not caught (an id its row breaks still passes, or fails in setup, start
or exit rather than in the test's body), when a mutation breaks no graded id, when a mutation fails an
id outside its row that `known-outside.json` does not list, or when the record of partly graded ids
disagrees with the tests. Its verdict is `scripts/matrix-verdict.mjs`, unit-tested in
`test/matrix-verdict.test.ts`. `--changed <base>` scopes the matrix to the change against `<base>`, as the applier's does
(`reference/applier/README.md`, *Build, test and grade*, and the guide's *What runs when*): the clean run as ever,
then only the mutations the change puts in scope, each printed with its reasons and still skipping by reach.
The scope is the harness's; the steward's own shared file is `steward-home.ts` (the stand-in applier every check
runs against), and a shared file counts with everything it imports in the harness, so a change to `assert.ts`,
`context.ts` or `report.ts` puts every mutation in scope. A change that touches none runs the clean run only, and
says so. `--uncommitted` adds the working tree's changes; `--only` narrows the scope; `--full` refuses it. What it
leaves to the nightly matrix is the applier's list. To see a change's scope without running anything:
`node node_modules/@ludentes/galatea-life-harness/scripts/changed.mjs --build . --base origin/main`.
`conformance` is kept for a quick look at one build. `first-light` walks the steward over the reference applier and the simulated bridge: a
brain's plan asked on the owner's app through `confirm_on`, the owner's yes, a token, and the lamp on;
then a rule held by a lease, a rule's failure on the channel, a person's scene, a schedule running a
scene at its time of day, the lamp's story read back from `history`, and a scene the brain defines at
the owner's chat window, asked first, marked, and held to its author.
It is a manual gate step: no CI job or gate script runs it, so a slice's gate runs it once by hand,
after the matrix, and keeps its output with the slice's record. The harness against the stand-in
does not catch a break in the chain it walks (the token key, the relay).

## Environment

| Variable | Meaning |
|---|---|
| `GALATEA_DATABASE_URL` | The steward's Postgres, as its own role, whose schema bears its name (required); never printed |
| `GALATEA_DATABASE_PASSWORD_FILE` | A file holding the role's password, put into `GALATEA_DATABASE_URL`, which then carries none. `migrate-main.js` reads it too |
| `GALATEA_MCP_PORT` | The port of `/mcp` (required) |
| `GALATEA_OWNER_CREDENTIAL` | Makes the first owner on a store with no person; ignored once one exists, and refused (logged, never printed) when shorter than 16 characters |
| `GALATEA_STEWARD_ID` | Its `steward_id` in `describe`; default `steward` |
| `GALATEA_STEWARD_HOST` | The address to listen on; default `127.0.0.1` |
| `GALATEA_STEWARD_TLS_CERT`, `GALATEA_STEWARD_TLS_KEY` | Paths to a certificate and key, PEM; required off loopback, where the steward refuses to start without them. The entry point reads them |
| `GALATEA_APPLIER_URL` | Its applier's `/mcp` (required): `https://`, or `http://` on loopback only |
| `GALATEA_APPLIER_CLIENT` | Its client id at the applier (required) |
| `GALATEA_APPLIER_CREDENTIAL` | Its credential at the applier, a bearer token (required); never printed |
| `GALATEA_APPLIER_TOKEN_KEY` | The key its applier holds for it, which signs confirmation tokens (from slice 2b); refused when shorter than 16 characters; never printed |
| `GALATEA_APPLIER_CA` | A path to the CA certificate the applier's is validated against, instead of the system's store. Only the applier link trusts it, through its own agent; nothing else in the process does |
| `GALATEA_OWNER_CREDENTIAL_FILE`, `GALATEA_APPLIER_CREDENTIAL_FILE`, `GALATEA_APPLIER_TOKEN_KEY_FILE` | Each secret above given as a file instead: the account's own, mode 0600, its last line end dropped. The token key's 16-character floor applies to a file's text too |
| `GALATEA_TEST_RUN_ID`, `GALATEA_TIME_SOURCE`, `GALATEA_MUTATION` | The harness's subject contract ([`conformance/README.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/README.md)) |

Every setting is read and checked before anything is opened, and a setting it cannot use stops the
steward with exit code 2 and one line naming the settings, never a secret:

- An empty value counts as unset.
- A value and its `_FILE` twin both set, or a `GALATEA_DATABASE_URL` that carries a password beside
  `GALATEA_DATABASE_PASSWORD_FILE`, is refused. With no file set, the values and full URLs work as
  the harness passes them.
- Every path setting must be absolute; one that is not is refused without being repeated, since a
  secret put there by mistake would be.
- `GALATEA_APPLIER_CA` needs an `https://` `GALATEA_APPLIER_URL` and must hold a PEM certificate;
  `GALATEA_STEWARD_TLS_CERT` and `_KEY` are set together, and must serve TLS together.
- `GALATEA_MCP_PORT` is a port from 1 to 65535; a `GALATEA_MUTATION` this build does not have is
  refused (under a run only).

An applier URL that GA-SEC-2 does not allow (`http://` off loopback) is not a refusal: the steward
serves, logs it once, and never tries the applier.

## The image

`docker build -f reference/steward/Dockerfile -t galatea-steward:local .`, from the repository's
root, builds the image that serves both entries: `node dist/main.js` (its default) and
`node dist/migrate-main.js`. It needs BuildKit (Docker's default builder since 23.0), which reads the
allow-list beside the Dockerfile (`Dockerfile.dockerignore`); the base image is pinned by digest.
