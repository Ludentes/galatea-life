---
title: Storage for the reference builds — design
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/specs/2026-09-27-voice-front-design.md
  - docs/specs/2026-09-25-voice-architecture-design.md
  - conformance/README.md
  - standard/voice.md
  - standard/applier.md
  - standard/steward.md
---

# Storage for the reference builds — design

Classification: **architectural**. No reference build keeps state yet. Two plans chose a store of
their own: the voice front's stage 2b (SQLite) and the reference applier's slice 1 (`node:sqlite`,
on its own branch). This design decides where every reference build keeps its state, so each build
doesn't decide it alone.

The standards don't change here, with one exception: the audio rule (*Audio*). They grade what
crosses the wire and what survives a restart, not the engine behind it. So this is a decision for
the reference builds and their installation.

## Rulings it stands on

- **The drivers** (the maintainer, 2026-09-28): one store for all builds, history and analytics,
  and access from other boxes on the home's LAN. Brain memory and search were the fourth driver
  at first. They were withdrawn the same day: the brain is upstream of us, and we define only its
  general shape (the brain standard). Our reference brain, a basic prompt-based build, may keep
  its state in the same store, and nothing here is built for it.
- **One Postgres** (the maintainer, 2026-09-28), chosen over a hybrid (SQLite for each service's
  own state, Postgres for what crosses boxes) and over SQLite everywhere. The evidence: SQLite is same-host by design and
  corrupts on network shares. Postgres is the only candidate that serves another box natively, and
  one engine is one thing to run, back up, upgrade and test.
- **Audio stays on the home's LAN** (the maintainer, 2026-09-28), relaxed from "on the box". See
  *Audio*.
- **The applier on Postgres, safety first** (the maintainer, 2026-09-28; its costs accepted 2026-09-29). See *When the store is
  unreachable*.
- **A store fault stops the writer, and a late owner change still lands** (the maintainer,
  2026-09-29, with the conditions in *A store fault* and *A late owner change*). Both were checked
  against the reference scenarios first.
- **Prefer tested decisions.** An earlier product of the maintainer's runs Postgres in its Compose
  stack, with its dispatcher in the control path. It has worked; the pain was manual backups. This
  design keeps the engine and fixes the backups (*Backups*).

## Approaches considered

**A. One Postgres in the Compose stack, a schema and a role for each build** (chosen).
**B. Hybrid.** Each build keeps its own state in SQLite with Litestream, and one Postgres holds
what other boxes and analytics read. Rejected. It is two kinds of store to run, back up and test,
and "one store" was the first driver. A build's history would also exist twice: in its file, and
copied into Postgres.
**C. SQLite everywhere**, as the two plans had it. Rejected. It fails access across boxes, and
history and analytics would need a copy somewhere else anyway.

The research also covered TimescaleDB (its retention is under the Timescale Licence, and it is
more tool than 7 days of home events need), NATS JetStream (a second bus beside the MQTT ruling),
Redis (weak durability after a power cut) and libSQL/Turso (beta, a vendor pivot). None is used.

## The shape

```
Compose stack on the home box
  postgres        postgres:18-alpine, stock image, one database: galatea
    schema applier        owned by role applier
    schema steward        owned by role steward
    schema voice_<id>     one per voice front, owned by role voice_<id>
    schema bridge_<id>    one per bridge that keeps state
    schema brain          the reference brain, if it wants one
    role reader           read-only on each schema's history views (analytics, other boxes)
  db-init         one-shot, every `up`: creates missing roles and schemas
  backup          a small container: nightly pg_dump, keep 14, a restore check
  applier, steward, voice fronts, bridges, ...   each connects as its own role
Audio directory   a path on the box, or a NAS mount on the LAN; files only
```

- **One database, a schema for each running instance of a build.** Each instance connects as its
  own role, owns its schema, and has no privilege on any other. The server enforces the boundary
  rule that builds meet only over the wire: one build can't read another's tables even by
  mistake. One database, not one for each build, so the backup is a single dump and the analytics
  role can join histories across schemas.
- **One writer per schema.** A build that can run more than once in a home (voice fronts, bridges)
  gets a schema per instance, named by the id it has on the wire (`voice_kitchen`,
  `bridge_zigbee`). The applier and the steward are one per home. Everything below that relies on
  a single writer relies on this rule.
