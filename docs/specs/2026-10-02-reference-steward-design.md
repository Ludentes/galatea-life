---
title: The reference steward — design
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/specs/2026-09-28-reference-applier-design.md
  - docs/specs/2026-09-28-storage-design.md
  - docs/specs/2026-09-27-conformance-harness-wave-0-design.md
  - docs/reference/2026-09-24-home-reference-scenarios.md
  - standard/steward.md
  - standard/applier.md
  - standard/brain.md
  - standard/voice.md
  - conformance/README.md
---

# The reference steward — design

Classification: **architectural**. `reference/` holds no steward; the only stewards in the
repository are the voice front's test double (`reference/voice-front/tests/fake_steward.py`), which
serves the five operations a front may call, and none in the harness. This is the core's second
build (the steward, against a minimal applier from the harness), after the
reference applier, whose slices 1 to 4 and the 0.14 reconciliation are on `main`.

## What it delivers

A reference implementation of [`standard/steward.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/steward.md) 0.9, the one level **Steward**, in TypeScript,
over exactly one applier of [`standard/applier.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/applier.md) 0.14 reached over MCP, graded by the conformance
harness.

- **What it is.** The house's authority: the house model (rooms, names, groups, persons, endpoints,
  credentials, voice records, scenarios, rules, schedules), the gate on who may do what (roles,
  tiers, the confirmation dialogue, leases, occupancy), the tokens that prove to the applier that a
  person said yes, the runs, rules and schedules it executes, the notices it delivers, and the
  audit of why. It is an MCP server to its clients (brains, panels, apps, the voice front) and an
  MCP client of its one applier.
- **What it is not.** It holds no model and no LLM: a brain is its client, and the steward never
  reads an utterance's meaning, only the record a brain sends with an answer. It hosts no safety
  rule (those are the applier's, nearest the device). It speaks no MQTT and reaches no device but
  through its applier. It resolves no names: a brain sends ids or selectors. It is not a
  meta-applier and talks to one applier only.
- **Not in the first release.** Ducking and the scenario modes `restart`, `queued` and `parallel`,
  deferred by the maintainer's ruling (*Rulings on the open questions*, Q9); their clauses stay
  `untested`. The subject claims the Steward level so the harness grades it, but no conformance is
  claimed while any of its rows is `untested`, as for the reference applier's PC rows; a later
  slice adds them.
  Every other id is planned in a slice below. What the standard leaves to implementations was put
  to the maintainer and is ruled.

The workstreams plan once named Python for this build; the roadmap's later ruling, every build in
TypeScript (the maintainer, 2026-09-27), replaces it.

## Approaches considered

**A. One package, one process, a serial core in memory, one writer behind it** (recommended). As
the reference applier: every change of the steward's state (a call, an event from the applier, a
timer) runs as one synchronous step that awaits nothing, and hands its writes to the store's single
writer. What differs from the applier is the outage policy, which the storage design already set
for the steward (*When the store is unreachable*: "stop taking work that needs a write"): an effect
that changes authority (a `define`, an answer, an apply's record and its leases, a rule's firing
number) waits for its commit; events and history are written behind. The standard's "one step"
requirements hold by construction: a change set applied whole (GA-DEF-5), a plan that changes
nothing but its `ask` event (GA-STW-1), a lease checked and granted at once (GA-LEASE-3). The
patterns of the applier's `core/` are proven, and the steward copies them.

**B. Store first: every operation a Postgres transaction, no model in memory.** Simpler restarts
(the store is the truth), and the storage design's outage rule falls out for free. Rejected: the
steward's hot paths are evaluations over live state, not writes: every applier `state` event
re-evaluates rules, occupancy and `wait` steps, and every plan reads leases, occupancy, sessions
and the applier's mirror. Doing those as queries is slower and splits one decision across reads
that can interleave with a concurrent write. The timers (leases, narrowings, delays, windows,
schedules) live in memory under either approach.

**C. Event-sourced: an append-only log of inputs, state as a fold.** It would make GA-PERSIST-2 and
the audit one mechanism. Rejected (YAGNI): a fold over 7 days of a home's events at every start,
snapshots to bound it, and migrations of a fold are more machinery than the standard's list of
durable items needs, and `history` is a view the standard defines, not the log of inputs.

## Where it lives

```
reference/steward/
  package.json          @ludentes/galatea-life-steward; bin: dist/main.js
  subject.json          the harness's subject file (standard: steward, database: true, mutations)
  migrations/           numbered SQL files, applied at start (the storage design, *Inside a build*)
  src/
    main.ts             reads the environment, wires the modules, prints "ready"
    core/               clock wiring, the queue of steps, the store and its writer, the event log, errors
    link/               the applier: MCP client, the mirror, the events follower, recovery, the notice pump
    house/              the house model, its revision, define (kinds, validation, diffs), brain_authored marks
    auth/               credentials, bindings, principals, roles, the read principal
    gate/               resolution, steps, the reason order, tiers, occupancy and sessions, leases' checks
    confirm/            plans, ask events, answers and utterance records, confirm_on, tokens
    dispatch/           apply, idempotency, re-evaluation, the applier apply, outcomes and their times, causes
    leases/             the lease table, precedence, ends and their re-evaluation hooks
    privacy/            the personal-key floor, applied to every response
    notices/            the steward's notices and the applier's, delivery, retry, notice_taken
    listen/             voice records' runtime, narrowings, front status, zone sources, announcements, ducks
    automation/         scenario runs, rules, schedules, their timers
    text/               the voice standard's normalisation and echo match, for announcements
    mcp/                the MCP server: tools, annotations, bearer, errors
    mutations.ts        the negative mutations, off unless the harness asks
  test/                 unit tests per module (vitest), on an in-memory clock, PGlite and a fake applier
```

**Dependencies:** `@modelcontextprotocol/server` 2.2.0 and `@modelcontextprotocol/node` 2.1.0 (the
server, as the applier); `@modelcontextprotocol/client` 2.2.0 (the applier link: a runtime
dependency here, a test one in the applier); `pg` 8.23.0; `@ludentes/galatea-life-schemas` (types, and validation
of every request it serves); `@ludentes/galatea-life-test-clock`. No MQTT client, no time-zone library: wall time
in the home's `timezone` is computed with `Intl.DateTimeFormat`, until
the Node line ships `Temporal` unflagged. PGlite is a test dependency.

**Reuse.** Copied from `reference/applier`, then owned (builds import nothing from one another;
the storage design puts the store interface in each build): the store interface over `pg` and
PGlite, the migration runner, the writer and its retry, the canonical JSON and `storable`, the
event log's seq-life gap and clean-stop marker, the MCP server wiring and `bearerOf`, and the
constant-time secret compare. Two pieces are the standards' own algorithms, which two builds must
compute alike or interoperate wrongly: the token's proof (HMAC-SHA256 over RFC 8785, today copied in
the harness and the applier), and the voice standard's text normalisation and echo match (today in
the Python front only). By the maintainer's ruling (Q7) both go into **one shared package** under
[`conformance/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance) (working name `@ludentes/galatea-life-binding`), which a TypeScript build may depend on, as it
depends on `@ludentes/galatea-life-schemas`: the token proof with RFC 8785, the voice normalisation and echo match
with the confusables table as data, and test vectors for each. The package exists from slice 2b,
[`conformance/binding`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/binding), with the token proof and vectors the reference applier agrees with; the
steward and the scripted stand-in import it from slice 2b (the proof) and slice 9 (the
normalisation); moving the harness's and the applier's copies onto it is their own work (the
backlog). The Python voice front keeps its port, and its tests run the package's vectors.

## The core

- **Clock.** Every time the steward reads, elapsed time included, comes from `@ludentes/galatea-life-test-clock`
  (`clockFromEnv`): the harness's source under the harness, the system clock outside it. `define`'s
  home setting `time_source` retargets it, and is accepted only while the applier's `describe`
  carries a `test_run_id` (GA-HARN-2); outside the harness it is `invalid_request`. The source is
  checked to answer before the change commits, and the clock is moved only after it has; clearing
  `time_source` returns the clock to the source it started on (ruled 2026-10-02). Periodic work
  reschedules its `setTimeout` from its own callback, so a stepped hour runs it once. No timer reads
  Node's monotonic clock.
- **Steps.** A step is synchronous: it reads and changes memory, hands its writes to the writer,
  registers any effect that waits for a commit or an applier answer, and ends. A call to the
  applier is never inside a step: a step prepares it, the call runs outside, and its answer arrives
  as a step of its own. So a slow applier holds no rule and no other client.
- **Store.** Postgres, through `GALATEA_DATABASE_URL`, as the `steward` role with its schema (the
  storage design). Migrations as the applier's. The view `history_v` is what `reader` may read. The
  tables follow GA-PERSIST-2's list (*Restarts*), plus the credentials (their SHA-256, never the
  secret) and the steward's own notices.
- **What waits for its commit.** An owner's `define` reaches memory only once it commits, the next
  waiting in line unvalidated (as the applier's `configure`). An answer is acknowledged only once
  it is kept, so a `yes` the caller saw accepted survives a crash. An apply's record (its
  idempotency key, its tokens' steps, its provisional leases) commits before its applier call is made.
  A plan with an `ask` commits before it is returned, since open plans and their answers survive a
  restart (GA-PERSIST-2). A rule's firing and a run's step use keys from a block of firing numbers
  committed ahead, so a firing never waits for the store and no key repeats after a crash
  (GA-STW-10; ruled, Q6). While the store is up, a firing's record (its
  fired state), a run's step record and a schedule's last-run mark commit before the applier call,
  so a crash never runs one twice; only while the store is known down are they
  written behind, so rules, schedules, the runs they start and runs already running go on through
  an outage. A client's `scenario_run` is a client write, refused at once while the store is known
  down, so no run's idempotency key is ever written behind. A crash during an outage can then lose them: a level rule fires again at the
  restart under a new key, and a schedule's run that happened is recorded `schedule_missed`. That is
  the third accepted loss (*Bounds*). A narrowing takes effect in memory at once and is written
  behind, so an outage never keeps a person's «не слушай» from holding (it fails closed on
  privacy; a crash before the write loses it, and the front's next `describe` shows it gone).
  Everything else is written behind: events, history, the mirror's facts, notice bookkeeping that can be derived again.
- **The store unreachable.** As the storage design says for the steward, it stops taking work
  that needs a write: while the writer knows the store is down, such a call is answered at once
  with an MCP internal error (JSON-RPC -32603, `data: { pending: false }`), and nothing is queued
  for later. A commit that stalls without the store being known down gets the same error after
  10 s, and then its effect is **dropped, never late**: a client's apply whose record commits after
  its 10 s is never sent to the applier, and each of its steps is recorded `unreachable` (nothing
  sent), so a repeat with its key finds that; nothing a person confirmed acts late (the storage
  design). A `define` or an answer whose write lands late takes effect (a change of the model or
  of a plan, harmless late). An owner's change still waiting its turn in the owners' line when its
  10 s pass is held too: it is judged when its turn comes, at its `expected_revision`, so a change
  made at a revision another has since moved past ends `stale_revision` and takes no effect
  (ruled 2026-10-02). The error's `data` says which: `pending: false`, not applied and never will
  be (the store known down, a dispatch dropped, the owners' line full); `pending: true`, held and
  judged and applied when its turn comes, unless the steward restarts first. Rules, schedules and runs go on (ruled, Q6). `describe`, `state`, `plan` without
  an ask, `events` and `zone_sources` answer from memory; `history` fails. The healthcheck fails,
  so the owner tool shows the steward broken.
- **A store fault** (a statement refused for good): the steward reports it and exits, as the
  reference applier does. The steward holds no protection (no latch, no safety rule), so the
  storage design's case for the applier running on (*A store fault*) does not apply; a restart
  reloads what is kept. A write a caller was told is `pending` is lost with it, which the
  `pending` message already says ("unless the steward restarts first").
- **Event log.** Events get the steward's increasing `seq` and the steward's time, relayed ones
  included (the applier's own time rides along as `applier_time`, and its `seq` as `applier_seq`).
  `events` is served from memory, `history` from the store after the writer has committed what was
  handed to it. Kept 3600 s in memory and at least 7 days in the store (GA-STW-7), pruned by a periodic step.
  A long-poll is a waiter released by the next event or its timeout. A cursor older than the kept
  window, pruned, ahead of the log, or from before a stop that was not clean is `cursor_expired`,
  with the applier's seq-life gap and clean-stop marker (reference applier, *Restart loss*).
  A `state` event's `speech` key and a personal key's `occurrence` events are marked `events_only`
  on their row and never reach `history` (GA-STW-7); a personal key's `state` events are in
  `history` like any other, withheld below the floor (GA-AUTH-7). The `history` operation reads the
  tables and applies the floor; `history_v`, the `reader` role's view, also leaves out every
  personal key, since `reader` is no principal the floor can judge.
  An event's withheld fields (`Keep.withheld`: a `refused` outcome's holder when it is a personal
  press's) are kept beside its readers in the `readers` jsonb, and are shown to the owner's app alone.
  `history` keeps 90 days, past the standard's floor of 7. A personal
  key's `state` events are pruned at 7 days: a design choice, for privacy, which the standard's
  floor allows (*Decisions*).
- **Bounds.** Every queue has a cap: the writer's backlog, the events held in
  memory, the follower's batch, the owners' line (16 changes, the one committing included; a
  `define` past it is refused at once, `pending: false`), the applier's events held while an
  apply's answer is awaited (4096, *Outcomes later*), and the applies a credential holds under keys
  within their 3600 s (4096; a new key past it is `invalid_request`, never made room for, since
  forgetting a key early would let its repeat dispatch again). Past the writer's cap only events' rows are dropped, never an
  owner's change, an answer or an apply's record, and the owner gets a notice. Two losses are
  accepted and named: events dropped past the cap leave a gap in `history` within its 7 days, and
  events served but not yet written when the process dies are lost from `history` across that
  restart (as the reference applier's *Restart loss*); both break GA-STW-7's and GA-PERSIST-2's
  letter only under an outage or a crash, and each expires every cursor of that life. The third:
  a rule's fired state or a schedule's last-run mark written behind during an outage and lost in a
  crash before the store returns, which can send a rule's action twice (GA-RULE-1) or record a run
  that happened as missed (GA-PERSIST-2).

## The applier link

- **The MCP client.** One session to the applier at `GALATEA_APPLIER_URL`, with the bearer
  `GALATEA_APPLIER_CREDENTIAL`, negotiating revision `2026-07-28` first and falling back to
  `2025-11-25` or `2025-06-18` only where the applier does not serve it, and to nothing else
  (GA-BIND-2). The revision reached is logged and shown in the health output. Off loopback the URL
  must be `https`, and the certificate is validated against the system's store or the CA at
  `GALATEA_APPLIER_CA`; an invalid one is refused, never retried insecurely (GA-SEC-2). The session
  is re-made with backoff (250 ms to 5 s) when it fails.
- **The mirror.** At start: the applier's `describe` and `state`, then `events` from the cursor
  `describe` was read under. The mirror holds every device the applier describes (class,
  capabilities, actions with their effective tiers, `toggles`, `idempotent`, `ack_within_s`,
  `feedback`, `fresh_s`, `fresh_slack_s`, `personal` keys, `adopted`, `internal`, `infrastructure`,
  `accounts`, extensions) and every value with its `basis_time`, `assumed` mark and liveness. A
  `model` event re-reads `describe` (the applier's `describe` does not long-poll) and moves the
  house revision (GA-HOUSE-1). The applier's `standard_version` is kept for GA-NOTE-2. The
  applier the house last followed is kept as its `applier_id`, `test_run_id` and revision together,
  so the first `describe` after a start moves the house's revision only when one of them differs: a
  restart alone makes no plan stale, and another applier, or a reset one, at the same revision number
  does (slice 2b).
- **The events follower.** A loop outside the steps long-polls the applier's `events` (`wait_s`
  30) and hands each batch to a step, which updates the mirror, relays the events into the steward's
  log with their causes, and runs what they trigger: leases (external, load cap, safety rule),
  rules, `wait` steps, occupancy, outcome bookkeeping, zone sources. `notice_taken` rides on the next
  call (*Notices*).
- **Recovery.** On `cursor_expired`, or a session re-made after a gap: re-read `describe` and
  `state`, read the applier's `history` from the time of the last event the steward had, record the
  events it missed in its own log, grant the leases the missed `external` and `load_cap` changes
  would have taken for what is left of their hold (GA-LEASE-2), re-read held latches and settle
  latchless safety rules' leases from `rule_fired` (GA-LEASE-6), then evaluate every level-triggered
  rule (GA-RULE-1).
- **The applier out of reach.** The mirror marks every device's liveness as the applier last said
  it, but `stale` on top of it for the steward's own judgements: no condition holds (GA-RULE-2), no
  room is `vacant`, so the steward fails closed. A plan made then reports each step `skip(dead)`,
  not an error: the steward cannot know more (*Decisions*); the steward's health output, not the
  plan, says that the applier is out of reach. An apply whose applier call was never sent (no session) ends its
  steps `unreachable`, and is not retried; one sent whose answer was lost is *The applier call*'s
  case.
- **A port, for tests.** The link is an interface (`ApplierPort`: describe, state, plan, apply,
  outcome, events, history) with the MCP implementation and an in-memory fake, so every unit test
  of the gate, the rules and the runs runs without a socket.

## The house model and `define`

- **The model.** Home settings, rooms, the target overlay (names, aliases, room, `account_persons`)
  keyed by the applier's device ids, groups, persons, endpoints with their voice records,
  credentials, scenarios, rules with their exceptions, schedules with theirs, narrowings, and the
  `brain_authored` marks (slice 10: on a rule, a scenario, a schedule and a moved date; a target's
`room_brain_authored`; a group's `brain_joined`, the members it gained through a brain). Targets are the mirror's devices joined with the overlay: `describe` shows
  everything the applier describes for each, plus the overlay (GA-DEF-11's `account_persons` beside
  the applier's `accounts`, untouched).
- **The revision.** One counter, moved by every committed `define`, every narrowing granted, lifted
  or expired, and every applier `model` event; never by a state change (GA-HOUSE-1). `describe {
  since_revision, wait_s }` waits on it.
- **`define`.** A change set `{ op, kind, value }`, as the applier's `configure` envelope. Each
  `kind` has a validator and an apply function in one table: `home`, `room`, `target`, `group`,
  `person`, `endpoint`, `credential`, `voice`, `lift_narrowing`, `scenario`, `rule`,
  `rule_exception`, `schedule`, `schedule_exception`. The shape of each `value` is the standard's
  table where it gives one, and provisional where it does not; the first plan writes each as a
  schema under [`conformance/schemas/steward/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/schemas/steward), shared with the harness (*Standards fixes this build
  shows*). The whole set is validated against the model it would produce, then applied in one write
  set, or refused, changing nothing (GA-DEF-5); `dry_run` returns the diff and changes nothing
  (GA-DEF-1); a stale `expected_revision` is `stale_revision` (GA-DEF-2). The cross-object checks run
  on the result: GA-DEF-4 (cycles), GA-DEF-8 (endpoints and voice records), GA-DEF-9 (unadopted),
  GA-DEF-10 (internal), GA-DEF-11 (account mappings), GA-CONF-4 (`confirm_on`), GA-RULE-3 and
  GA-RULE-6 (windows and exceptions), and the notices `define` owes (GA-RULE-2's unknown bound,
  GA-RULE-8's toggles, the wake-word names under *Listening*).
- **Who may.** An owner at an endpoint not served by a brain, any change set; anyone else
  `not_permitted` (GA-DEF-3), except a `define` through a brain that the steward's policy accepts,
  which becomes a plan with one `ask(confirm_define)` step carrying the diff (GA-DEF-6). That policy
  is ruled (Q4): none until slice 10, so every `define` through a brain is `not_permitted`; from
  slice 10, the `owner` role only, for scenarios, rules, schedules, exceptions, names, rooms and
  groups (`brainMayDefine`). A brain's `define` is planned outside the owners' line and kept as any
  asked plan; `define { plan_id }` is checked as `apply` checks a plan and applied in the owners'
  line, or, unanswered or answered no, spends the plan (`skipped: not_confirmed`).
- **The first owner.** The standard does not say how the first owner, endpoint and credential come
  to exist, since `define` needs an owner to call it. Ruled (Q2): at a start with no person in the
  store, `GALATEA_OWNER_CREDENTIAL` creates person `owner` (role `owner`), endpoint
  `owner-app` (`type: app`, that person, room null, served by no brain) and a credential bound to
  it; once an owner exists the variable is ignored. The owner tool holds that credential; the owner
  renames, adds and removes from there.

## Clients, endpoints and principals

- **Credentials.** Each is `{ id, kind: app · panel · brain · front, secret, endpoint?,
  confirm_on? }`: an `app` or `panel` credential names its one endpoint; a `brain` credential is
  bound to the endpoints whose `served_by` names it and may carry its own `confirm_on`; a `front`
  credential to the endpoints whose voice record's `heard_by` names it (GA-AUTH-8). The secret's
  SHA-256 is kept, compared in constant time, on every request, at every revision. An unknown bearer
  is `not_permitted` (GA-AUTH-4).
- **The principal of a request** is derived in one function used by every operation that names an
  endpoint (`plan`, `apply { request }`, `answer`, `define`, `scenario_plan`, `scenario_stop`,
  `narrow`, and the reads): the endpoint must be bound to the credential (GA-AUTH-1, GA-AUTH-6);
  `via` is its `type`, `brain` whether it has `served_by`; the person is its `person`, or a
  `speaker` accepted only from a brain credential at a brain-served endpoint with no person, naming
  a registered person (GA-AUTH-2); the role is the lower of the person's and the endpoint's
  `max_role`, with the standard's defaults, no person meaning guest. A brain's read naming no
  endpoint has no role (GA-AUTH-6). A front credential reaches only its five operations
  (GA-AUTH-8), and its `describe` is filtered: only its endpoints, each with `type`, `person`,
  `served_by`, the voice record, the effective record and the narrowings; the registered persons'
  ids; and the home's `audio_retention_s` and `other_wake_words`. No targets and no rules.
- **Principals of work with no endpoint** (GA-AUTH-5): a rule's actions `via: rule`, a scheduled
  run's `via: schedule`, a person-started run the `via` and `brain` of its starting endpoint, a
  rule-started run and a duck `via: rule`.

## Plans and the gate

- **Resolution.** A request's actions resolve to steps: a target id as given; a selector to every
  device and channel matching all its fields, in code-point order of ids, never a group, never an
  `infrastructure`, `internal` or unadopted device (GA-PLAN-5, GA-PLAN-6); a group to its members,
  leaving the same out. Identical `(target, action, args)` merge; one target and action with
  different args is `refuse(conflict)` on each, except `session.lock` with different `account`s
  (GA-STW-2). A `session.lock { person }` resolves to one step per mapped account, in code-point
  order, or `refuse(invalid_args)` (GA-STW-11).
- **The applier's plan.** The steward plans the resolved steps on the applier, without tokens, with
  each step's `via`, `brain` and a `for` naming the endpoint principal (no `apply` yet). The applier
  plan is read and discarded; the steward never applies it (GA-STW-10).
- **The reason order** is one ordered list of checks, each a pure function of the step, the
  principal and a snapshot (the mirror, leases, occupancy, sessions, answers), merged with the
  applier's step: the applier's reasons first in their places, then `conflict`, `role`, `tier`
  (`refuse(tier)` for `no_voice` through a brain or a brain-authored step above `reversible`;
  otherwise the applier's `refuse(token)` read as `ask(confirm_tier)`), `already`, `leased`,
  occupancy (sessions before rooms), `toggle_only` (the applier's `refuse(toggle_only)` read as
  `ask(toggle_only)`, replacing any other ask the step would have). The first that applies is
  reported (GA-STW-4). One table, so the order is visible in one place and each reason is one entry,
  as the applier's gate is built.
- **Tiers.** The effective tier is the applier's, from its plan step (GA-TIER-*). The steward never
  computes a tier itself.
- **Planning changes nothing.** A plan is held in memory (and in the store when it has an ask),
  with `plan_id`, `expires_at` (60 s, or `ask_expiry_s` with an ask), the revision, the credential,
  endpoint and speaker, the request and the steps. The only event is the `ask` (GA-STW-1, GA-CONF-5).
  A `notify` step whose caller set `from` is marked `from_replaced` (GA-NOTE-2).

## The confirmation dialogue

- **The ask.** For every plan with an `ask` step, an `ask` event `{ plan_id, step_ids, endpoint,
  time }`, its endpoint the plan's, or the `confirm_on` that applies (the endpoint's, else its
  brain credential's) (GA-CONF-5).
- **Answers** are checked in the standard's error order: `invalid_request` (unknown plan, a bad
  utterance record, a step not asked), `not_permitted` (another credential, endpoint or speaker,
  GA-CONF-1, and GA-CONF-6's checks), `plan_expired`, `stale_revision`. For an answer from a
  brain-served endpoint, the utterance record is checked as GA-CONF-2 says: the time against the
  latest `ask` event for that step less the clock tolerance and against the arrival plus it; reuse
  by `utterance_id`, or by `endpoint`, `time` and `transcript` together, against every record kept;
  `asked_by` against the voice record where the endpoint has one; and the addressing against the
  configured record and the narrowings in force longer than the narrowing delay (GA-CONF-6). Records
  are kept with the plan they answered, in the store, until every plan whose `ask` came before the
  record's time plus the tolerance has expired, so a restart forgets none that could still be
  reused. An answer stands for its step and its reason; a later `no` from the same place replaces a
  `yes`; a `yes` after a `no` is `invalid_request` and changes nothing (a new plan is needed;
  the standard names no error for it, *Standards fixes*).
- **Tokens.** At dispatch, for each step answered `yes` (or authored, *Authored work*), a token `{
  token_id, issuer, target, action, args, via, brain, for, expires, proof }`: `issuer` is the
  steward's client id at the applier (`GALATEA_APPLIER_CLIENT`), `for` the step's cause with the
  `apply_id`, `expires` 60 s after issue, `proof` HMAC-SHA256 over the token without `proof` in RFC
  8785 form, keyed by `GALATEA_APPLIER_TOKEN_KEY` (the applier's binding, as its reference build
  checks it). No token for a step no one answered `yes` and no author confirmed (GA-CONF-3). Tokens
  are kept in memory with the apply until its applier call is answered, so a repeated call carries
  the same ones; after a restart a repeat carries fresh ones, which the applier's idempotency
  compare ignores.

## Apply and dispatch

- **The two steps of an apply.** The first, synchronous: authenticate, validate, claim the
  `idempotency_key` for the credential (a repeat returns the first apply, another body
  `idempotency_conflict`; GA-STW-6), check the plan (`plan_expired`, `stale_revision`,
  `plan_not_yours`; GA-STW-5), re-evaluate `leased` and occupancy at dispatch keeping the answers
  given (GA-STW-8), turn an unanswered ask into `skipped(not_confirmed)` (GA-APPLY-3), mint the
  tokens, build one inline applier request of the dispatchable steps in order (GA-STW-3, GA-STW-10)
  with `via`, `brain`, `for` and `from`, lay **provisional** `person` leases over the stateful
  steps' devices (but `session.lock`), so that no rule acts between dispatch and the applier's
  answer; a provisional lease sits on top of any lease the device holds and replaces nothing yet
  (two applies in flight on one device each lay their own; each settles on its own answer, and the
  later dispatch's lease is the one that stands),
  and emits no `lease` event; then hand the apply's record to the writer. The applier call waits for that commit. The
  second step takes the applier's answer: passes its outcomes through, adds the steward's own,
  stamps each with its `time` (GA-STW-12). For a step whose outcome is `dispatched`, the
  provisional lease becomes the device's lease, from dispatch, a person's hold judged by the home's
  hold policy (*Leases*), replacing the one it lay over (GA-LEASE-3), with its `lease` event; for every other step (refused, skipped,
  `unreachable`) it is lifted and the earlier lease stands untouched (GA-LEASE-1, 2). Lifting it
  re-evaluates as a lease's end does (GA-LEASE-4), since a rule refused meanwhile may now act.
  Then it records events and answers. `apply` with `{ request }` plans and applies in one call, its asks `refused(tier)` and
  its toggles `refused(toggle_only)` (GA-TIER-2, GA-STW-4).
- **The applier call.** `apply { request, idempotency_key: apply_id }`. Two cases, kept apart. A
  call never sent (no session to the applier) ends its steps `unreachable`, nothing sent, and is
  never retried. A call sent whose answer was lost may have dispatched, so it is never reported
  `unreachable` on a guess: it is repeated with the same key, which the applier answers from its
  record for 3600 s (applier GA-APPLY-4), so it never dispatches twice; repeats stop 10 s after the
  first try, so no step, a `reversible` one without a token included, is sent later than that.
  The caller then gets the -32603 error with `data: { pending: true, outcome_unknown: true }`
  (the apply is kept; its outcomes are not yet known). Not built in slice 2b, for the reason under
  *Standards problems found* (the applier's `outcome` takes its own `apply_id`): when the session returns, within the
  applier's 3600 s key window, the steward asks the applier `outcome { apply_id }`: an answer gives
  the outcomes, and `unknown_apply` means the applier never took the call, so every step is
  `unreachable`. Past that window the outcomes stay unknown, and are reported as `failed` with no
  claim that nothing was sent. A repeat
  of the caller's apply with its key, or `outcome`, then shows the result. A rule's firing
  uses the key `rule:<id>:<n>` and a run's step `run:<run_id>:<index>` (GA-STW-10).
- **Outcomes later.** The applier's `outcome` and `late_ack` events update the apply's record and
  the run's steps; `outcome { apply_id }` returns the current outcomes with their times, to the
  credential that applied (others `unknown_apply`), for 3600 s. The steward stamps its own time on
  each relayed `outcome` event and returns that time (GA-STW-12). An outcome only moves forward
  (unknown, then dispatched, then final): an applier event that would move it back, or that repeats
  what the applier's answer gave, is not relayed. While an apply's answer is awaited every batch of
  the applier's events waits, so an `outcome` event of that apply names the steward's apply and the
  steward's own `outcome` comes before the changes the apply caused; past the cap the batches are
  relayed, and the outcome events of an apply not yet known are held, under the same cap, for its
  answer.
- **Causes.** The steward's `for` is `{ person, endpoint, apply }`, `{ rule }`, `{ run, schedule?,
  person?, endpoint? }` or `{ front, endpoint }`; a run started at an endpoint always carries it
  (GA-SCN-3). The applier's causes (`safety_rule`, `load_cap`, `device`, `external`) are relayed as
  they come.
- **Speed.** GA-STW-9 (200 ms over the applier's bound) holds when the apply's commit and the
  applier call are each one round trip on the box. Measured in slice 2b; the applier link keeps one
  session open so no call pays a handshake.

## Leases

A table of `{ holder, targets, precedence, expires }` in memory and the store, with a timer per
expiry. Granted: an endpoint principal's dispatched stateful action, not `session.lock` and not a
narrowing action, from dispatch, ended if the step ends `unreachable` (GA-LEASE-1); an `external` or
`load_cap` change, at person precedence, only for a key one of the device's actions sets on an
adopted device (GA-LEASE-2); a safety rule's actuation, until its latch clears or, latchless, its
`rule_fired` (GA-LEASE-6); a run's `owned` targets until it ends, released by run (GA-SCN-2). Never
for a rule's action (GA-LEASE-5), but a press (below). Every end runs one hook that re-evaluates the
level-triggered rules naming the devices (GA-LEASE-4). A person's provisional lease lifted because
its step sent nothing is no lease's end. It runs the hook only if it refused a change meanwhile (the
milestone review's B6, milestone ruling Q7, provisional). A `person` lease's precedence follows the
principal: a person, `external` or a person-started run.
A person's lease kept by a steward from before 0.12 has no hold state, so it is not carried:
migration `0015_lease_hold.sql` drops every lease at `person` precedence that is not a run's, and the
device is free until its next change.

**The policy.** `HoldPolicy` (`house/model.ts`) is the home's `hold`: `on_s`, `off_s`, `other_s`,
`fixed_s`, `load_cap_s`, `cap_s`, and the flags `presence_renews`, `vacant_ends`, `schedule_ends`
and `owner_work_passes_guest_holds` and `owner_work_passes_holds` (GA-LEASE-7, GA-LEASE-8, GA-LEASE-12). `HOLD_DEFAULTS` holds the reference
values: 3600 s for `on_s`, `other_s`, `fixed_s` and `load_cap_s`, 600 s for `off_s`, `cap_s` 43200 s
(0: none), `presence_renews`, `vacant_ends` and `owner_work_passes_guest_holds` true, `owner_work_passes_holds` false. They are an
example, declared in `describe`, never asserted by a check. `define` merges the fields it names
(a client may set one at a time) and the schema bounds a window at 1 s; a `null` for a field puts
its reference value back, and a `null` hold puts them all back. The reference
refuses `schedule_ends: true` with `invalid_request` and `data.field` `schedule_ends`: it ends no
hold at a scheduled dispatch (GA-LEASE-8 allows a flag not implemented, and a second dispatch path
is a cost the maintainer ruled out), so the harness skips the subjects that need it.

**Judging a hold.** `judgeHold` (`leases/hold.ts`) is a pure function of the hold's state, the
policy, the room as it stands (`RoomNow`: its live presence sources, whether one reads presence, the
occupancy and when the room would turn `vacant`) and now. It returns the new state, the hold's
`expires` (windows, `cap_s` and the floor, never a predicted vacancy), when to judge again and the
end, if any, with how it ended: `quiet`, `window`, `cap`, `vacant`, `schedule`, `replaced`,
`unreachable` or `removed`. `Holds` (`leases/holds.ts`) owns when a hold is judged: on a presence
report in its room, a `define` (the policy, a room), the applier's model (a source adopted or
removed, a device gone), an ack, a late ack, and its own timer, armed at the hold's `expires` or at
the predicted vacancy if sooner, or, for a guest's hold, at its floor (R-63), which re-evaluates what
the hold refused. A busy room keeps a hold whose `expires` passed: the timer re-judges
and does not end it. Nothing is judged before the first state after a start has been read (`begin`);
a gap is replayed by `replayAt`, each event judged at its own time clamped to the steward's last live
reading and the read-back. A hold ends at its computed end and never more than the hold end
lateness (2 s) after it.

**The clock.** A hold's windows run on elapsed time, so a step of the wall clock moves none; what a
hold shows (`expires`, `quiet_since`, `end_time`) and what the store keeps are wall instants.
`TimeBase` (`leases/time-base.ts`) relates the two by one offset that `LeaseTable` and `Holds`
share: sampled once, sampled again only when the two clocks part by more than 100 ms (a step), and
rounding a wall instant to the millisecond, so an instant born on the wall clock (a dispatch, a gap
event's time) comes back as the same integer. Under the harness, with no separate elapsed clock
(GA-HARN-2), the offset is 0 and every step of the test clock moves a hold, as the standard asks.
Outside it, `start.ts` reads elapsed time from `performance.now()`, a monotonic clock that on Linux
does not count a suspend: a hold's windows stop while the host sleeps, so on a host that suspends a
hold outlives its window in wall time by the suspend's length (`TimeBase` re-samples its offset on the
jump, so nothing else moves). An always-on hub never suspends.

**Who holds, and what passes.** An apply's step takes a person's hold whose `role` (the apply's
derived role) it keeps; the guest mark is that role being `guest` (`guestsHold`), and a hold taken
by a brain-served endpoint with no person is a guest's. A rule whose `occurrence` trigger carries
`press: true` acts at `person` precedence and, once dispatched, holds a person's hold whose holder
is `{ rule, press }` (`isPress`), replacing a person's hold or a guest's and restoring the replaced
hold if its own step ends `unreachable` while it is still the device's lease (GA-LEASE-9). A
narrowing action (`isNarrowing` in `leases/narrowing.ts`: `lock.lock`, `valve.close`, an `onoff`
valve's closing action, never a `toggles` action) passes a person's hold, replaces none and takes
none, and ends a lower lease it displaces (GA-LEASE-11). The owner's rules and schedules pass a
guest's hold once its floor has passed, while `owner_work_passes_guest_holds` is declared
(GA-LEASE-10); the floor passing tells `Holds`' `floorPassed`, which re-evaluates the rules the hold
refused. A personal press's hold is withheld as its occurrence is (GA-AUTH-7): its lease events are
marked personal, and so are the end of the hold it replaced and the grant that restores that hold,
through the `other` holder `LeaseTable` passes, since either would show the press's moment. Its
`press.value` is withheld from the owner too, until the personal floor (slice 8), and a `refused`
outcome against it withholds its holder.

**One place a step meets a lease.** `leaseRefuses` (`leases/table.ts`) is the only place a change's
precedence and what it may pass (`Passing`: `press`, `ownerWork`, `narrowing`) are set against the
lease it meets, a provisional lease first and, under it, the device's own (`Met`, `beneath`).
Refused is `leased` with the holder (`gate/reasons.ts`); the order of reasons is unchanged
(GA-STW-4, GA-LEASE-3).

**The owner passes a person's hold** (GA-LEASE-12, steward 0.13). Three switches, each stored with
what it marks: a rule's `passes_holds` (`Rule`), a device's `owner_work_passes_holds` (the target
overlay) and the home's `owner_work_passes_holds` in the `hold` policy (`HOLD_DEFAULTS`: `false`).
`brainMayDefine` (`house/brain.ts`) keeps all three from a brain (GA-DEF-3): through a brain a switch is
compared, not looked for (R-7), so naming one at its current value is no change, another value, or
deleting a rule or target whose switch is `true`, is `not_permitted`, the whole change set. A rule's
`passes_holds` is outside the `whole` check, since a brain can never write it (R-12); the harness
accepts a refusal of a switch named at its value as well as a no-change (R-13).

`passedBy` (`leases/table.ts`) is the one place a step meets a lease's pass: given the lease it meets
(`Met`, with `sinceMs`) and what the step may pass (`Passing`: `switches`, in the order rule, device,
home; `press`, `ownerWork`, `narrowing`), it names the first thing that passes it, a `PassedHold` of
holder and switch, or nothing. `leaseRefuses` goes through it, so the guest flag (GA-LEASE-10), a press
and a narrowing pass the same way the switches do. The floor stands over every switch: none passes a
`safety_rule` or `load_cap` lease, a run's lease, or work a brain authored; and a person's hold keeps
its floor (GA-LEASE-7) against a switch until the person's own report, the key and value the step's ack
is matched on, ends it early: `reportOf` (`house/action-keys.ts`) gives it from the standard action
table or an extension action's `confirmed_by`, and `HoldState.reported` and `Holds.reported` carry it (R-6).
An action declared `toggles` has none, so its floor ends by success or time. A provisional lease records
the report too. The report must match the value exactly (`canonical`), not within the tolerance the
applier acks by (GA-EVT-3): a dimmer reporting 29 for a set of 30 is acked but ends no floor early, and
its floor ends at the ack instead. This fails toward refusing, so nothing unsafe comes of it.

A rule firing keeps the holds its steps passed across a restart: `passed` goes in the firing's stored
record, so the `passed_hold` of a step judged before the stop is the one an outcome after it shows.

A run waits on every hold a switch covers at its start, inside the floor too (R-4), and more: an owner's
run keeps every owned device it cannot lease at its start in question (`Run.waiting`), whatever lease
kept it off (a passed hold, or one held higher), and takes its lease once the lease that kept it off
ends, of whatever kind, before GA-LEASE-4's re-evaluation. A replacement keeps the device in question
whatever the new hold is; only R-1 drops a device from a run for good, when a person's change replaces
the run's own lease, a guest's too. R-2's first form, which dropped a device replaced by a hold the run
did not pass, is retired: a switch applies at once to holds already held, so whether a run passes a hold
is not fixed at its replacement. The cost is a later lease, nothing unsafe, as a lease only refuses.
A run's step is read as its `scenario_status` entry, which has no plan a client reads (R-5).

`passed_hold` (`{ holder, switch }`) goes on a step's `apply` outcome, on `scenario_status`'s `sent_steps`
and `failed_steps` and on `outcome` events, judged at dispatch (R-8); a refused step never carries one.
It is withheld as the occurrence is (GA-AUTH-7): a personal press's hold passed by the owner's rule shows
no `passed_hold` to a reader the occurrence is withheld from, in any of the three places (`passView`,
`passedKeep`); the owner sees its holder's press value as `withheld` until the personal floor (slice 8).

The home's switch is the only one withheld from a step that undoes a narrowing (`lock.unlock`,
`valve.open`, an `onoff` valve's `opens_with`, declared `toggles` or not): `rule` and `device` still pass
it, and so does the guest flag (R-9; built last in the build, with the narrowing undone). The text's
"which only the rule's or the device's switch passes" is read as among the three switches; the backlog
holds the question.

**No migration.** The switches are in the house model and the policy, the run's waiting devices are in
memory as a run is, and a hold's `reported` is part of the hold state the store already keeps as JSON; a
steward from before 0.13 reads every switch as `false` and no report.

## Occupancy and sessions

Computed on demand from the mirror, never stored. Per room: `occupied` if an `occupancy` sensor
reads presence or a motion sensor reported motion within `occupancy_hold_s`; `vacant` only with at
least one occupancy sensor, every one `live` throughout the hold with a known `fresh_s` that, with
its `fresh_slack_s`, is within the hold, and none reporting presence in it; otherwise `unknown`, and
always for a target with no room (GA-OCC-1). "Live throughout the hold" needs each sensor's liveness
changes over the last hold, kept in memory; after a start the history is empty, so every room is
`unknown` for one hold, failing closed. Sessions for a computer's `power.sleep` and
`power.shutdown` under `respect_occupancy`: `ask(in_use)`, `ask(in_use_unknown)` or the room check,
as GA-OCC-3 orders them, from `session.<account>` keys and `account_persons`. A mapped token that
leaves a computer's `accounts` (seen on a `describe` re-read) raises GA-NOTE-3's notice once.

## Personal keys

The floor is one filter on the way out of every operation, never scattered through the code: given
the call's derived role (or none, for a brain read naming no endpoint) and the applier's `personal`
marks, it replaces each personal value with `withheld` in `state`, plans, outcomes,
`scenario_status`, `rule_fired`, the `scenario` events and `history`/`events`, and drops personal
keys' `state` and `occurrence` events from the event lists (GA-AUTH-7). An `if` or `wait` on a
personal key is stored with its value and shown by its verdict only. Who reads beyond the floor is
policy, ruled (Q5): every value to `owner` and `member`, and to no one else.

## Notices

- **The applier's.** Every notice in the `notices` of an `events` response is delivered on each of
  the home's `notice_channels`: a `notify` (with `from: { notice }` from applier 0.10 on, none
  before; GA-NOTE-2) dispatched as one applier apply, retried at most every 60 s, for ever, until a
  channel's `notify` ends `delivered`, or `sent` on a channel that reports no receipt; only then is
  `notice_taken` sent with its id (GA-NOTE-1). A channel that announces speaks it once, is never
  retried and never counts as delivery, and its text passes GA-LISTEN-4's checks.
- **The steward's own** (GA-NOTE-3, GA-RULE-2, GA-RULE-8, GA-LISTEN-2, the wake-word names) take
  the same path from a table of the steward's notices, each with an id, kept until delivered, and
  recorded as `notice` events.
- **The delivery's principal** is not defined by the standard: a notice's `notify` needs a `via`, a
  `brain` and a `for` at the applier, and the cause list has no notice cause. This build sends `via:
  rule`, `brain: false` and `for: { notice: <notice_id> }` (*Standards problems*).

## Listening

- **Records and narrowings.** Voice records are part of the house model, changed by `define` only.
  `narrow` from any credential bound to the endpoint, any role, or its front, asking for nothing
  wider, until at most 12 h (GA-LISTEN-1); each narrowing, lift and expiry moves the revision and is
  a `narrowed` event with its cause. The effective record is the field-by-field narrowest of the
  configured one and every narrowing in force.
- **What the front reports.** `front_status` replaces the front's last report in memory (models,
  clips, effective records with their reasons, frames, skills); `describe` shows it per endpoint. A
  reason other than `configured`, a narrowing or a mute raises a notice once per change of reason,
  `offline` only after the offline grace (a timer), and narrowings not made at an owner's own
  endpoint holding an endpoint narrowed 24 h in a row raise one too (GA-LISTEN-2).
- **Sources.** `zone_sources` lists every `media` target whose `speech` is not null, from the
  mirror, and every announcement and spoken notice the steward dispatched, from dispatch until its
  target's `speech` reports it ended, bounded by the announce hold as GA-LISTEN-3 says. A version
  counter is its cursor; a long-poll waits on it. A `media.announce` to a target reporting no speech
  while one is listed there is `refuse(conflict)`.
- **What may be announced.** Every `media.announce`, and every spoken copy of a notice, is checked
  against every endpoint's wake words and the home's `other_wake_words` (whole words, both readings,
  and the echo match with the listed word as the transcript), and, while an ask at a brain-served
  endpoint is open, against `answer_words` (GA-LISTEN-4). The normalisation and the echo match are
  the voice standard's, from the shared package (ruled, Q7), whose vectors the Python front also runs. A
  spoken notice held for an open ask waits at most `ask_expiry_s`, and is checked again at dispatch.
- **Ducking.** A MAY, deferred (ruled, Q9): this build ducks nothing, and `speaking` is accepted
  and recorded only. When a later slice adds it: per room, for `media` targets that declare
  `media.duck` `reversible` and not `toggles`, never a target another cause ducked, un-ducking only
  its own on `on: false`, a lost front connection or 60 s without word (GA-LISTEN-5), the ducks
  kept in the store so a restart un-ducks them.

## Scenarios

- **Definition.** As the standard's table; `run` steps checked for cycles at `define` (GA-DEF-4);
  `describe.modes` lists `single` only, and `define` refuses a scenario of another mode with
  `invalid_request` (GA-SCN-5; the other three deferred, milestone ruling Q9). A start that `single` ignores
  returns the running run with `ignored: true` (GA-SCN-1).
- **The run limit** (restored, 2026-10-02, *Why the main choices*): every run ends
  `ended(timeout)` once it has run for the run limit, a constant of this build (6 h, ⚠️ a guess),
  its steps not yet dispatched never sent and its leases released. Steward 0.9 defines
  `ended(timeout)` for a `wait` that times out with `stop`; it is the closest status it allows, and
  the reuse is listed under *Standards problems*.
- **Plans and runs.** `scenario_plan` gives one step per action step, `run` steps expanded, `if`
  branches planned as taken and marked `conditional` (GA-SCN-6). `scenario_run` takes the plan's id
  and an `idempotency_key`. A run is a small state machine driven by steps and clock timers: an
  action step is re-checked at dispatch (GA-SCN-7) and sent as one applier apply; `delay` is a
  timer; `wait` a waiter on the mirror with its timeout timer (GA-SCN-10); `if` read from the
  mirror when reached, `skipped(dead)`, `skipped(stale)` or `skipped(assumed)` with no `else`
  (GA-SCN-8). A run holds `run` leases on its `owned` targets (GA-SCN-2), acts as its starter
  (GA-SCN-3, GA-SCN-4), and can be stopped (GA-SCN-9). A toggle step
  dispatched more than `ask_expiry_s` after its `yes` is asked again as a new `ask` event, the run
  waiting on it (GA-SCN-3; *Standards problems*). Each step's outcome is kept for
  `scenario_status`, with `failed_steps` and `sent_steps` as GA-SCN-11 counts them.
- **A change from 0.12 an owner will see.** An owner's scheduled or rule-started run now takes its
  lease on an owned device when a person's hold it could not lease at its start ends, whether it
  passed that hold or not, and before GA-LEASE-4's re-evaluation (*Leases*). So a level rule that
  person's hold refused is refused again, by the run's lease, instead of firing at the hold's end as
  under 0.12. This is within GA-SCN-2 ("a running scenario leases its owned targets"), and the
  backlog asks the text to say it.

## Rules

- **The language** is the standard's in prose, with provisional shapes (*Standards fixes*): a
  trigger `{ state }`, `{ held, for_s }`, `{ event }` (a `liveness` event included) or `{ time }`,
  or none for a rule of conditions only; conditions over state (`op` and `value`, or `not_in`), time
  and `between` windows; actions as a request's, each with `respect_occupancy`; `active`;
  `exceptions`.
- **Evaluation.** Each rule has a compiled condition over the mirror and the clock, re-evaluated on
  the events that touch its keys, its window boundaries (a timer at the next one) and its exceptions'
  ends. Level-triggered rules (held states, conditions only) fire once per becoming true, and keep
  "fired since it last became true" in the store, so after a restart or `cursor_expired` one fires
  only if it has not (GA-RULE-1). Conditions on a device not `live`, or on an `assumed` value, are
  false (GA-RULE-2); `not_in` reads absent and `unknown` as true except a retired session key
  (GA-RULE-4). A lease ending, or an exception ending, re-evaluates (GA-LEASE-4, GA-RULE-6).
- **Firing.** One applier apply per firing, keyed `rule:<id>:<n>`, at `rule` precedence, with
  `via: rule`, authored tokens unless `brain_authored` (GA-SCN-4, GA-DEF-7), occupancy asks turned
  into skips (GA-SCN-4).
- **After the outcome.** A retry table for GA-RULE-7 (idempotent actions of rules of conditions
  only, the three retryable outcomes, the spacing between `ack_within_s` and 300 s; one more try for
  `unanswered`), and a held-notice table for GA-RULE-8 (the late-ack waits for `failed(not_locked)`
  and `failed(no_ack)`, at once for `failed(no_graphical_session)`). Held notices are kept in memory
  from slice 4, and from slice 11 as `rule_pending` rows of kind `held` with the end of their wait,
  written behind, read back at a restart and armed once the start's gap is read (GA-PERSIST-2). A
  firing the applier answered is a row of kind `sent` until every step it sent ends, so its outcome
  given while the steward was down still goes to the retry and held-notice tables (slice 11). A pending retry is written behind as a `rule_pending` row from slice 4,
  and the next start fires the rule again (the milestone review's I3, milestone ruling Q6). A retry is a new
  firing of the failed steps only, under its own number.

## Schedules

A pure decision core: given the clock's now, the home's `timezone`, the schedule's time
and days, its exceptions and its last run, it returns the next run time (a daylight-saving gap
moved to the first minute after, a repeated time taken once at its first occurrence; GA-SCHED-3).
One clock timer per schedule, to that time. A run's last-run mark commits before the run starts
(so a crash never runs a time twice), and is written behind only while the store is known down (ruled, Q6); a crash that loses
it cannot run the time twice, since at start a time after the last mark is `schedule_missed`, never
run late. At start, every scheduled time between the last run
and now is a `schedule_missed` event and is not run (GA-SCHED-2). Exceptions skip or move exactly
their date's run (GA-SCHED-1); a skip is a `schedule_skipped` event. A run started acts at
`scheduled_run` precedence, `via: schedule`, authored (GA-SCN-4).

## Authored work and work through a brain

Rules, and runs a schedule or a rule starts, count their `confirm` and `no_voice` steps as answered
by their author, and get authored tokens (`for` naming the rule or run, `brain: false`), never
answering a toggle (GA-SCN-4). Work defined through a brain is marked `brain_authored`, and the mark
spreads as GA-DEF-7 says (runs it starts, runs a brain moved, devices a brain put in a room or
group, until an owner's `define` sets them again); `describe` shows it; its steps above
`reversible` are `refuse(tier)` and go with `brain: true`. Built with the brain `define` policy in
slice 10: `markBrain` marks what a brain created or changed before the diff, so the person asked
reads the marks; an owner's upsert rebuilds the object without them. A step is marked at
resolution (`Resolved.brain`): a marked rule's every step, a run's every step when a marked rule or
schedule started it or a brain moved its date (`Run.brainAuthored`), a marked scenario's every step
whoever runs it (`ActionNode.brain`), and, for authored work, a device reached through a room or a
group it joined through a brain (`ResolveView.authored`). The tier entry of the gate judges the mark
first; a marked notify's `from` carries `brain_authored: true`.

## Restarts

Kept in the store: the house model; credentials; leases; idempotency keys with their applies for
3600 s; open plans with their answers and utterance records; the events `history` needs; each
schedule's last run; each rule's fired state, firing counter, retries and held notices; running
runs' identities; the ducks sent; the steward's undelivered notices; narrowings; the events
cursor. At start: migrations, load, reconnect the applier link and recover as after
`cursor_expired`, end every run that was running `ended(interrupted)` and release its leases (with
GA-LEASE-4's re-evaluation), start held durations afresh, record missed schedules, evaluate
level-triggered rules (GA-PERSIST-2, GA-RULE-1). Plans with no ask are memory only, so after a
restart such a plan is `unknown_plan` to `apply`, and `invalid_request` to `answer` (*Standards
problems*). From slice 11 the applier's last event the steward had, relayed or not, is kept beside
its own cursor (`meta` `applier_last`), so the start's recovery reads the applier's history from
it, and a step `dispatched` before a restart moves to the outcome the applier gave while the steward
was down. A gap's rule-firing outcomes are judged once the state is read. Kept by slice 11 too: each
held notice with the end of its wait, each firing in flight, and a scheduled start's second wait,
marked (`schedule_pending.marked`, migration `0012`).
A schedule waiting for its `single` scenario keeps its wait (`schedule_pending`) written behind: a
crash inside the grace before that write commits costs one date, recorded missed at the next start
instead of run, an accepted loss. So are the rows slice 11 adds, all written behind (Q6): a crash
before one lands loses that held notice or that firing's later outcome, or leaves the applier's
position earlier, which the start then reads again from the applier's history (events it relayed
already are not relayed twice, their `seq` known). The harness restarts the steward cleanly only;
the unit tests stop it with writes pending. A rule's notice marks (one failure notice per action each
time a level rule becomes true) are memory only: a held notice read back at a start whose action was
noticed already in that episode before the stop is raised a second time, an accepted duplicate,
since the mark would need the episode kept with every notice raised (the milestone 7+10+11
review, M3).

## TLS and the MCP binding

The steward's server is the applier's, copied: Streamable HTTP at `/mcp`, revision `2026-07-28`
and the 2025 revisions through the SDK's stateless fallback, no other (GA-BIND-2); plain HTTP only
on loopback, a certificate and key by path otherwise (GA-SEC-2); the bearer resolved on every
request. The tools are the standard's operations, `inputSchema: { type: "object" }` validated
inside against `@ludentes/galatea-life-schemas`, annotated as the standard says: `readOnlyHint` on `describe`,
`state`, `plan`, `outcome`, `events`, `history`, `scenario_status`, `scenario_plan` and
`zone_sources`; `destructiveHint: true` on `answer`, `apply`, `scenario_run`, `scenario_stop`,
`define` and `narrow`; `destructiveHint: false` on `front_status` and `speaking`.

## Error handling

- A request the schema refuses is `invalid_request`, the schema's first error its message; the
  operation's own checks come after, in the standard's orders.
- A step that throws before handing its writes over is a bug: logged, nothing handed over, the
  caller answered with an error, the steward keeps running; a test fails on any such line.
- The applier unreachable: see *The applier link*. The store unreachable or faulted: see *The
  core*. Both answers that leave something held (the store unavailable, an apply's outcome unknown)
  are -32603 with `data.pending`, from one base error, so neither is taken for the other.
- An event from the applier that does not parse is logged and skipped, never thrown out of the
  follower; the next batch still comes.

## Negative mutations

Each negative subject of the steward's table is one named switch, read at the point it breaks,
listed in `mutations.ts` and `subject.json`, honoured only while `GALATEA_TEST_RUN_ID` is set
(the subject contract). Each slice adds the mutations of its ids, so the build's `negatives` run
proves both the harness's tests and the build.

## How it is graded

The harness has no steward seam: `guard` and `startOnSeam` answer only `bridge` and `applier`, and
wave 0 tests no steward id. Each slice's plan writes the harness tests for its ids first, the
mutations that arm them, and what the stand-in applier needs for them.

- **The seam** (slice 1). `standard: "steward"`, `claims: ["Steward"]`. The harness starts the
  stand-in applier for the test, registers the steward as its client (credential, client id, token
  key), and starts the subject with the contract's variables plus `GALATEA_MCP_PORT`,
  `GALATEA_OWNER_CREDENTIAL`, `GALATEA_APPLIER_URL`, `GALATEA_APPLIER_CLIENT`,
  `GALATEA_APPLIER_CREDENTIAL` and `GALATEA_APPLIER_TOKEN_KEY`. The run-id guard reads the steward's
  `describe.test_run_id`. Setup then `define`s, as the bootstrap owner, `time_source` and a baseline
  house (`notice_channels` naming the stand-in's `notify` channel, an owner's app, a guest panel, a brain-served voice endpoint and its brain credential, a
  front, a few rooms), and opens one `McpSeam` per credential, so a test acts as the brain, the
  panel, the app or the front.
- **The neighbour.** Ruled (Q1): the stand-in applier, run **in the harness's own
  process** in a scripted mode, so a test sets device descriptions, values, liveness, tiers and
  events directly and reads every request the steward sent, with its tokens checked. It records the
  MCP revision each client used (`calls-its-applier-at-2025`). The standard's *Conformance* says "a
  reference applier", so the end-to-end check below covers that reading.
- **The stand-in's gaps**, today, against what the steward's tests need: it has no tiers (every
  action `reversible`), never checks a token (it records them) and so never answers `refuse(token)`,
  `refuse(tier)` or `refuse(toggle_only)`; it has no notices and ignores `notice_taken`; it takes its
  devices only from the MQTT simulated bridge, so a test cannot set a value, a liveness, a
  `fresh_s`, an `assumed` mark or a `personal` mark directly; it emits no `external`, `load_cap` or
  `safety_rule` causes, no `latch` or `rule_fired`; it has no computers, `accounts` or session keys,
  no occupancy or motion sensors, no `speech`, no `media.announce` or `media.duck`, no `notify`
  channel with `delivered`; it cannot be made to answer `cursor_expired` or to script an outcome
  (`failed` with a reason, `no_ack`, `late_ack`, `unanswered`); its `standard_version` is fixed at
  construction and it does not refuse an unknown `from` (`sends-from-to-an-old-applier`); and it
  does not record the revision a client negotiated. Each slice closes the gaps its tests meet.
- **Not on the harness.** GA-SEC-2's certificate check needs a non-loopback address for the
  stand-in, so `trusts-any-applier` is gradable only on a host with one (*Standards problems*).
  Slice 1's test serves the stand-in there over TLS, with a fresh self-signed certificate from the
  host's `openssl`, and passes when the stand-in saw TCP connections from the steward but no
  completed handshake and no MCP call; it skips the baseline house, which the steward could not
  define without its applier.
- **End to end, off the harness.** From slice 2b, a script in the steward's package runs the
  reference applier over the simulated bridge with the steward and an MCP client playing the brain
  and the owner tool: the first-light chain with no hardware, before the flat.

## The slices

Each slice is one plan, reviewed by the maintainer before code, and ends with the harness grading
its ids `pass` and its negatives failing exactly those ids. One exception: GA-SEC-2 and
`trusts-any-applier` need the stand-in served on a non-loopback address of the host, with a
certificate the steward is not told to trust; on a host with no such address (or no `openssl` to
make the certificate) GA-SEC-2's test fails with a note saying the host cannot try it, not the
subject (the harness has no `untested` row state; the applier's GA-SEC-1 test does the same), and
slice 1 ends with that row open. A loopback alias
treated as "not loopback" would need a ruling, since the standard exempts loopback. An id whose clauses land in several
slices is graded by each slice's tests with a `covers` note naming the clauses left; it passes
whole in the last.

| Slice | Delivers | Ids | Negatives |
|---|---|---|---|
| 1. Skeleton | package, subject file, clock and `time_source`, store, writer, migrations, event log, MCP server, the first owner, the applier link (pinned revision, mirror, follower), `describe`, `define` of home settings (with `notice_channels` naming the stand-in's `notify` channel, in the first change set), rooms, persons, endpoints, credentials and voice records; the harness's steward seam and scripted stand-in, with a `notify` channel | GA-BIND-2, GA-SEC-2 (where gradable, below), GA-AUTH-4, GA-HARN-2 (built; graded in 2a), GA-HOUSE-1 (but narrowings), GA-DEF-1, 2, 3 (its owner clause), 5, 8, GA-CONF-4 | `speaks-only-2025`, `calls-its-applier-at-2025`, `trusts-any-applier`, `app-without-person`, `serves-the-confirm-on` |
| 2a. Targets, principals, plans | the target overlay, groups, selectors, principals and roles, tiers, the reason order without leases, occupancy or sessions, `plan`, `ask` events | GA-AUTH-1, 2, GA-TIER-1, 2 (its plan clause), 3, GA-PLAN-5, 6, GA-GRP-1, GA-STW-1, 2 (but `session.lock` and a rule's locks), 4 (its applier, conflict, role, tier and toggle clauses), GA-CONF-5, GA-DEF-9, 10 (rooms and groups; rules' and scenarios' actions later), GA-HARN-2 | `trusts-asserted-via`, `takes-any-speaker`, `unlocks-by-voice`, `visitor-acts`, `skips-the-ask-event`, `selects-internal`, `rooms-an-internal-device`, `defines-unadopted`, `refuses-the-toggle` |
| **2b. Answers, tokens, apply** (first light) | `answer` and the utterance record (but its voice-record clauses), asked plans and answers read back at start, the stand-in verifying tokens, `confirm_on`, tokens, `apply` by plan and inline, idempotency, the applier apply, outcomes and their times, `outcome`, `events` relayed with causes | GA-CONF-1, 2 (but `asked_by`), 3 (but authored tokens), 6 (but its voice-record clauses), GA-APPLY-3, GA-TIER-2 (inline), GA-STW-3, 4 (a toggle's `yes` and its inline refusal), 5, 6, 9, 10 (the apply's key; rules', runs' and the restart clause later), 12 (but `scenario_status`) | `takes-any-answer`, `reuses-an-utterance`, `answers-unasked-steps`, `follow-up-yes`, `tokens-without-a-yes`, `folds-the-toggle-into-the-tier`, `outcome-without-a-time` |
| 3. Rules | the rule language, triggers, conditions, windows, `not_in`, exceptions, level and edge, firing, authored tokens, `define`'s notices for unknown bounds; **pulled forward:** the lease table with persons', `external` and `load_cap` leases, precedence, `refuse(leased)`, a lease's end re-evaluating rules; rooms' occupancy for a rule's `respect_occupancy`; the notice path (the steward's notices and the applier's, `from`); the stand-in's computers with session keys and `session.lock { account }` | GA-RULE-1 (but after a restart or `cursor_expired`), 2 to 6, GA-LEASE-1, 2 (but the `cursor_expired` gap), 3 (but the duck), 4, 5, GA-STW-4 (`leased`, rooms' occupancy), 8 (leases, rooms' occupancy), GA-OCC-1, GA-NOTE-1, GA-NOTE-2 (requests', notices' and rules'), GA-SCN-4 (a rule's own action), GA-AUTH-5 (rules), GA-DEF-9, 10 (rule actions), GA-STW-2 (a rule's two locks), GA-STW-10 (rules' keys), GA-CONF-3 (authored tokens) | `rule-on-stale-reading`, `rule-on-an-assumed-value`, `authors-a-toggle`, `rules-a-wake-relay`, `window-on-the-end-day`, `not-in-skips-unknown`, `fires-on-a-retired-token`, `conditions-fire-once`, `fires-in-an-exception`, `ignores-leases`, `vacant-on-a-slow-sensor`, `trusts-the-callers-from`, `sends-from-to-an-old-applier` |
| 4. What a rule's outcome does | retries, failure notices with their late-ack waits, toggle notices | GA-RULE-7, 8 (but schedules' toggles, `skipped(in_use)`, and a held notice across a restart) | `locks-once-and-gives-up`, `retries-hours-later`, `leaves-it-unanswered`, `retries-a-shutdown`, `fails-the-limit-silently`, `notices-a-slow-lock`, `holds-an-ssh-only-lock`, `times-the-lock`, `drops-a-held-notice`, `re-declares-a-toggle-silently`, `notices-a-slow-late-ack`, `notices-every-skipped-toggle`, `defines-a-toggle-rule-silently`, `notices-a-late-launch`, `notices-every-lease` |
| 5. Scenarios | **pulled forward**, since a schedule runs a scenario and a rule may start one: scenario `define`, plans, runs in mode `single` only, `if`, `delay`, `wait`, `run`, run leases, person-started and rule-started runs, re-asked toggles, the run-wide bound, `scenario_status`, `scenario_stop` | GA-SCN-1 (`single`), 2, 3, 4 (rule-started runs), 5 to 10, 11 (person- and rule-started runs), GA-DEF-4, GA-DEF-9, 10 (scenarios' actions), GA-AUTH-5 (runs), GA-STW-10 (runs' keys), GA-STW-12 (`scenario_status`), GA-NOTE-2 (runs) | `toggles-on-an-old-yes`, `drops-the-starting-endpoint`, `branches-on-an-assumed-value`, `stales-an-assumed-if` |
| 6. Schedules | the decision core, timers, exceptions, missed runs, scheduled runs | GA-SCHED-1, 2 (its restart, through the harness's restart), 3, GA-SCN-4 (schedules), 11 (scheduled runs), GA-AUTH-5 (schedules), GA-NOTE-2 (schedules), GA-RULE-8 (schedules' toggles) | `passes-a-skipped-toggle`, `schedules-a-toggle-silently` |
| 7. History and safety leases | `history` from the store, retention, cursors; safety-rule leases; recovery from the applier's history after `cursor_expired`; edges missed in a gap replayed within 5 minutes | GA-STW-7 (but `narrowed`, slice 9), GA-LEASE-2 (the `cursor_expired` gap), GA-LEASE-3 (a safety rule's lease), GA-LEASE-6, GA-RULE-1 (after `cursor_expired`), GA-STW-8 (leased at dispatch), GA-CONF-2 (the record kept in history) | none of its own (`ignores-leases`, slice 3, also fails these) |
| 8. Computers, sessions, personal keys | sessions and `account_persons`, `session.lock` by person, `in_use` asks, the read principal, the personal floor | GA-OCC-3, GA-STW-2 (`session.lock` by person), 4 (sessions), 8 (sessions), 11, GA-DEF-11, GA-NOTE-3, GA-AUTH-6, 7, GA-SCN-4 and 11 (their `in_use` clauses, for rules, runs and schedules), GA-OCC-1 (a computer with no room), GA-RULE-8 (`skipped(in_use)` raises none) | `lets-the-rule-ask`, `lets-the-schedule-ask`, `fails-a-pc-in-use`, `vacant-without-a-room`, `sleeps-an-unknown-session`, `sleeps-the-film`, `asks-the-room-after-the-session`, `yes-overrides-the-room`, `sleeps-a-sessionless-pc`, `asks-the-tier-over-the-session`, `asks-the-tier-after-the-session`, `locks-every-session`, `conflicts-two-accounts`, `maps-an-unknown-person`, `forgets-a-retired-account`, `reads-through-any-endpoint`, `shows-a-guest-the-session`, `shows-a-visitor-the-session`, `times-the-camera`, `shows-the-if-reading` |
| 9. Listening | narrowings and lifts, `front_status`, effective records and their notices, `zone_sources`, announcement checks, the front credential; no ducking | GA-LISTEN-1 to 4, GA-HOUSE-1 (narrowings), GA-AUTH-8, GA-DEF-3 (lifts), GA-CONF-2 (`asked_by`; until then the build does not refuse a voice endpoint's record without it, which changes the error code there, since `invalid_request` comes first in `answer`'s order, so the harness and first light answer at a voice endpoint only with a valid `asked_by`), 6 (voice records) | `widens-by-narrowing`, `lifts-for-anyone`, `hides-the-fallback`, `deaf-to-sources`, `announces-the-wake-word`, `front-plans` |
| 10. Work through a brain | the `define` policy through a brain, `ask(confirm_define)`, `brain_authored` marks and their effects | GA-DEF-3 (through a brain), 6, 7, GA-NOTE-2 (`brain_authored`) | `authors-a-moved-device` |
| 11. Restarts | the harness's restart of the subject against every durable item | GA-PERSIST-2, and the restart clauses of GA-STW-10, GA-RULE-1 and GA-RULE-8 (GA-SCHED-2's restart is slice 6's) | `forgets-a-held-notice` |
| Deferred (ruled 2026-10-02) | ducking; scenario modes `restart`, `queued` and `parallel` | GA-LISTEN-5, GA-LEASE-3 (the duck), GA-AUTH-5 (the duck), GA-SCN-1 (the other three modes): `untested` until a later slice adds them | `unducks-anything` |

**First light comes with slice 2b.** The chain then exists on the steward's side: an adopted
`notify` channel in `notice_channels` (the first `define` needs one, *Standards problems*), an owner's app and
a brain's endpoint defined, a lamp's `onoff.turn_on` raised to `confirm` by the applier's
`configure`, the brain's plan asking, the `ask` put on the owner's app through `confirm_on`, the
brain's own `answer` refused `not_permitted` (GA-CONF-1), the owner's `yes` in the owner tool, a
token minted, the applier dispatching, and the outcome relayed. First light in the flat also waits
on the Zigbee bridge's herdsman doer, the owner tool and the agent-brain (roadmap, *The core*); the
end-to-end script of slice 2b proves the chain on the simulated bridge first.

**The order** is the maintainer's (Q3, ruled 2026-10-02): rules and schedules come first after
first light, since they carry the house's routines (HS3's night light, HS20's limit). Only what
they need was pulled forward, and the rest kept its place:
- **Into slice 3 (rules):** the lease core (a person's and an outside change's leases, precedence,
  `refuse(leased)`, a lease's end re-evaluating rules), because GA-LEASE-1 and GA-LEASE-4 are what
  a rule meets; rooms' occupancy (GA-OCC-1), because a rule's action may `respect_occupancy`; and
  the notice path (GA-NOTE-1 and the request, notice and rule clauses of GA-NOTE-2), because
  GA-RULE-2's and GA-RULE-8's notices ride on it. The stand-in gains computers with session keys,
  since HS20's limit is a rule on one.
- **Slice 5 (scenarios) before schedules**, since a schedule runs a scenario and a rule may start
  one.
- **Left later:** `history` (slice 7, with the safety-rule leases and the `cursor_expired`
  recovery, the stand-in's `cursor_expired` and GA-RULE-1's clause after it, which need the applier's history); sessions, `account_persons`, `in_use` and the
  personal floor (slice 8), which no rule needs, as a rule reads a session key directly; listening;
  work through a brain; restarts.
- **Deferred** (Q9, ruled): ducking and three of the four modes. Their clauses stay `untested`
  (ducking is a MAY and the modes listed are the steward's choice, so a later slice may instead
  grade them as not built), and no conformance is claimed while they are.

**The order changed on 2026-10-05** (the maintainer): slices 7, 10 and 11 come next, as one
milestone with one preflight review after slice 11; PC control (slice 8) and listening (slice 9)
follow, as their own milestone. The table keeps its numbering. Until 8 and 9 return, these stay
partial or ungraded, with those slices' negatives, and the steward claims no full conformance: the
`in_use` clauses of GA-RULE-8, GA-SCN-4 and GA-SCN-11; sessions in GA-STW-2, GA-STW-4 and GA-STW-8;
the voice-record clauses of GA-CONF-2 and GA-CONF-6; GA-HOUSE-1's narrowings; GA-OCC-3, GA-STW-11,
GA-DEF-11, GA-NOTE-3, GA-AUTH-6 to 8 and GA-LISTEN-1 to 4. Slice 11 tests the durable items that
exist by then; slices 8 and 9 each add restart cases for their own.

**Slice 3 is built in two parts** (ruled by its plan's author, 2026-10-04): 3a, the lease table
without its refusals, rooms' occupancy, the notice path and `from`, then 3b, rules,
`refuse(leased)`, a lease's end re-evaluating them, rules' `from` and the stand-in's computers. Each
is its own plan and pull request; the milestone's one preflight review comes after slice 4.

## Why the main choices

The standing rule is to keep a decision proven in deployed systems, and to depart from it only on a
ruling of the maintainer's, a protocol fact, or a new need a scenario names. Area by area, the
choices this steward makes and the reason for each:

- **House model.** Devices are the applier's, not the steward's: ruling, *Brain, steward, one
  applier* (2026-09-24). One revision with a long-poll `describe`: the front learns of a narrowing
  at once (voice, GA-VOICE-3's narrowing delay) and a plan knows it is stale (GA-STW-5). Rules
  apart from groups: HS20's limit reads a laptop's session that belongs to no group.
- **Persons, roles, endpoints.** Four roles, the role the lower of the person's and the endpoint's
  `max_role`, a speaker only from a brain's hint at a shared endpoint: rulings *Owners have a
  direct way in* and *Trust the brain, with guardrails* (2026-09-24). Every client a registered
  credential bound to its endpoints: a brain that claims a panel's endpoint must not reach
  `no_voice` (`trusts-asserted-via`; HS16). One steward holds one home.
- **Tiers and confirmation.** The steward asks, records the answer with its utterance, and only a
  person's `yes` earns a token: a client-side confirmation cannot hold when the client is a model
  (rulings *Brain, steward, one applier* and *Trust the brain, with guardrails*; HS16, the brain
  answers its own question).
- **Tokens.** HMAC tokens bound to target, action, args, `via`, `brain` and `for`, 60 s, one use:
  the applier's gate checks "the token that proves a person said yes" (2026-09-24).
- **Leases.** A person's two-hour hold after their own action and after an outside change: HS3
  (the father's hall light). Load-cap leases: HS14. Kept across a restart: HS3's hold must outlive
  a night's reboot (GA-PERSIST-2). Leases are enforced; a mark nothing reads is no lease.
- **Occupancy.** Rooms `occupied`, `vacant` or `unknown`, failing closed: HS2 («Мы ушли» with
  someone home), HS21 (the computers).
- **Listening.** Narrowings from anyone: a guest's «Не слушай до утра» (steward 0.6). Announcement
  checks: a speaker saying «Галатея, да» during an owner's question (GA-LISTEN-4).
- **Plans and apply.** `plan` is an operation that changes nothing and asks: the brain must see
  refusals and asks before acting (HS15). Idempotency keys, no de-duplication by value: HS5's
  command heard twice is merged by the front and the brain (GA-BRAIN-5), and a retry carries its
  key. The apply's record is committed before the applier call, and a dead device is `skip(dead)`
  at once.
- **Causes and history.** `history` is readable by every bound client under the personal floor:
  the brain's explanations cite it (brain, GA-BRAIN-9, 10). It keeps 90 days, where the standard
  sets only a floor of 7 (*Decisions*).
- **Personal keys.** A per-key floor from the applier's marks: HS21 and HS23 (sessions are what a
  person is doing); the PC design, steward 0.5.
- **Notices.** The steward delivers every notice on the home's `notify` channels: HS4's leak with
  nobody home must reach the owner (GA-NOTE-1). Raising, de-duplication and flapping are the
  applier's: safety rules stay in the applier nearest the device (2026-09-24).
- **Scenarios.** Authored runs go by themselves: HS1, HS2 and HS6 start from a phrase or a schedule
  with no operator. A run a restart interrupts ends `ended(interrupted)` (GA-PERSIST-2), so a crash
  never leaves a run `running` to block the next.
- **Rules.** Windows, `not_in`, exceptions, retries and notices: HS20 (the child's limit). Level
  and held: HS3. No condition on an assumed value: steward 0.5's changelog (2026-09-27). Fired
  state kept: HS20's limit across a restart (GA-RULE-1).
- **Schedules.** A schedule per scenario, `HH:MM` and days. Daylight-saving gaps and repeats: an
  IANA zone's wall time may not exist or may occur twice (GA-SCHED-3). Exceptions that move a run:
  HS1 («Доброе утро», except when it isn't). Wall time through `Intl`, never the server's clock;
  the mark before the run.
- **`define`.** Asked through a brain: HS13 (a calendar entry that gives orders) and GA-DEF-6.
- **The client seam.** MCP at revision `2026-07-28` for every client and to the applier: ruling,
  MCP pinned for every seam but the bridges' (2026-09-28).
- **Storage.** Postgres, one schema and role, `pg`: ruling, one Postgres (2026-09-28).

Eleven choices had none of the three reasons; the maintainer settled them on 2026-10-02. One changes
this build: every run is bounded.

- **Ratified:** rooms do not nest; a group gives "upstairs", revisited if a scenario needs a floor
  as a target.
- **Ratified:** no global lock on runs; per-device leases already stop two runs fighting over a
  target.
- **Ratified:** hearing (arbitrating satellites, merging a command heard twice, zones, echoes) is
  the voice front's, as the voice architecture places it and voice 0.3 passed review with it.
  `speaking_for_ms` is a duration the front places on its own clock.
- **Ratified:** `define`'s change sets are atomic, with dry runs and revision checks, since a
  `define` through a brain is asked (GA-DEF-6, HS13) and must not land on a house that moved.
- **Ratified:** a timer per schedule, since every build takes its timers from one Clock and one
  queue.
- **Restored:** every run is bounded by the run limit (*Scenarios*), past which it ends
  `ended(timeout)`. A finish block, run however a run ends, goes to the revision and is not built.
- **To the revision:** `visitor` is built, as steward 0.9 has it; the revision names a scenario for
  it or drops it.
- **To the revision:** an owner-only mark on an action, proposed with a scenario (a child at home
  alone). Not built.
- **To the revision:** quiet hours for notices not about safety, as a MAY with a safety floor. Not
  built.
- **To the bridge revision:** a gap between actions protects a radio, so it belongs in the doer
  nearest the mesh, not the steward. Not built here.
- **To the revision:** a short grace for schedules after a restart only; until then the build
  follows GA-SCHED-2.

**Lessons this design follows:** bound every queue (the writer's backlog has a cap, as the
reference applier's, and so does the event log in memory and the follower's batch); write the
record before the publish; mark a schedule fired before running it; fail fast on a dead device; an
authorisation check is a predicate that never throws; drop nothing silently that a person will
look for later.

## Standards problems found

Read against applier 0.14 and brain 0.6. Each is listed, not fixed; the build follows the text
until a revision changes it.

- **A plan's revision is the whole house's, and asks live 300 s** (looks wrong). GA-STW-5, GA-CONF-1
  and `answer`'s error order make a plan made at an older revision `stale_revision`, and the
  revision moves on every narrowing granted, lifted or expiring anywhere in the home (GA-LISTEN-1)
  and on every applier `model` event (a bridge re-declaring, a device joining). An ask waits up to
  `ask_expiry_s`; a person's `yes` given on a phone four minutes later is lost because a satellite
  in another room was told «не слушай» meanwhile. The text may mean a revision of what the plan
  depends on; it says the house's.
- **`notice_channels` makes the first `define` impossible as read literally** (contradiction).
  GA-DEF-8 and GA-NOTE-1 have `define` refuse a change set that leaves `notice_channels` without
  a `notify` channel, and a fresh steward has none, so every change set that does not itself name
  one is refused, `time_source` (GA-HARN-2) and a room included. The text likely means "a change
  set that removes the last channel". This build follows the letter: the first `define`, the
  bootstrap house's, must name an adopted `notify` target in `notice_channels`, so an installation
  adopts a channel at the applier before it defines anything, and the harness's stand-in has a
  `notify` channel from slice 1. The first owner (ruled, Q2) exists without a `define`, so the letter
  does not lock the owner out. Found by the spec review.
- **A run's re-asked toggle sits badly with `answer`'s checks** (tension). GA-SCN-3 re-asks a
  toggle step "as a new `ask` event on the run's plan, which stays open for that answer for
  `ask_expiry_s`", which reads as an exception to the plan's own expiry. Two things stay unsaid: the
  run's plan was taken by `scenario_run`, and GA-CONF-1 accepts answers only for an open plan, "not
  yet applied"; and it was made at a revision that has likely moved, so `answer` returns
  `stale_revision` before it looks. This build takes the re-ask as reopening the plan for that step
  alone, exempt from the revision check, timed from the new `ask` event, and lists it for the next
  revision.
- **A notice's delivery has no principal** (gap). GA-NOTE-1 dispatches `notify` to the applier,
  whose request needs `via`, `brain` and `for` on every action, but the steward's causes include no
  notice, and the applier's `via` values are an endpoint's type, `rule` or `schedule`. This build
  sends `via: rule`, `brain: false`, `for: { notice }`.
- **`describe` has no `persons` field** (gap). The Operations table lists none, though it says
  "Persons appear by id, name and role only", and GA-AUTH-8 shows a front "the ids of the registered
  persons". The schema has none either. This build returns `persons: [{ id, name, role }]`.
- **The steward's schemas disagree with the text** (derived artifacts, so the text wins): `answer`'s
  `utterance` is a string in `answer.request.json`, a record in the standard; a plan step's
  `holder` is a string in `plan.json`, a principal in the standard; `describe.response.json` lacks
  `persons`. Slice 1's plan corrects the schemas.
- **GA-SEC-2 is graded only off loopback** (untestable as the harness runs). Both ends on one
  host's loopback are exempt, and the harness runs everything on loopback, so `trusts-any-applier`
  can fail only where the stand-in can be served on another interface with a certificate the
  steward does not trust. The harness can do that on a host with a non-loopback address; on one
  without, the row is untestable.
- **GA-HARN-2 against the subject contract** (wording). The standard has the harness give
  `time_source` through `define`; the contract gives every subject `GALATEA_TIME_SOURCE` at start,
  and the steward must run on some clock before its first `define`. This build does both, as the
  reference applier does with `configure`; the text should say the variable is the first source.
- **`history`'s list in prose omits `occurrence`** (minor). *Causes and history* lists the applier's
  events `history` returns without `occurrence`; GA-STW-7's row includes it. The row wins.
- **A person-started run's steps outside `owned` take no lease** (ambiguous). GA-LEASE-1 leases "an
  endpoint principal's apply"; a run's principal is `{ run }`, and GA-SCN-2 leases only `owned`
  targets, so a rule may undo a person's run step on a device the scenario does not own at once.
  Perhaps intended (the author chose `owned`); the text should say so.
- **`front_status` for several endpoints, one not the front's** (ambiguous). GA-AUTH-8 makes
  `front_status` for an endpoint not bound to the front `not_permitted`, but one report covers many
  endpoints. This build refuses the whole report.
- **`zone_sources` hands `speech`, a personal key, to the front** (consistent, worth a sentence).
  The floor (GA-AUTH-7) names the reads it covers, and `zone_sources` is not one, so the front gets
  what every television says by design; the text should say it is outside the floor on purpose.
- **A run-wide bound has no status of its own.** The run limit this build restores ends
  a run `ended(timeout)`, which steward 0.9 defines for a `wait` that timed out with `stop`
  (GA-SCN-10); `scenario_status` cannot tell the two apart. The revision that takes the finish
  block should give a run's bound its own status or say the reuse is meant.
- **No error for a plan the steward no longer holds.** The applier has `unknown_plan`; the steward's
  error list ("the applier's, plus `unknown_run`") inherits it, but `answer`'s order names
  `invalid_request` for an unknown `plan_id`. This build answers `invalid_request` for `answer` and
  `unknown_plan` for `apply`, `scenario_run` and `define { plan_id }`.
- **No error says a write is held** (gap; found by slice 1's plan). The steward's errors have no
  answer for a change the store did not keep: while the store is down (ruled, Q6) and when a commit
  outlasts the gate. This build answers MCP's internal error, -32603, with `data: { pending }`,
  false when nothing was held and true when the change is held, to be judged and applied at its
  turn. A client cannot know from the text whether to retry.
- **`define`'s checks read an applier the steward may not have reached** (gap; found by slice 1's
  plan). GA-DEF-8's `notice_channels` needs the applier's devices (adopted, with `notify`), and
  GA-HARN-2's `time_source` its `test_run_id`; the text does not say what `define` does before the
  steward has read its applier. With the letter of `notice_channels`, a fresh steward cannot take
  its first `define` until its applier is in reach. This build refuses with `invalid_request`
  naming the check.
- **A `define` has no cause form** (gap; found by slice 1's plan). *Causes and history* asks for a
  `define` event "with its cause", and every cause it lists names an apply, a run, a rule, a front
  or the applier's own. This build records `endpoint` and `person` beside the revision and the diff.

- **GA-TIER-3's "every step" and GA-STW-4's order disagree** (contradiction; found by slice 2a's
  plan). GA-TIER-3 makes a visitor's every step `refuse(role)`, but GA-STW-4's fixed order puts the
  applier's reasons and `conflict` first, so a visitor's step on a dead device is `skip(dead)` and on
  an unknown one `skip(unknown_target)`. This build follows the order (agreed on the preflight); a
  visitor still acts on nothing. Proposed wording: "a visitor's every step that reaches `role` in the
  order is `refuse(role)`".
- **A request's target names a device or a group with nothing to tell them apart** (gap; found by
  slice 2a's plan). Rooms, names and groups are the steward's, the device ids the applier's, in one
  id grammar, and the text does not say which wins when a group's id is a device's. This build
  refuses such a group at `define`; for a device the applier brings later, the maintainer ruled
  (2026-10-04) that the device wins, the group cannot be targeted until the owner renames it, and
  the owner is told (a notice once notices exist, slice 3; until then logged once and flagged
  `shadowed` in `describe`). Proposed sentence: "a group's id is kept apart from the applier's
  device ids; on a collision the device wins and the steward gives the owner a notice".
- **What `plan` gives while the applier is out of reach** (gap; found by slice 2a's plan). The text
  says nothing of a steward that cannot reach its one applier. This build judges each step by what
  the applier's last description establishes before `dead` (`unknown_target`, `unsupported_action`,
  `not_adopted`), then `conflict`, then `skip(dead)`, its tier as last described. Proposed wording:
  "while the steward cannot reach its applier, a step is `skip(dead)` unless a reason before `dead`
  holds by the applier's last description".

- **The applier's `outcome` cannot recover a lost apply** (gap; found by slice 2b's plan). The
  applier's `outcome` takes the applier's `apply_id`, which only the apply's answer carries, so a
  steward whose answer was lost cannot ask what became of the apply; repeating it with its key
  (applier GA-APPLY-4) is the only way, and only while the steward still repeats. This build keeps
  such an apply's steps `unknown` (ruled by the maintainer, 2026-10-04). Proposed for applier 0.16:
  the applier's `outcome` also takes `{ idempotency_key }`, for the client that sent it, for the key's
  3600 s, and an `unknown_apply` by key means nothing was sent, so the steward can then mark the
  steps `unreachable`.
- **`tokens-without-a-yes`'s row misses GA-STW-4** (incomplete row; found by slice 2b's matrix). With
  a token on every step above `reversible`, an inline toggle is sent and runs, breaking GA-STW-4's
  `refused(toggle_only)`. Proposed: add GA-STW-4 to the row's coupled ids. Listed in
  `reference/steward/known-outside.json` until then.
- **`answer` returns "the plan, updated", and the text does not say where its answers show** (gap;
  found by slice 2b's plan). The *Steps* table has no field for a step's answer. This build gives
  each asked step the `answer` that stands for it, and [`conformance/schemas/text-map.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/schemas/text-map.json) notes the
  field as provisional.
- **A plan applied twice** (gap; found by slice 2b's plan). GA-CONF-1 makes an applied plan take no
  answer, and the text is silent on a second apply of it under another key. This build spends a plan
  on its first apply: a second is `plan_expired` (ruled by the maintainer, 2026-10-04). Proposed
  sentence for the next steward revision: "a plan once applied is spent; another apply of it is `plan_expired`".
- **Refusing a key past a cap has no code** (gap; found by slice 2b's preflight, M3). The build caps
  the applies a credential holds under keys within their 3600 s and refuses a new key past it
  `invalid_request`, since forgetting one early would break GA-STW-6; the standard names no code for
  "too many", as the applier's keys have none.
- **An answer to `ask(confirm_tier)` cannot answer the room** (gap; found by slice 3a's plan). With
  `respect_occupancy`, a confirm step whose room is not known is asked `confirm_tier`, the earlier
  reason, and GA-STW-8 keeps the answers given, so at dispatch the unknown room is an ask no answer
  met and the step ends `skipped(not_confirmed)` (GA-APPLY-3): such a step can never run. GA-STW-4
  lets a `yes` to `ask(in_use)` answer the room's question too; nothing does so for `confirm_tier`.
  Proposed for the next steward revision: "a `yes` to `ask(confirm_tier)` on a step with `respect_occupancy` also
  answers its room's `occupancy_unknown`", or a plan that asks both.
- **A notice channel raised above `reversible` can never deliver** (gap; found by slice 3a's plan).
  A notice's `notify` is sent with no token, since no person said yes, so a channel whose `notify`
  the owner raised to `confirm` refuses every notice, and GA-NOTE-1 retries it for ever. Proposed:
  `define` refuses a notice channel whose `notify` is above `reversible`, or a notice's `notify` is
  exempt from the tier as a safety rule's actuation is.
- **What "live throughout the hold" is read from** (gap; found by slice 3a's plan). GA-OCC-1 needs
  each sensor's liveness over the last hold, which the steward sees only since it started, or reads
  from the applier's `history`. This build fails closed: every room is `unknown` for one hold after
  a start. Proposed sentence: "a steward that cannot show a sensor was live throughout the hold
  treats its room as `unknown`".
- **A lease between dispatch and the answer, and after a lost answer** (gap; found by slice 3a's
  plan). GA-LEASE-1 leases "from dispatch", and says nothing of the moment before the applier
  answers, nor of an answer that never comes. This build lays a provisional lease at dispatch, which
  the answer settles, and keeps it as a lease when the answer was lost.
- **When a `sent` counts as a notice delivered** (gap; found by slice 3a's plan). GA-NOTE-1 counts
  `sent` "on a channel that never reports receipt", which no field names; this build reads it as a
  channel whose `notify` is declared `confirms: false`, or an open-loop device.
- **A notice's urgency** (gap; found by slice 3a's plan). `notify` requires `urgency`, and a notice
  has none; this build sends `critical` for a safety rule's cause and `warning` otherwise.

- **The reason order for authored work** (gap; found by slice 3b's plan). The order puts the tier
  before `leased`, and the text says authored work carries its own token, without saying where in
  the order that answer stands. Judged in the order, a rule's `confirm` step stops at the tier and
  escapes a person's lease, against GA-LEASE-4. This build skips the tier entry for authored steps
  (but a brain's or voice's refusal), and judges them from `leased` on. Proposed sentence for the
  next steward revision: "for authored work, the tier entry is answered by its author, and the order continues".
- **GA-STW-8's `leased` at dispatch is met only under a safety rule's lease** (gap; found by slice
  3b's plan). A person's apply holds `person` precedence, which only a `safety_rule` lease outranks,
  so the clause waits for slice 7. GA-STW-4's `leased` place is graded on a rule's steps, which alone
  meet a person's lease.
- **An owner's `fresh_s` longer than the declared one cannot be seen** (gap; found by slice 3b's
  plan). GA-RULE-2 bounds a reading by the device's `fresh_s`, the owner's where it is longer, and
  `describe` gives only the effective bound, so no client can tell the two apart and the clause has
  no case over the wire.
- **Exceptions accumulate** (gap; found by slice 3b's plan). Nothing in the text drops an exception
  that has ended. This build caps them at 64 per rule; the owner deletes them. Proposed: an ended
  exception is dropped at the next `define`, or the cap is named.
- **An edge while the steward is down** (gap; found by slice 3b's plan). GA-RULE-1 speaks of level
  rules after a restart; a change the steward first sees at its start's state read is no edge, so an
  edge rule's trigger in the gap is lost. This build says so; the text should too.
- **`ignores-leases`'s row misses GA-STW-4** (found by slice 3b's matrix). GA-STW-4's `leased` place
  needs leases. Proposed: add GA-STW-4 to the row's coupled ids. Listed in
  `reference/steward/known-outside.json` until then.
- **What a lease's end re-evaluates** (looks wrong; found by the milestone review of slices 3 and
  4, B6). GA-LEASE-4 re-evaluates every level rule naming the device at any lease's end. That
  re-fires a rule a person's step never stood in the way of. It also re-fires after a provisional
  lease that only stood between dispatch and the answer. This build does not count a lifted
  provisional lease as an end, unless it refused a change (milestone ruling Q7, provisional). Acting again
  only on the next real change after a person's override is the proven alternative. Proposed for the next steward revision: re-evaluate only the
  rules the lease refused since they last became true.
- **A held rule after a restart or a liveness blip** (gap; the milestone review, M1). A held
  duration starts afresh when its device stops being live and at a restart (*Standards fixes*). The
  text does not say whether the rule's `fired` survives that fresh start. Cleared, the rule fires
  again each time; kept, it is only delayed. This build keeps `fired` (milestone ruling Q2, provisional).
  Proposed for the next steward revision: say that a held duration's fresh start does not reset `fired`.
- **An edge on a return to life or a restart** (gap; found comparing with deployed practice). A device that comes
  back to life, or a steward that restarts, reads values again; the text does not say whether a
  value read so is a change. This build counts an edge only on a change of the value seen while the
  device is live. Proposed: say so in GA-RULE-1.
- **Authored work on a device later marked `internal`** (gap; the milestone review, M10). GA-DEF-10
  refuses a rule naming an `internal` device at `define`; a device marked `internal` afterwards is
  still named. This build refuses the step at firing too, `role` (milestone ruling Q9). Proposed: say so in
  GA-DEF-10.
- **A step the steward could not plan on the applier** (gap; the milestone review, B4). The applier's
  `plan` call can fail while its `apply` would succeed; the steward then has no plan step to judge
  for leases and rooms. This build fails closed (ruled): such a step is never sent and ends
  `unreachable`; a rule's step is retried under GA-RULE-7. Proposed: name the case in *Apply*.

- **A lock's dispatch is not visible to the steward** (gap; found by slice 4's plan). GA-RULE-8 holds
  a `failed(not_locked)`'s notice for the lock's `ack_within_s` "from its dispatch", which the
  applier does and the steward does not see: no event or answer carries the dispatch time. This
  build counts from the applier's answer to the apply, which comes after the dispatch, so the wait
  is never shorter. Proposed: count from the steward's sending of the apply, or have the applier's
  answer carry each step's dispatch time.
- **The late-ack slack's meta-applier hops are not visible** (gap; found by slice 4's plan). The
  slack is 11 s plus 6 s per meta-applier hop, and nothing in `describe` says how many hops stand
  between the steward and a device. This build uses 11 s; its applier is never a meta-applier.
  Proposed: a hop count, or the slack itself, per device in the applier's `describe`.
- **An action retried for ever is never told** (tension; found by slice 4's plan). GA-RULE-7 fires
  an idempotent action again for as long as the conditions hold, and GA-RULE-8 raises no notice for
  an outcome GA-RULE-7 retries. A child's limit whose lock ends `failed(no_ack)` all evening, or a
  valve rule on a dead device, fails with its only trace in `history`, which GA-RULE-8 says it
  should not. The maintainer ruled (2026-10-05) one notice once the action has failed for 10 minutes, the
  retries going on; built, and proposed for the next steward revision (*Standards fixes*).
- **`skipped(occupancy_unknown)` raises a failure notice** (tension; found by slice 4's plan). The
  text's "neither a success nor one it fires again for" takes in every skip it does not name, so a
  rule that respects occupancy in a room whose sensors are stale notifies the owner at each
  becoming true, while `skipped(occupied)` is no failure. The maintainer ruled the notice stays; this build
  gives it once per rule and room, not at each becoming true (milestone ruling Q4, provisional), so a room
  that is unknown for good does not notice every evening. Proposed for the next steward revision: name the skips that
  raise a notice, and this one's once-per-room.
- **A declaration changed while the steward is down** (gap; found by slice 4's plan). The toggle
  notice comes "when a device's declaration changes", which a restarted steward cannot tell from a
  declaration it never saw; this build takes what its first `describe` finds as told, so that change
  gives no notice. Proposed: keep the told set in the store (slice 11), or say that a restart does
  not re-notice.
- **Retries and notices for held and edge rules** (gap; found comparing with deployed practice). GA-RULE-7 and
  GA-RULE-8 give retries and failure notices to rules of conditions only, so a held rule's failed
  action and an edge rule's failed firing leave no trace but `history`. This build (ratified by the
  maintainer, 2026-10-05) retries and notices a held rule's action as a
  rule of conditions only's while its reading holds, and gives an edge rule's failure one coalesced
  notice, never a retry. Proposed for the next steward revision as a departure.
- **Two negative rows need actions the conformance vocabulary lacks** (testability; found by slice
  4's plan). `retries-a-shutdown` and `notices-a-late-launch` name `power.shutdown` and
  `media.launch`; the stand-in has neither, and the cases use a pulse relay's `onoff.turn_on`, which
  is not idempotent, the property both rows test. Proposed: let the rows say "an action that is not
  idempotent".

- **No form for a rule starting a scenario** (gap; found by slice 5's plan). The text has rules
  start runs (GA-SCN-4, GA-AUTH-5) but gives a rule's actions only a request's shape. This build takes
  `{ scenario: <id> }` among a rule's actions, refused when it names no scenario. Proposed: the
  action form, and what a start a `single` scenario ignores counts as (this build: landed).
- **What a `run` step is** (gap; found by slice 5's plan). Not said whether it starts a run of its
  own, with its own leases and status. This build expands it in place: one run, one plan, `owned`
  the union. Proposed sentence: "a `run` step's steps run as the run's own".
- **"One step per action step" against a selector or a group** (gap; found by slice 5's plan).
  GA-SCN-6 counts plan steps by action steps, while one action step can reach several devices, each
  judged apart. This build gives them `s<n>.<k>`.
- **An `if`'s own outcome has no step id** (gap; found by slice 5's plan). GA-SCN-8 lists an `if`'s
  `skipped(dead|stale|assumed)` in `failed_steps`, whose entries carry a `step_id` the plan never
  gave the `if`. This build uses `if<n>`.
- **Who may read `scenario_status`, and who may stop a run no person started** (gap; found by
  slice 5's plan). Not said. Ruled by the maintainer (2026-10-05, Q4 and Q5), built, proposed for
  the next steward revision: a run is read only by its starting credential and the owner's app, anyone else getting
  `unknown_run` as with `outcome`, and a rule's or a schedule's run by the owner's app alone; such a
  run may be stopped by members and up, guests and visitors refused `not_permitted`.
- **What a run leases when its starter could not act on an `owned` device** (gap; found by the
  milestone 5+6 review). Not said. Ruled by the maintainer (2026-10-05, Q6), built, proposed for the next steward revision:
  a run leases only the `owned` devices its starter's role could act on.
- **Whether a run's step waits for the last** (gap; found by slice 5's plan). Not said; this build
  waits for each action step's first final outcome, so steps that depend on each other run in
  order (slice 5's plan, *Rulings*).
- **A rule-started run's failures are told nowhere** (gap; found by slice 5's plan). GA-RULE-8's
  notice covers a rule's own actions; a run's steps are seen only in `scenario_status`, which no one
  started by hand reads. Ruled by the maintainer (2026-10-05, Q2 and Q3), proposed for the next steward revision: one
  combined failure notice per rule-started run, as a scheduled run's (slice 6 builds it); a
  `refused(leased)` step raises none but stays in `failed_steps`.
- **A finish block** (gap; found by slice 5's plan). A stop or the run limit leaves the
  devices where they are; a finish block would put them right at the end. Ruled by the maintainer (2026-10-05), proposed for the next steward revision and not built yet: a
  finish block runs however a run ends (completed, stopped, or cut off by the run limit), but not
  after a restart that interrupted it.
- **Three negative rows miss coupled ids** (found by slice 5's matrix): `tokens-without-a-yes`
  GA-SCN-3, 7 and 11; `refuses-the-toggle` GA-SCN-3 and 11; `authors-a-toggle` GA-SCN-11. Listed in
  `reference/steward/known-outside.json` until then. (A fourth, `drops-the-starting-endpoint` on
  GA-CONF-3, was the case's own fault, fixed by the milestone 5+6 review's B5.)
- **"Not run late" has no measure for a live steward** (gap; found by slice 6's plan). GA-SCHED-2
  speaks of a steward that was down; a running steward whose clock jumps or whose process stalls
  fires a timer late, and the text does not say how late is too late. This build records
  `schedule_missed` for a timer more than 60 s past its run, and every date it passed over since the
  schedule's mark. Proposed: "a run not started within 60 s of its time is recorded
  `schedule_missed`", beside the grace after a restart the backlog holds.
- **A scheduled start while its `single` scenario runs** (gap; found by slice 6's plan). GA-SCN-1's
  `ignored` is a client's answer; a schedule has no client. Ruled by the maintainer 2026-10-05: the
  run waits, tried every 10 s, and starts once the scenario ends within 5 minutes of its
  time, a restart within them included (the wait kept in the store), never after them; when the
  grace closes first, the date is `schedule_missed` with `reason: scenario_running`. Proposed for
  the next steward revision: say so.
- **A long absence's missed runs have no bound** (gap; found by slice 6's plan). GA-SCHED-2 records
  each; a steward down for months would write one event a day. This build records the latest 64,
  the first carrying `earlier`, the count before them.
- **`days` absent, and an exception on a day the schedule does not run** (gap; found by slice 6's
  plan). The text lists `days` without saying it may be left out, nor what a move on a day `days`
  leaves out does. This build: absent is every day; such an exception is kept and does nothing.
- **When a changed schedule takes effect** (gap; found by slice 6's plan). Not said whether a time
  changed to later today runs again today, nor whether the runs before a change count as missed.
  This build: a schedule made or changed acts from its next run, at most one run a date.
- **"Each schedule's last run"** (wording; found by slice 6's plan). *Restarts* and GA-PERSIST-2 keep
  a schedule's last run; what a restart needs is the last date handled (run, skipped or recorded
  missed). Proposed: "each schedule's last handled date".
- **A scheduled run's failures are told nowhere** (gap; found by slice 6's plan), as a rule-started
  run's (slice 5's problem): GA-RULE-8's notice is a rule's own action's. Built (G3, ratified by the
  maintainer 2026-10-05, and Q2 for a rule-started run): one notice per scheduled or rule-started
  run, naming each step of its `failed_steps` a rule's action would be told of, through the notice
  pump with its caps; a `refused(leased)` step raises none but stays in `failed_steps` (Q3).
  Proposed for the next steward revision.

- **A safety rule's lease has no `expires`** (gap; found by slice 7's plan). `state`'s `leases` give
  each lease an `expires` time; a safety rule's lease ends with its latch or its completion, not at
  a time. This build shows `expires: "safety_rule"`. Proposed: name it in the shape.
- **The applier's events cursor is opaque, but recovery must align history with it** (gap; found by
  slice 7's plan). The steward reads the applier's `history` "from the time of the last event it
  had" and must neither record twice what it relayed nor what the new cursor will serve. This build
  keeps the gap's events by `seq`, after the last one it had and up to the sync's cursor read as a
  number. Proposed: say a cursor orders as `seq` does, or give `history` an `after_seq`.
- **`history` has no paging** (gap; found by slice 7's plan). Neither the applier's nor the
  steward's `history` names a cap or a cursor; 7 to 90 days of a busy home is large. This build
  caps a call at 10 000 events and says `more`; a client reads on from the last event's time, which
  can skip events sharing its millisecond. Proposed: a cursor, as `events` has.
- **Edges inside a gap** (departure, ruled 2026-10-04; found by slice 3b, built by slice 7).
  GA-RULE-1 says an edge-triggered rule's events inside the gap are lost; this build replays an edge
  at most 5 minutes old, once, its conditions judged now. Proposed for the next steward revision: allow a bounded replay.
- **A recovered event's time** (gap; found by slice 7's plan). The steward's `history` is oldest
  first, but a missed event happened before the events the steward recorded while it was away.
  This build records it with the steward's time and `seq`, marked `recovered`, the applier's time
  kept as `applier_time`. Proposed: say which time orders `history`.
- **The steward's `rule_fired` names no device** (gap; found by slice 7's first light), so
  `history { targets }` leaves out the firings that acted on a device, where the applier's
  `rule_fired` carries `devices`. Proposed: the steward's `rule_fired` carries its actions' targets.
- **Recovery after `cursor_expired` only** (wording; found by slice 7's plan). *Rules* reads the
  applier's history after a `cursor_expired`; a restart and a session made again leave the same
  gap, and GA-RULE-1 already names a restart. This build recovers after every sync once it has had
  an event of the applier's. Proposed: "after any gap in the events".
- **`ignores-leases`'s row should name GA-STW-7** (coupling; found by slice 7's matrix). A steward
  that ignores leases records no `lease` event and no refusal a lease caused, so it fails GA-STW-7's
  history case; listed in `known-outside.json` until the row names it.
- **A safety rule not yet in `describe`** (gap; found by slice 7's harness). A rule configured just
  before it fires reaches the steward's events before its `describe` is read again; whether it
  latches is unknown when its `rule_fired` arrives. This build counts it latching once its latch was
  seen set. Proposed: the applier's `rule_fired` says whether a latch holds.

- **`define { plan_id }` has no answer or error list of its own** (gap; found by slice 10's plan).
  GA-DEF-6 says only that unanswered it changes nothing. This build checks it as `apply` checks a
  plan (`unknown_plan`, `plan_not_yours`, `plan_expired`, `stale_revision`), refuses an endpoint or
  speaker other than the plan's and a plan that is not a define's `invalid_request`, and,
  unanswered or answered no, spends the plan and returns `{ revision, skipped: "not_confirmed" }`.
  Proposed: say so.
- **The plan schema has no shape for a `confirm_define` step** (schema; found by slice 10's plan).
  `confirm_define` is listed among the reasons, but a plan step needs a target and an action, which
  a define's step has not. This build adds a `defineStep` (`step_id`, `verdict: ask`, `reason:
  confirm_define`, `diff`, `answer`) and a `defineRequest`. Proposed: both in the standard's schemas.
- **"Sets the device's room and groups again"** (wording; found by slice 10's plan). Read as both at
  once, an owner moving the device to another room would keep a brain's group mark, or must re-send
  every group. This build keeps the mark per path: an owner's upsert of the target clears the room's,
  of a group that group's. Proposed: "the room or the group it joined through a brain".
- **No field says which step is `brain_authored`** (gap; found by slice 10's plan). A person asked
  to run a brain's scenario sees `refuse(tier)` with no reason to tell it from a tier refusal. This
  build adds `brain_authored: true` to a plan step. Proposed: name it.
- **A person-started run of a brain's scenario reads as the person's** (wording; found by slice 10's
  plan). GA-NOTE-2 gives such a run `{ endpoint, role }`, so a notify a brain wrote, run by an owner,
  shows as the owner's. Proposed: say whether `brain_authored` rides `{ endpoint, role }` too.
- **A rule exception made through a brain** (gap; found by slice 10's plan). The text marks a
  schedule exception that moves a run and never one that skips; a rule exception is neither. This
  build marks nothing, as a skip. Proposed: say so.
- **The reference scenarios' voice `define` hops depend on an optional policy** (coupling; found by
  slice 10's plan). HS1, HS6 and HS10 rest on "if the steward's policy accepts"; this build's policy
  (Q4, owner only) refuses a member's or a voice speaker's change, so their happy paths need an
  owner's chat window. Proposed: the scenarios say which policy they assume.
- **`skips-the-ask-event`'s row should name GA-DEF-6** (coupling; found by slice 10's matrix). A
  brain's define is asked as any plan, its `ask` event put on the endpoint; a steward that skips the
  ask event fails GA-DEF-6's case. Listed in `known-outside.json` until the row names it.

- **GA-PERSIST-2 does not keep a rule's firing in flight, nor its pending retries** (gap; found by
  slice 11's plan). It lists the notices GA-RULE-8 holds, but a firing whose outcome the applier
  gives while the steward is down, or a retry GA-RULE-7 owes, is lost with the steward's memory: an
  idempotent action that ended `unreachable` during a restart is never tried again though its rule
  still holds. This build keeps both (slice 4's retry rows, slice 11's `sent` rows). Proposed: list
  "each rule action's pending retry and each firing whose outcome is not yet final".
- **A restart's recovery is implied, not said** (gap; found by slice 11's plan). The text has a
  steward read the applier's history after a `cursor_expired`, and GA-RULE-1 fires a rule "after a
  restart or `cursor_expired`", but *Restarts* does not say a start reads what the applier did while
  the steward was down, nor from where. A steward that reads only `state` at start leaves a step
  `dispatched` that the applier settled meanwhile. Proposed: "at start, the steward reads the
  applier's history from the last of its events it had, as after a `cursor_expired`, and keeps that
  position with what it keeps".
- **"Survive a restart" says nothing of a crash** (gap; found by slice 11's plan). GA-PERSIST-2
  reads the same for a clean stop and a crash, yet Q6 has rules write behind while the store is down,
  so a crash may lose a held notice written behind; the harness cannot grade a crash against the
  text. Proposed: say what a crash may lose (what was written behind, at most the last moments' worth)
  and what it may not (a token's use, an idempotency key, a firing's `fired` mark), as the applier
  backlog proposes for applier 0.15.
- **A held notice whose wait passed while the steward was down** (gap; found by slice 11's plan).
  "Raised once its wait has passed with no `late_ack`" cannot be met on time across a downtime, and
  a late ack in the applier's history may have landed it. This build raises it once the start has
  read the applier's history, which waits for the applier. Proposed: say a notice owed during a
  downtime is raised at the resume, once the steward has read what the applier did meanwhile.
- **`forgets-a-held-notice`'s row grades only a restart inside the wait** (wording; found by slice
  11's plan). A steward that keeps the notice but forgets it once the wait passed while it was down
  passes the row. This build's case covers the restart inside the wait, as the row says; the unit
  tests cover the other.
- **`ignores-leases`'s and `notices-a-late-launch`'s rows should name GA-PERSIST-2** (coupling;
  found by slice 11's matrix). GA-PERSIST-2's case reads a lease kept and a run's released across a
  restart, and a late ack the applier gave while the steward was down landing a held notice; a
  steward that ignores leases, or keeps a `failed(no_ack)`'s notice after its late ack, fails it.
  Listed in `known-outside.json` until the rows name it.

## Standards fixes this build shows

Filled here provisionally, for the next steward revision:

- How the first owner, endpoint and credential come to exist (ruled, Q2), and the subject contract's
  variables for a steward (`GALATEA_OWNER_CREDENTIAL`, `GALATEA_APPLIER_URL`,
  `GALATEA_APPLIER_CLIENT`, `GALATEA_APPLIER_CREDENTIAL`, `GALATEA_APPLIER_TOKEN_KEY`).
  Slice 1's: the first owner is person `owner` (name "Owner"), endpoint `owner-app` (type `app`,
  no room, no brain) and credential `owner-app` bound to it, made only while the store holds no
  person. The build's own variables beside the contract's are `GALATEA_STEWARD_ID`,
  `GALATEA_STEWARD_HOST`, `GALATEA_STEWARD_TLS_CERT`, `GALATEA_STEWARD_TLS_KEY` and
  `GALATEA_APPLIER_CA` (paths, as the reference applier's). A `define` that commits is a `define`
  event with `revision`, `endpoint`, `person` and the `diff`'s lines; never a secret.
- A store-unavailable answer (slice 1): MCP error -32603 with `data: { pending }`, `pending` false
  when nothing was held (the store known down, refused at once, Q6; the owners' line full), true
  when a `define`'s 10 s passed in the owners' line or in its commit: it is still judged at its
  `expected_revision` and applied when its turn comes (ruled 2026-10-02). The standard names no
  such error.
- The shape of each `define` kind's `value`, the change envelope (the applier's), the dry run's
  diff, and what a `delete` names.
  Slice 1's, as `conformance/schemas/steward/define.*.json`: `home` sets the fields it gives, a null
  one back to its default, and is never deleted; `voice` is an endpoint's record, upserted with its
  `endpoint` and deleted by `{ endpoint }`, and an endpoint's upsert keeps the record it has; every
  other delete names `{ id }`. The diff is one line per object added, removed or changed, a
  credential's secret shown only as set or changed.
- Credentials (slice 1): an `app` or `panel` credential names one endpoint of its own type; a
  `brain` or `front` credential names none and is bound through `served_by` and `heard_by`; only a
  `brain` credential carries a `confirm_on`; no two credentials share a secret; `served_by` names a
  `brain` credential.
- The home's `timezone` has no default in the standard: this build keeps UTC until the owner sets
  it.
- Every id in `notice_channels` is an adopted target with `notify` or `media.announce` (the table's
  "targets with `notify`, or with `media.announce`"), and at least one has `notify` (GA-DEF-8).
- `describe` (slice 1): each endpoint's `max_role` as it applies (the standard's default where the
  owner set none) and its `confirm_on` (`same` where it names none); every list in code-point order
  of ids; a target as the applier describes it with `name` (its label), `aliases` and `room` until
  the overlay (slice 2a); `applier` empty until the link has read the applier. Operations not built
  yet are listed and answer `invalid_request` ("not built yet"), as the reference applier's were.
- The rule language: triggers, conditions, `between`, `not_in`, as data.
- The `credential` kind: `{ id, kind, secret, endpoint?, confirm_on? }`; a brain's `confirm_on`
  rides on its credential, as the standard says, which no table shows.
- Relayed events: the steward's `seq` and time, the applier's as `applier_seq` and `applier_time`.
- The fields of the steward's own events (`ask`, `answer`, `lease`, `narrowed`, `refused`,
  `scenario`, `schedule_missed`, `schedule_skipped`, `notice`): the standard names what they carry,
  not their keys.
- A notice's delivery principal (*Standards problems*).
- The error for a `yes` after a `no` on one step: `invalid_request`.
- `time_source` outside the harness: `invalid_request`; the standard says only when it is accepted.
- The run's re-ask (*Standards problems*).
- How long `outcome` serves an apply: 3600 s, with its idempotency key, to the credential that
  applied.
- The run limit (6 h, ⚠️ a guess) and its status (*Standards problems*).
- The cursor of `events` and `zone_sources`: a decimal `seq` and a version counter, each expiring as
  the applier's does.

- The `target` and `group` kinds (slice 2a, as [`conformance/schemas/steward/define.target.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/schemas/steward/define.target.json) and
  [`conformance/schemas/steward/define.group.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/schemas/steward/define.group.json)):
  a target's overlay `{ id, name?, aliases?, room? }`, replaced whole by its upsert, `room: null`
  taking it out of its room, a computer's `account_persons` left to slice 8; a group `{ id, name,
  aliases?, room, members, aggregate }`, its id never a device's. GA-DEF-9 and GA-DEF-10 are checked
  on the devices a change names, so a device the applier unadopts or marks `internal` later stays in
  its room or group, left out by resolution (GA-PLAN-6).
- `describe`'s targets and groups (slice 2a): `name` the overlay's, else the applier's label, else
  the id; an `internal` device listed only to the owner's app, an app credential whose endpoint's
  person is the owner with a cap of `owner`, and left out of a group's `members` for anyone else; a
  group whose id a device of the applier's has carries `shadowed: true`. Room, group and target
  ids, a group's members and room follow the applier's id grammar.
- `state`'s `groups` (slice 2a): `{ <id>: { on } }`, `on` null when no member has `onoff` or none of
  them has a reading yet, and once one has, a member with no reading not on (ruled 2026-10-04);
  every personal value `withheld` from every caller until the personal floor (slice 8); an
  `internal` device's state shown to the owner's app only, as in `describe`.
- The plan the steward asks of its applier (slice 2a): each resolved step with `via` (the endpoint's
  type), `brain` (whether a brain serves the endpoint) and `for: { person?, endpoint }`, no token;
  the applier's steps matched to the steward's by target, action and canonical args; while the
  applier is out of reach every step `skip(dead)` (*Standards problems*).
- Held plans (slice 2a): at most 64 per credential, the oldest dropped; each forgotten once expired
  as long again as it lived; a plan with an ask refused at once while the store is known down and
  dropped, `pending: false`, when its commit outlasts 10 s, with no `ask` event for it. A plan with
  an ask is kept with when it was made and when each step was asked, and read back at start in
  slice 2b with the answers (ruled 2026-10-04); a plan with no ask is memory only, an accepted loss
  under GA-PERSIST-2. A plan's `request` is the fields the steward read. With no applier plan, an
  applier's refusal is a fault the steward shows (`applierFault`); an applier's `refuse(token)` on a
  reversible step, which a conforming applier never gives, is failed closed as `refuse(tier)`.
- An `ask` event (slice 2a): `{ seq, time, type: "ask", plan_id, step_ids, endpoint }`, the endpoint
  the endpoint's `confirm_on`, else its brain credential's, else the plan's.
- `respect_occupancy: true` answered `invalid_request` ("not built yet") until rooms' occupancy,
  built in slice 3a.

- `answer` (slice 2b): each asked step of the returned plan carries the `answer` that stands for it;
  an `answer` event `{ seq, time, type: "answer", plan_id, endpoint, speaker?, answers, utterance? }`;
  an answer takes effect at once and is acknowledged when kept, past 10 s -32603 `pending: true`
  while it still stands; utterance records kept until no plan they could answer remains.
- `apply` (slice 2b): a plan is spent by its first apply (a second `plan_expired`, an answer
  `not_permitted`); an inline apply holds no plan and puts no `ask` event; the steward's `for` on
  every action it sends is `{ person?, endpoint, apply }`; one inline applier apply per steward
  apply, keyed by the steward's `apply_id`; an apply whose record outlasts 10 s is dropped,
  `pending: false`, never sent; a lost answer gives -32603 `{ pending: true, outcome_unknown: true }`.
- Outcomes (slice 2b): for each outcome of the applier's answer the steward puts an `outcome` event
  `{ apply_id, step_id, target, outcome, reason?, detail?, cause, applier_time }`, the steward's own
  apply and step; an applier event that would not move a step's outcome forward is not relayed; an
  outcome's fields in one order; a dropped apply's steps carry `detail: "dropped: the store did not
  keep the apply"`.
- Relayed events (slice 2b): an applier `outcome` or `late_ack` of the steward's apply carries the
  steward's apply, step and cause; a change the steward's apply made carries its `for` as cause;
  while an apply's answer is awaited, every batch waits for it (4096 events at most; past it the
  outcome events of an apply not yet known are held for its answer); a personal key's value
  `withheld` in `events` until slice 8.

- `state` (slice 3a): `rooms`, `{ <room>: { occupancy } }`, every room of the house; `leases`,
  `{ <device>: { holder, precedence, expires } }`, each device's standing lease, `expires` a time
  (`run_end` from slice 5); a provisional lease is not shown.
- Leases (slice 3a): one per device, a group expanded to its members; a person's apply lays a
  provisional lease at dispatch, which the answer makes the device's from dispatch or lifts where the
  step sent nothing (`skipped`, `refused`, `unreachable`, a call never sent or refused), and a lost
  answer keeps; an action is stateless as its device declares, else as the applier standard's list
  (`notify`, `media.announce`, `media.duck`, `cover.stop`, `power.*`); a `lease` event `{ target,
  change: granted | replaced | ended, holder, precedence, expires }`, its holder a principal's
  `{ person?, endpoint }` or the cause (`external`, `load_cap`).
- Occupancy (slice 3a): a room's sensors are the devices in it whose sensor keys name `occupancy` or
  `motion`; liveness history is the steward's own observation, so every room is `unknown` for one
  hold after a start; a sensor's last presence is its value's `basis_time`; its bound is `state`'s
  `fresh_s` (an owner's `configured` bound), else `describe`'s, with `describe`'s `fresh_slack_s`;
  a `yes` stands only for the reason it answered (*Standards problems*).
- Notices (slice 3a): a `notice` event `{ notice_id, change: raised | delivered, source, … }`, the
  notice's own fields beside; each attempt one applier apply keyed `notices:<life>:<n>`, holding a
  `notify` step per waiting notice and channel (the milestone review's B2, milestone ruling Q1), `via: rule`,
  `brain: false`, `for: { notice }`, `critical` for a safety rule's cause, else `warning`; one
  attempt at a time, the next 60 s after the last began; at most 1,024 of the steward's own notices
  waiting, the rest folded into one summary notice (`steward:summary`), the applier's never folded; delivered on `delivered`, or `sent` on a
  channel declared `confirms: false` or open-loop, from the answer or a later `outcome` event of any
  of the last five attempts; `notice_taken` on every `events` call until the applier stops listing
  it; only channels with `notify` until slice 9; the steward's own notice for a shadowed group, id
  `steward:shadowed:<group>`, each time the shadow begins.
- `from` (slice 3a): a request's `notify` carries `{ endpoint, role }` in its plan step's args, set
  when the plan is made; `from_replaced: true` on the plan's step, or on the inline step's outcome,
  which `outcome` returns too.

- Rules (slice 3b): the shapes of [`conformance/schemas/steward/define.rule.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/schemas/steward/define.rule.json), provisional;
  `rule_exception` as its own kind (`{ rule, from, until }`, an upsert adding, a delete removing);
  at most 64 exceptions; a window from up to, not including, until, ending the next day when until
  is not later, `days` naming the day it starts, a time in a daylight-saving gap read as the
  transition's instant and one that occurs twice as its first occurrence; a retired account's key
  false, `not_in` included; nothing judged before the first state read after a start; a held
  duration started afresh when its device stops being live, and at a restart.
- Firing (slice 3b): keys `rule:<id>:<n>` from reserved blocks of 1000, one skipped after an unclean
  stop; the `rule_fired` event `{ rule, firing, apply_id, cause: { rule } }`; a firing's `outcome`
  and `refused` events with cause `{ rule }`, `refused` naming the step and the lease's `holder`; a
  firing's record kept in memory only (256 at most); a rule's principal `{ endpoint: rule:<id>,
  person: null, via: rule }` at owner role; a rule's `notify` `from` `{ rule }`; a logic change or
  an activation resetting `fired`, a name's or an exception's not; the devices a rule names, for a
  lease's end, its reads, its actions' targets, its groups' members and its selectors' matches as
  they resolve now (the milestone review's M8); no firing number taken more than one block past
  the reservation the store holds (M5); `fired_at` kept, and `fired` cleared at a rule's first look
  in a life where a window or an exception ended between the firing and now (B7); a held rule's
  `fired` kept through a fresh start of its duration (M1, milestone ruling Q2, provisional); an edge only on a
  change of value seen while live (G4).
- Authored judging (slice 3b): a rule's step skips the tier entry and the token entry above
  `reversible`, and is judged from `leased` on; `toggle_only` always a skip; the applier's own skips
  and refusals at plan sent for it to judge again, with the authored token the step would need, or,
  where the lease or the room as they are at dispatch stand in the way, ended with their own reason
  (the order puts it first) and not sent; a step the steward could not plan
  on the applier never sent, ending `unreachable` (the milestone review's B4); authored work on a
  device marked `internal` refused `role` at firing (M10).
- `session.lock` (slice 3b): steps on one computer for different accounts are not a conflict.
- The notice for a rule reading a device with no known `fresh_s` (slice 3b): id
  `steward:unbounded:<rule>:<device>:<revision>`, cause `rule_unbounded`, once per rule, device and
  house revision.
- Retries (slice 4): 60 s after the last try, or the action's `ack_within_s` when longer; a retry is
  a new firing of the failed steps only, with its own number and key, its `rule_fired` carrying
  `retry: true`; a retry due after the rule stopped holding, or after it became true again, is
  dropped; a described device lacking `ack_within_s` left out as malformed (the milestone review's
  M4); a pending retry's `rule_pending` row (I3); a firing whose answer was lost asked again under
  its key every 60 s for up to an hour (I1); one notice, `still_tried: true`, once an action tried
  again has failed for 10 minutes in one becoming true (the maintainer, 2026-10-05, proposed for the next steward revision).
- Failure notices (slice 4): id `steward:rule:<rule>:<firing>:<step>`, cause `rule_failed`, the
  `notice` event's fields `{ rule, action, target, outcome, reason?, text }`; a lock's late-ack wait
  counted from the applier's answer to the apply, a `failed(no_ack)`'s 60 s window from when the
  steward learns the outcome, each plus a flat 11 s slack; "that action" is its target, action and
  args, within one becoming true; every skip the text does not name raises the notice,
  `skipped(occupancy_unknown)` once per rule and room (milestone ruling Q4, provisional); at most 1024 held, the
  oldest raised early past it; while one waits, a later `rule_failed` for the same rule and action
  counts into it, carrying the latest outcome (B2, milestone ruling Q1). Ratified by the maintainer (2026-10-05), a departure
  for the next steward revision (G3): a held rule's action retried and noticed as a rule of conditions only's; an edge rule's
  failed firing noticed once, coalesced, never retried.
- Toggle notices (slice 4): id `steward:toggle:<rule>:<target>:<action>:<revision>`, cause
  `rule_toggle`; given for a rule a `define` set or changed, and for a toggle newly in a rule's reach
  on a `describe`; the first `describe` after a start takes what it finds as told, and before it
  none are told or seeded (M2: a rule defined before the first `describe` is not told until its
  toggles change).

- Scenarios (slice 5): the `scenario` kind as [`conformance/schemas/steward/define.scenario.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/schemas/steward/define.scenario.json),
  provisional, `delay` in seconds, a `wait` `{ target, key, value, timeout_s, on_timeout }`, an `if`'s
  branches checked by `define`; `describe`'s `modes` (`single`) and `scenarios`; a new scenario's diff
  line showing `owned`; deleting a group a rule or a scenario names refused, the dependants listed;
  the `if` notice `steward:unbounded-if:<scenario>:<device>:<revision>`, cause `scenario_unbounded`.
- Runs (slice 5): `scenario_plan`'s request `{ endpoint, speaker?, scenario }`, its steps
  `s<n>`/`s<n>.<k>`, an `if`'s marked `conditional`; a run's key `run:<run_id>:<n>`; its cause
  `{ run, person?, endpoint }` or `{ run, rule }`; each action step waits for the last's first final
  outcome; a `scenario` event `{ run_id, scenario, change: started | ended | if | wait_timeout |
  ignored, … }`; `failed_steps` as of the run's end, a lost answer (`unknown`) listed; a start a
  running `single` scenario ignores keeps its key and leaves the plan unspent; ended runs kept 3600 s
  from their end; a run the store holds as running at a start ended `interrupted`; the re-ask's
  `ask` event names the run (`run_id`); an ignored start's key counted against the credential's cap
  and kept in `run_keys`; an applier's `skip(already)` on authored work settled by the steward as
  `skipped(already)`, nothing sent (the milestone 5+6 review, B1, I1, M8).

- Schedules (slice 6): the `schedule` kind `{ id, scenario, time, days?, exceptions }` and the
  `schedule_exception` kind `{ schedule, date, action, time? }` as
  `conformance/schemas/steward/define.schedule*.json`, provisional; one exception a date, an
  exception upserted replacing its date's and deleted only when named whole; `describe`'s
  `schedules`. A schedule's mark is a date in the home's timezone (table `schedule_marks`), only
  ever raised, a `define`'s write included; a `define` that makes or changes a schedule (every
  schedule when the timezone changes) marks it so it acts from its next run. The events
  `schedule_missed` and `schedule_skipped` carry `{ schedule, scenario, date, at, cause: { schedule }
  }`, `earlier` on the first of an absence; a scheduled run's cause is `{ run, schedule }`; a timer
  more than 60 s late runs nothing. A schedule whose `single` scenario runs waits (table
  `schedule_pending`), tried every 10 s for 5 minutes and never after them, then `schedule_missed`
  with `reason: scenario_running`; a start that finds its scenario just started, after its date was
  marked, waits the same way. The toggle notice: id
  `steward:schedule-toggle:<schedule>:<target>:<action>:<revision>`, cause `schedule_toggle`, its
  fields `{ schedule, scenario, target, action, text }`. The failure notice: id
  `steward:schedule:<schedule>:<run_id>`, cause `schedule_failed`, its fields `{ schedule, scenario,
  run_id, failed: [{ step_id, target, outcome, reason? }], text }`, coalesced per schedule while one
  waits for delivery, raised at the run's end with no late-ack wait; a rule-started run's the same
  with id `steward:rule-run:<rule>:<run_id>`, cause `rule_run_failed`, `rule` for `schedule`,
  coalesced per rule.

- History and recovery (slice 7): `history { targets?, from, to, endpoint?, speaker? }` →
  `{ events, more? }`, at most 10 000 events a call, read from the store once the writer has
  committed what it holds, failing with `pending: false` while the store is down; a `targets` filter
  matching an event's `target`, `device`, `devices` or `targets`; kept 90 days, a personal key's
  `state` events 7 (column `events.personal`); the `reader` role's view `history_v`, without any
  personal key's event. A safety rule's lease: holder `{ safety_rule }`, precedence `safety_rule`,
  shown `expires: "safety_rule"`; granted by the rule's `outcome`, a `state` change it caused or its
  latch `set`; ended by its latch `cleared` or `cleared_by_owner`, or, with no latch, by its first
  `rule_fired` timed at or after the grant; a rule `describe` does not list counted latching once
  its latch was seen set; `state`'s latches read on every sync. Recovery: after every sync once the
  steward has had an event of the applier's, the applier's `history` from that event's time, at most
  7 days back; its events after that `seq` and up to the sync's cursor, from the same `applier_id`
  and `test_run_id`, at most 4096 (the newest; a level rule reading a dropped one's device counts as
  having become false); each recorded with the steward's `seq` and time, `recovered: true`,
  `applier_time`; a missed `external` or `load_cap` change leased from its time, its hold judged as of the
  gap's events (*Leases*), never over a lease granted after it; an edge at most 5 minutes old firing once after
  the state is read; an applier's refusal of `history` said, the sync going on.
- **Work through a brain (slice 10).** The policy: the `owner` role only (Q4), for room, target
  (names and room), group, scenario, rule, rule exception, schedule and schedule exception, deletes
  included; anything else `not_permitted`. A brain's change set that changes nothing returns
  `{ revision }` and asks nothing; a dry run returns the diff and asks nothing. A define's plan
  carries the request `{ endpoint, speaker?, changes, expected_revision }` and one step `{ step_id:
  "s1", verdict: "ask", reason: "confirm_define", diff }`, the diff showing the marks.
  `define { endpoint, speaker?, plan_id }` is checked as `apply` checks a plan; unanswered or
  answered no it returns `{ revision, skipped: "not_confirmed" }` and spends the plan; a define's
  plan given to `apply` or `scenario_run` is `invalid_request`. Marks: what a brain upserts unchanged
  is not marked; an owner's upsert clears the mark; a rule exception marks nothing; a device's mark
  is per path (`room_brain_authored`, a group's `brain_joined`), cleared by an owner's upsert of the
  target or the group; `describe` shows a target `brain_authored` while any path is marked, and a
  group without `brain_joined`. A plan step of marked work carries `brain_authored: true`; a person's
  run of a marked scenario sends its steps with `brain: true`, its notify's `from` still
  `{ endpoint, role }`; a marked step's notify carries `brain_authored: true` with its `{ rule }` or
  `{ scenario }`.
- **Restarts (slice 11).** A held notice is a `rule_pending` row of kind `held` (`step_key` the
  firing's number and step id, `due_ms` the end of its wait, the firing with that step and its apply
  in `doc`), written behind; read back at start, its firing's record rebuilt by the applier's apply
  id, its timer armed once the start's first sync has read the gap; one whose wait passed while the
  steward was down raised then; one of a rule deleted dropped. A firing the applier answered is a row
  of kind `sent` until every step it sent has a final outcome, or its record is forgotten at the cap;
  rebuilt at start with its open steps `dispatched`. A gap's firing outcomes are judged once the
  state is read, a `cursor_expired`'s too. The applier's last event the steward had, relayed or not,
  is `meta` `applier_last` (`{ seq, timeMs, applier }`), written behind and coalesced; the start
  reads the applier's history from it. A scheduled start that found its scenario just started keeps
  its wait as `schedule_pending.marked`; at start a marked wait inside the grace waits on, one past it
  is `schedule_missed` (`scenario_running`), its mark left, and a wait of a deleted schedule is
  dropped.

## Rulings on the open questions

The first draft put nine questions to the maintainer, each with options, a recommendation and its
cost. The maintainer ruled on 2026-10-02; the body is written to these rulings. Three went against the
recommendation (Q3, Q7, Q9).

1. **What the steward is graded against: both.** The harness grades it against the stand-in
   applier, grown into a scripted, in-process neighbour; a separate end-to-end check runs over the
   reference applier and the simulated bridge (*How it is graded*).
2. **The first owner:** `GALATEA_OWNER_CREDENTIAL` on an empty store creates the owner, their app
   endpoint and its credential, and is ignored once an owner exists.
3. **The slice order: rules and schedules first after first light** (against the recommendation,
   which was history, leases and occupancy first). Only what they need was pulled forward
   (*The slices*).
4. **`define` through a brain:** none until slice 10; then from the `owner` role only, for
   scenarios, rules, schedules, exceptions, names, rooms and groups, each asked as
   `confirm_define`.
5. **Personal values beyond the floor:** owners and members read them.
6. **Rules and schedules while the store is down: they keep running,** with firing keys from
   blocks reserved ahead and records written behind; the accepted cost is a possible double send
   after a crash during the outage (*Bounds*).
7. **Shared algorithms: one shared package** for the token proof with its RFC 8785 form and the
   voice normalisation with its echo match (against the recommendation, which kept the
   normalisation per build). The TypeScript builds import it; the Python voice front keeps its own
   port, checked against the package's test vectors (*Where it lives*).
8. **A plan's revision:** build to the text in slice 2b; a steward revision narrowing it is
   proposed before slice 9 brings narrowings.
9. **The optional surface: both deferred** (against the recommendation): no ducking, and mode
   `single` only. GA-LISTEN-5, the duck clauses of GA-LEASE-3 and GA-AUTH-5, GA-SCN-1's other
   modes and `unducks-anything` stay ungraded until a later slice adds them.

## Decisions this design makes, for the maintainer to overrule

- A new package, a serial core in memory with one writer behind (approach A), copying the
  reference applier's core.
- The steward exits on a store fault; it holds no protection to keep running for.
- Authority waits for its commit (define, answers, applies, asked plans, and, while the store is
  up, firings, run steps and schedule marks); narrowings, events and history are written behind.
- Credentials are kept as SHA-256 of their secrets.
- Relayed events carry the steward's seq and time.
- `history` kept 90 days, personal keys' `state` events 7 days, for privacy.
- The run limit: 6 h, a guess, ending a run `ended(timeout)`.
- While the applier is out of reach, a plan's steps are `skip(dead)`, not an error; a brain
  cannot tell this from a dead device.
- Provisional leases from dispatch, kept only for `dispatched` steps.
- A client's stalled apply is dropped after 10 s, never sent late; while the store is known down,
  client writes are refused at once; rules, schedules, runs and narrowings go on (ruled, Q6).
- The applier link is a port with an in-memory fake for unit tests.
- First light at slice 2b, with an end-to-end script over the reference applier and the simulated
  bridge before the flat.