- **The schema is named as its role**, which is the instance's id. A build sets its `search_path`
  to that schema when it connects. (Postgres's default `search_path` starts with `"$user"`, which
  would find it too, but the harness's databases log in as their admin, so the build says so.)
- **Provisioning is `db-init`'s, not the builds'.** A one-shot container runs on every `up` as the
  database's owner. It reads the installation's list of instances and creates each missing role
  (with a password from the installation's secrets) and its schema, owned by that role. It never
  drops anything. So a bridge added later gets its schema on the next `up`, which
  `docker-entrypoint-initdb.d` (empty volume only) could not do. A build's role has no `CREATE` on
  the database. A build's migrations create its schema only when it is missing, which happens
  only in a test's database: in the installation, `db-init` has made it, and the role couldn't.
  They never drop a schema.
- **The stock image.** Nothing here needs an extension outside the official image (`pg_trgm` and
  the text search configurations are in it). So a major upgrade never waits for a third-party
  image to catch up. A build that later wants an extension argues for it in its own design.
- **Postgres 18**, the current major. The Compose file mounts the volume at `/var/lib/postgresql`,
  as the 18 image expects (the research, *Versions and the Docker image*).
- **Every build that keeps state uses it**: the applier, the steward, the voice front, and each
  bridge whose standard asks it to keep state. The harness's simulators and stand-ins don't; they
  are fixtures (*Tests*).

## Inside a build

- **Its own schema, its own migrations.** A build keeps numbered SQL files, `migrations/0001_*.sql`
  onwards, and applies them at start inside one transaction, recording each in
  `<schema>.migrations`. A build never edits an applied file; it adds the next one. No ORM or
  migration framework is prescribed: plain SQL files and a runner of about thirty lines, one in
  TypeScript for the TypeScript builds and one in Python for the voice front. A build may adopt a
  query builder in its own design.
- **Drivers:** `pg` (node-postgres) for TypeScript and `psycopg` 3 with its async pool for Python.
- **A thin query interface in TypeScript.** node-postgres can't run against PGlite, so each
  TypeScript build talks to the store through a small interface of its own:
  `query(sql, params) → rows` and `transaction(fn)`. It has two implementations of a few lines
  each: one over a `pg.Pool`, one over PGlite's own `query` and `transaction`. The interface lives
  in each build, not in a shared package, because builds import nothing from one another.
- **The single writer serves its own long polls.** Each schema has one writer, its build, so a
  "wait for new" (`events` with `wait_s`, `describe` with `wait_s`, the front's `listen`) is a
  waiter in the build's own process, released when that process commits the next row. No
  `LISTEN/NOTIFY` is used. Cursors and retention stay as each build's design already has them.
- **Retention is a periodic `DELETE`** on an indexed time column, run by the build that owns the
  rows (7 days of applier history, 3600 s of steward events, and so on). Partitions are not used:
  at tens of events per second a delete is cheap, and partitioning is a change a measurement can
  ask for later.
- **Histories are readable by `reader`** through a view the build names in its migrations, for
  example `applier.history_v`. The view is the build's promise. Its tables stay free to change.

## When the store is unreachable

The store runs on the same box as the builds that write to it, so it is unreachable only when its
container is down, the disk is full or an upgrade is under way. A build treats that as its own
outage. A request that needs a write gets an error (an MCP internal error, JSON-RPC -32603), never
a result the build could not keep. No standard names a code for this, and none is invented here.

- **Most builds** (the steward, the voice front, bridges) stop taking work that needs a write,
  answer it with that error, and retry the connection with backoff. "Not ready" means their
  Compose healthcheck fails, which the owner tool shows. A build that runs outside the stack, such
  as a voice front on a second box, is watched by its own host's supervisor, and the owner sees it
  through the status it reports to the steward.
- **The applier, safety first.** See the next section.

### The applier, safety first

This changes the applier's approved design (*The core*: "one SQLite transaction per step"). The
change is made in that design, on its branch. What follows is what that change must keep.

- **The queue still never awaits.** A step stays synchronous and in memory, as now. It changes the
  applier's state in memory and hands its writes, one write set per step, to a single store
  writer. The writer commits write sets one at a time, in the order the steps ran, and retries a
  failed commit until it succeeds. So a slow or hung store never holds a step, and a leak rule
  never waits behind a commit.
- **Some effects wait for their commit.** A step whose effect must not happen unless it is kept
  doesn't publish or reply itself. It registers the effect to run when its write set commits, and
  ends, the same way it already waits for a PUBACK. These are the steps that write a used token
  (GA-TOKEN-4), an idempotency key with its outcome, and anything the owner's `configure` or adoption changes:
  the configuration (GA-CFG-2), the id map, retired identifiers, adoption state and
  `ignored_keys`.
- **Memory runs ahead of the store only where that is safe.** A used token is marked in memory at
  once, so a second use is refused at once. If its commit never happens, its command was never
  sent, so reusing the token after a restart does no harm. An owner's change by `configure` or adoption
  is the opposite: it reaches memory only when it commits, as a step of its own that the writer
  queues. Until then every step sees the old configuration. So no plan runs under a tier, an
  adoption or a safety rule that the store doesn't hold.
- **Model changes from bridges are protection's kind.** Several model changes have no caller:
  - a device new to the applier appearing unadopted (GA-ADOPT-1);
  - a declaration change, and the safety rules GA-SAFE-13 then disables with `rule_disabled`;
  - the GA-ADOPT-5 swap when an old version's devices leave;
  - GA-PROV-4's forgetting of a plugin's devices.

  These record what a bridge has already done, and nothing may refuse them. So they reach memory
  at once and are written behind in order, like protection. A rule disabled this way stops firing
  at once. Only the owner's changes (`configure`, adoption) are gated.

  Bridge changes can land in memory before an owner's change that the store will apply first. So
  when an owner's change reaches memory, it is applied on top of the current model, not the one it
  was validated against. The checks that bridge changes trigger are then run again. GA-SAFE-13
  disables a safety rule that no longer passes. Anything that now refers to a device that is gone
  is disabled, with a notice. That is the committed counterpart of GA-ADOPT-1's refusal: the
  change has committed, so it can no longer be refused. Whatever these checks change is written
  behind like any bridge change. Memory and the store then end in the same
  state.
- **One owner change at a time.** While a `configure` or adoption change waits for its commit, the
  next one, a `configure` with `dry_run` included, waits outside the queue and is not validated. When the first commits and
  reaches memory, the next is validated against it: its `expected_revision` (GA-CFG-2) against the
  new revision, and its whole set against the new configuration. A change waiting longer than the
  10 s below gets the error, and it is never applied later. Configuration changes are rare and
  the owner's, so a serial line costs nothing a home would notice.
- **A gated effect runs only within 10 s of its step.** If its commit lands later, the effect is
  dropped. A dispatch is not sent, and it ends with an outcome of the standard's for a command
  that was never dispatched; the applier's design picks which. Its token was never used, because
  GA-TOKEN-4 counts a token as used only when its action is dispatched. So the drop queues a
  write set that removes the used-token record and records the dropped outcome against the
  idempotency key, so a retry finds it after a restart too. Memory keeps the token marked until that commits,
  then frees it, so memory stays on the safe side throughout. A `configure` still takes effect,
  because it is the owner's durable change, but its reply is gone (see the next point). So the
  store coming back never sends a command someone asked for minutes ago.
- **Protection doesn't wait.** Everything else in GA-PERSIST-1 is written behind: a safety rule
  firing, a latch, a load shed, heating on-times, assumed states, ack deadlines, the last
  `basis_time` per safety-read key, the bridges' last `connections`, unacknowledged notices,
  incomplete safety rules, and the events. Their steps act at once, and their write sets follow in
  order.
- **A caller that waits too long** for a commit-gated reply gets the error above after 10 s. The
  error's message and its `data` say which of two fates the request has, so the owner's app can
  word it. A request whose write set is in the writer gets "not applied yet: it takes effect when
  the store returns, unless the applier restarts first" (`data: { pending: true }`). An owner change
  still waiting its turn (*One owner change at a time*) gets "not applied, and never will be"
  (`data: { pending: false }`). A pending write set commits when the store returns. An `apply`
  retried with its idempotency key then finds its outcome, which is the dropped dispatch's outcome
  if it came too late. A `configure` shows up as the next `revision` in `describe`.
- **Reads during an outage.** `describe` and `state` are answered from memory. So is `events`: an
  event not yet committed is served from memory, in `seq` order, after the committed ones, so the
  steward hears of a fired safety rule, or of a store fault, while the store can't serve it.
  `history` is read from the store, so it fails with the error until the store returns. The
  steward retries it as it would any failed call. Its `events` cursor stays valid, because the
  events written behind keep their `seq` order.
- **The writer's queue has a cap.** It is the one the applier's design sets for its writer, with a
  notice when it is reached. It holds during a store fault just as during an outage, since either
  can last until the owner comes home.

### A store fault

A write set that fails on the statement's own error (a constraint violation, a bug: a
`DatabaseError`, not a lost connection) is a **store fault**. Retrying can't fix it, and skipping
it would leave the store and memory disagreeing.

- **The writer stops, not the applier.** The writer commits nothing more. It keeps that write set
  and every one behind it, in order, and never skips or reorders them. The applier runs on from
  memory exactly as during an outage: safety rules, latches, load caps, re-sends and notices act,
  and every effect that waits for its commit gets the error after 10 s and follows the 10 s drop.
  The applier does not exit on a store fault. Exiting would lose the queue behind the fault
  (latches, notices, incomplete safety rules), and a fault that recurs would loop with no
  protection (HS4, HS8, HS14, VS2, VS8 and VS9 in the review).
- **The fault is loud.** The applier issues a notice of a cause of its own, `store_fault`, served
  from memory through `events`, so the steward delivers it on the home's channels (GA-NOTE-1). The
  applier's healthcheck fails, so the owner tool shows the applier broken, as it shows a broken
  store; the store itself is healthy and would show nothing. The log names the statement, the
  error and the kind of write set.
- **The owner recovers it.** The fault holds until the owner acts: a fixed build, a migration or a
  restart. A restart loses the held queue, the cost *A restart during an outage* reached with a
  healthy store. Before one, the owner tool says how many write sets are held and which latches,
  notices and incomplete safety rules they carry. A fault that recurs after a restart stops the
  writer again, the same way.
- **Tested.** A unit test injects a statement error into a latch's write set. It then checks that
  a later leak still closes the valve, that the latch still refuses (`refuse(latched)`), that a
  heating load's cap still fires, and that the `store_fault` notice is in `events`.

### A late owner change

A `configure` or adoption change that timed out still takes effect when its write set commits. It
is the owner's durable change, and withdrawing it would undo, for example, HS17's replacement or a
revoked credential. What keeps a late landing honest:

- **A pending owner change is visible.** Until it commits, the owner tool shows it, with its time
  and its diff, from the applier's own status. `describe` shows only what memory holds.
- **A late change says when it lands.** When an owner change commits more than 10 s after it was
  made, the applier issues a notice of a cause of its own naming the change, when it was made and
  when it took effect. The `model` event and the new `revision` follow as for any change.
- **`clear_latch` binds to its latch.** When a `clear_latch` is validated, the applier records in
  its write set which latch it was checked against: the `seq` of the `latch` event that set it. The
  wire doesn't change. When the change reaches memory, it clears that latch only if that same latch
  is still held and can't clear by itself (a sensor it reads is not `live`). Otherwise it changes
  nothing, and the landing notice says why: the latch had cleared, or its sensors now report. A
  late `clear_latch` could otherwise lift a latch set after the owner looked, over a leak.
- **Nothing a person confirmed acts late.** A dispatch already follows the 10 s drop. So does
  `provision`: a `join`, `commission`, `connect`, `install` or `remove` whose commit comes more than
  10 s after its step is dropped, never run late. A join window opening hours later, with nobody
  at the box, would admit whatever is pairing nearby.

The two notice causes are the reference applier's own. The standard shows a cause it doesn't list
as a notice (*Notices*), so no standard changes for them. Whether they join the standard's list is
for its next review.
- **The accepted costs.** Two follow from one store. The maintainer accepted both on 2026-09-29,
  rather than give the applier a local journal. The owner tool reports a broken store loudly.
  - *A restart during an outage.* The applier can't start without its store, since its
    configuration is there. A restart while the store is down loses the write sets still queued.
    The protective action has already happened (the valve is shut), but the latch that should keep
    it shut is lost. A later plan could then reopen the valve without the owner's acknowledgement.
  - *No protection without the store.* After any applier restart or a cold boot, no safety rule
    runs until the store is reachable. Compose starts the applier only once Postgres is healthy
    (`depends_on: condition: service_healthy`), so on a sound box this is seconds. With a broken
    store (a full disk, a failed upgrade), the home has no applier and no protection until the
    owner repairs it, and the owner tool says so. Devices' own fail-safes are outside Galatea.

  Writing the queue to a local file, or keeping a local copy of the configuration, would close
  both, and would be a second store, which the ruling rejects.

## Audio

GA-VOICE-15 says a front must not send audio it captured, or a model enrolled on a person's voice,
"off the home's box". Relaxed (the maintainer, 2026-09-28): off the home's local network. A clip
may be kept on a NAS or another machine of the home; it may never reach the cloud. Transcripts
still reach the brain, wherever the owner runs it.

- **The bytes are files, never rows.** Audio in a database bloats its WAL and its dumps, and turns
  every backup into an audio archive, which works against the rule's purpose. The front writes
  each kept clip as a file under `audio_dir/<id>/`, its own subdirectory (`audio_dir` is its configuration: a directory on the box, or a NAS
  mount on the LAN) and keeps a row in its schema's `audio` table (`voice_<id>.audio`) with the path, a hash, the utterance and the
  time it expires. A sweep deletes the file, then the row, when either the retention or a
  person's removal says so.
- **Enrolled voice models**, if a front ever has them, are files in the same directory, under the
  same rules.
- **Backups leave audio out.** The dump holds only the rows. A front that finds a row whose file
  is gone treats the clip as already expired.
- **The standard changes.** GA-VOICE-15's text and its heading ("Audio stays on the box") become
  "the home's local network". The voice architecture design's bullet *Audio and voice models stay
  on the box* follows. The conformance text, which judges the rule by inspecting the front's
  storage after a run, names `audio_dir` and the `voice_<id>.audio` rows as that storage. The
  change goes through a review like any other, and voice becomes 0.4 only on PASS.

## Access from other boxes

Postgres listens on the home's LAN only when the owner opens it. By default the Compose file
publishes no port, and the builds reach it on the stack's own network.

When opened, `pg_hba.conf` accepts other hosts only over TLS (`hostssl`) with `scram-sha-256`, and
only for the roles the owner lists. A build on a second box, such as a voice front in another room,
connects as its own role like any other. The `reader` role serves analytics and read-only tools.
The TLS certificate comes from the installation's own certificate authority, the one that issues
the MCP seams' certificates. GA-SEC-1 asks for TLS on those seams; it doesn't define the authority.

## Backups

The pain this design exists to prevent was a backup that had to be remembered. So backups are part
of the stack from its first release, not a guide.

- **A `backup` service** runs `pg_dump --format=custom` of `galatea` every night into a backup
  directory, which can be a NAS mount. It keeps the last 14 dumps and deletes older ones.
- **Every dump is checked.** The service restores it into a throwaway database on the same server,
  runs one query per schema (each schema's `migrations` table is non-empty when it exists; `db-init`'s fresh schemas have none), drops the throwaway
  database, and writes the result beside the dump. A failed check is reported as the service being
  unhealthy, which the owner tool shows.
- **Restore is one command**, shipped in the owner tool as `galatea restore <dump>`. It stops the
  builds, drops `galatea`, runs `pg_restore --create` from the dump, runs `db-init` (which finds
  everything present), and starts the builds again. Roles are server-wide, so they survive the
  drop; the dump brings back the schemas and their grants.
- **Major upgrades are a dump and a restore** into the new major, scripted the same way. At a
  home's data size, a few GB at most, that takes minutes and needs no `pg_upgrade`.

## Tests

- **TypeScript builds: PGlite in the unit tests.** It is Postgres compiled to WASM, in process, with
  no Docker, and every test gets a fresh database. Its single connection is not a limit here,
  because each build is its own schema's only writer. PGlite 0.5.8 is Postgres 18.3, the
  production major (measured by the reference applier's work with `select version()`). Its only
  user is `postgres`, so it tests neither the build's role nor its privileges. That, and the
  `reader` role, which PGlite doesn't have, are for the real-Postgres job below.
- **The voice front: a real Postgres.** `reference/voice-front/tools/with-postgres.sh` starts a throwaway
  `postgres:18-alpine` on loopback and names it in `VOICE_FRONT_TEST_DATABASE_URL`, an admin URL.
  Each test gets a fresh database, as the harness's `database: true` does. Local Postgres
  binaries for `pytest-postgresql` were not on the machine the plan was spiked on, and Docker is
  already needed. The tests that need it are marked `pg`, so the pure cores still run anywhere;
  a missing server fails those tests rather than skipping them.
- **The harness.** A subject that keeps state today asks for `state_dir` and gets
  `GALATEA_STATE_DIR`. A subject on Postgres asks for `database: true` and gets
  `GALATEA_DATABASE_URL`. The harness is given a server by `GALATEA_HARNESS_DATABASE_URL`, an admin
  URL. For each test it creates a fresh database, hands the subject a URL to it with the same
  admin login, keeps it across the subject's restarts within the test, and drops it at the test's
  end. It is the same contract as `state_dir`, for a database. No role is made, so no role can
  collide between parallel tests; the build creates its schema there itself (*Inside a build*).
  Without `GALATEA_HARNESS_DATABASE_URL`, such a subject is a harness fault with a message, never a
  skip. [`conformance/harness/scripts/with-postgres.mjs`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/scripts/with-postgres.mjs) runs a command with that URL set, starting
  a throwaway `postgres:18-alpine` on loopback when none is named. The reference applier's slice 1
  plan builds all of this. The harness's own simulators keep their state as they do now.
- **One job per build runs against the real Compose Postgres 18**, to catch what PGlite or a
  local server would hide: the image, the roles, the privileges, the backup and its check.

## What changes elsewhere

| Where | Change |
|---|---|
| [`standard/voice.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/voice.md) GA-VOICE-15 | "off the home's box" becomes "off the home's local network". Reviewed; voice 0.4 on PASS |
| [`docs/specs/2026-09-25-voice-architecture-design.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/docs/specs/2026-09-25-voice-architecture-design.md) | The bullet *Audio and voice models stay on the box* follows |
| `docs/specs/2026-09-27-voice-front-design.md` | `store.py`'s row: Postgres (schema `voice_<id>`), audio as files under `audio_dir` |
| The voice front's stage 2b plan | Done (revised 2026-09-29): Task 3's store moves to Postgres with psycopg 3; `[store]` takes `url`, `password_file`, `audio_dir` and `keep_s` |
| The reference applier design and slice 1 | Done (PR #6). Steps are synchronous and one writer commits in order from slice 1, as *The applier, safety first* says; `events` is served from memory, a store fault exits, and every statement is bounded to 5 s. The writer's backlog cap comes with slice 2 |
| The roadmap's installation | Postgres and the backup service join the Compose stack |
| [`conformance/README.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/README.md) and the subject schema | `database: true` and `GALATEA_DATABASE_URL` |

## How the work splits

This is several plans, not one. Each can be reviewed and run on its own, in this order:

1. **The installation's store.** The Postgres service, `db-init`, the backup service with its
   check, `galatea restore`, and the major-upgrade script, with their tests against the real
   image. It depends on nothing else here.
2. **The harness's `database: true`.** The subject contract, its schema, the harness code, and the
   harness's own tests. Built by the reference applier's slice 1 plan (`feat/reference-applier`),
   its first user.
3. **Each build's store, in that build's own plan.** The voice front's stage 2b revision (this
   worktree) and the reference applier's slice 1 revision (its own branch). Each follows 1's
   conventions and can start at once, since its unit tests need only PGlite or a local server.
   Its harness runs need 2.
4. **The GA-VOICE-15 change.** A standards review, on its own timetable, before voice 0.4.

## The applier's notes

The reference applier's session read this design and left notes. All are taken in
above: PGlite's version and the harness contract as that branch built it; events served from
memory and the writer's cap (*The applier, safety first*); and the two rulings (*A store fault*,
*A late owner change*). The applier's design on its branch says a store fault makes the applier
report and exit; that line changes there to *A store fault*, before slice 6.

Not taken up, from the scenario review's gaps: a way for the owner to withdraw a pending change (no
scenario asks for one), and whether the steward should queue owner work during its own outage as
the applier does. No reference scenario grades a failure of the box's own store yet. The review
suggests one.

## Not in this design

- An analytics tool. `reader` and the history views make one possible; none is built.
- Point-in-time recovery (WAL-G, pgBackRest). A nightly dump is the home's recovery point. A later
  design can add continuous archiving if an owner needs it.
- Replication or a second Postgres. A home has one box that runs the stack.
- The brain's memory. The brain is upstream, and our reference brain decides for itself.
