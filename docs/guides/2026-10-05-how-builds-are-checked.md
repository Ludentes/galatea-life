---
title: How the reference builds are checked
status: current
last_verified:
area: conformance
audience: dev
author: Galatea maintainers
related:
  - conformance/README.md
  - reference/applier/scripts/full-matrix.mjs
---

# How the reference builds are checked

What a change to a reference build (the applier, the steward, the bridges, the install) has to
pass, when, and why. The rule is the maintainer's. A pull request proves the build is right: one
clean conformance run, and only the mutations its change touches. The schedule proves the tests are
strong: the whole matrix every night, `--full` every week (2026-10-06). The install's Docker tests
run rarely (2026-10-05). It is **on probation**:
we try it, and change it if it lets a defect through that the dropped runs would have caught.

## Changelog

| Date | Change |
|---|---|
| 2026-10-07 | The steward's driver runs `--changed <base>`, the applier's shape over the same scope code. |
| 2026-10-07 | `--changed`'s preflight: the shared set closed over its imports, the build's grading inputs shared, and what it leaves to the nightly. |
| 2026-10-06 | `--changed <base>` in the applier's driver: the scope is the harness's, with the shared harness as one list (`SHARED_HARNESS`) and each id's check file from the registry. |
| 2026-10-06 | The steward opts in: its matrix skips by reach (`--reach`, `--full`), its lint passes, and it declares `database.migrate`. |
| 2026-10-06 | Lighter pull requests (the maintainer, on the steward and applier sessions' joint proposal). A pull request runs one clean conformance run and a matrix scoped to its change (`--changed <base>`). The whole matrix runs nightly on a spare box, and `--full` weekly and before a release. A stack of pull requests gets its full gate once, on the top. Review fixes are fixup commits, and plans are not regenerated or replayed after them. |
| 2026-10-06 | Skipping by reach (the maintainer): the applier's matrix runs each mutation only on the checks that reach its code, plus its rows' ids; `--full` runs every check, weekly and before every release. |
| 2026-10-06 | The harness's template database: a subject that declares `database.migrate` (the applier does) is migrated once per run, and each check's database is cloned from the template; both matrix drivers share Node's compile cache across their runs. |
| 2026-10-06 | Profiles: every heavy run writes where its CPU and memory went; the matrix prints its timing. |
| 2026-10-06 | Two heavy runs at a time (the maintainer): `heavy.sh` holds one of two lock slots, each run capped at 20 GB; the queue, not memory, had become the bottleneck. |
| 2026-10-05 | Memory: heavy runs one at a time under a 24 GB cap (`heavy.sh`), four test workers per PGlite package, each test's databases closed after it, `test:fast` two packages at a time. |
| 2026-10-05 | First version, with the test-speed work: the PGlite template, the harness's clock steps, the matrix's own checks, the install's Docker tests run only when the install changes. |

## The checks, cheapest first

| Check | Command | Time (12 cores, idle) | What it proves |
|---|---|---|---|
| Build | `pnpm install --frozen-lockfile && pnpm -r build` | about 1 min | it compiles, the lockfile holds |
| Unit tests, without the install | `pnpm test:fast` (builds first) | about 1.5–3 min | each package's own behaviour |
| The install's tests | `pnpm test:install` | about 2 min, real Docker | the installation's scripts, Compose file, backups, restore |
| Walking skeleton | `pnpm skeleton` | under 1 min | the schemas, the manifests, the harness's own core |
| Manifests | `python3 conformance/check_manifest.py` and `python3 -m unittest discover conformance` | seconds | each standard's manifest matches its text |
| Scoped harness run | the harness's `run --ids <ids>` on the subject (see the build's `helpers`) | seconds per id | the touched requirements, against the real subject |
| A mutation's scoped run | the same, on a negative subject | seconds | that mutation fails exactly its row's ids |
| Clean conformance | `pnpm --filter <build> conformance:matrix --only clean` | about 1.5–2 min | every graded id on the clean build: the build is right |
| The scoped matrix | the same with `--changed origin/main` | 0 for most pull requests; a matrix's worth for one that adds mutations or changes the shared harness | the mutations the change touches, each on the checks in its reach and its rows' ids; see *What runs when* |
| The matrix | `pnpm --filter @ludentes/galatea-life-applier conformance:matrix` | about 20 min at 3 jobs, with load (modelled) | every graded id on the clean build; each mutation on the checks in its reach and its rows' ids; nightly; see below |
| The full matrix | the same with `--full` | about 40 min at 3 jobs, with load | every graded id on the clean build and on every mutation; weekly and before every release |

## What runs when

**While working (a spike, a fix, a review's probe):** build, `pnpm test:fast` (or only the packages
the change touches: `pnpm -r --filter "...[origin/main]" test`), the scoped harness runs for the ids
the change touches, and each new or changed mutation's scoped run. Not the full conformance run,
not the matrix, not the install's tests. A lone timeout while other sessions load the machine is
load, unless it repeats with the file run alone.

**Once per pull request, on the final head after merging main:**
- the build;
- the tests of the packages the branch changes and of their dependents (`pnpm -r --filter "...[origin/main]" test`);
- `pnpm skeleton` and the manifests;
- **one clean conformance run** over every graded id;
- **the matrix scoped to the change** (`--changed origin/main`), each mutation still skipping by reach. The mutations in scope are:
  - those with a site in a changed file;
  - those whose rows' ids (broken or coupled) have a changed check file;
  - those whose `subject.json` or `proposed-rows.json` entry changed, and every new mutation;
  - **every mutation**, if the branch changes the shared harness: [`conformance/harness/src/home.ts`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/src/home.ts) and the harness's fixture and run code, [`conformance/sim/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/sim), the broker or proxy setup, the time server, or the reach code ([`conformance/harness/src/reach.ts`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/src/reach.ts), [`conformance/harness/scripts/reach.mjs`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/harness/scripts/reach.mjs)). Example: two setup fixes in the reference applier's slice 5b (a transport wait in `startOnSeam` and TCP nodelay) touched no site, case or row. Yet they moved a retained status relative to the SUBACK for every applier check.

  The matrix prints each mutation in scope with its reason. A branch that touches none of these runs no mutation.

The clean run is the evidence that the build is right; the matrix is the evidence that the suite is strong. Until `--changed` exists in a build's driver, that build's pull requests run the matrix by reach.

`--changed` exists in the applier's and the steward's drivers: `pnpm --filter @ludentes/galatea-life-applier conformance:matrix --changed origin/main`, and the same with `galatea-life-steward`. The scope is the harness's (`@ludentes/galatea-life-harness/changed` and `/scripts/changed.mjs`), which keeps the shared harness as one list: a common part, `SHARED_HARNESS`, and each build's own, `SHARED_BY_STANDARD` (the steward's `steward-home.ts`). Besides the guide's list, the common part holds the maintainer's additions of 2026-10-07: the harness's `subject.ts`, `database.ts`, `seams/`, `ports.ts` and `util.ts`, the test clock, the scope code itself (`changed.ts`, `scripts/changed.mjs`, `registry.ts`), the build's `src/mutations.ts` and `pnpm-lock.yaml`. The shared files are closed over what they import in the harness, and the preflight's fixes (2026-10-07) add the schemas, the build's `graded-ids.json`, verdict and driver, and `subject.json`'s fields other than its mutations; `src/mutations.ts` counts only outside its `MUTATIONS` list. It maps each graded id to its check file through the registry, and a module of the harness to the check files that import it. A site file counts at the base or now, so a site removed counts. A changed manifest row or `known-outside.json` entry puts its mutation in scope too.

What `--changed` leaves to the nightly, by design (the maintainer's rulings on the preflight, 2026-10-07):
the subject's code outside the mutations' sites (`main.ts`, the store and the rest a change may touch
without touching a site), the code a site hands its decision to in another file (a callee given the
comparison as an argument; a backlog item asks for a lint rule), and a check in a mutation's reach
but not among its rows' ids. A change to any of these runs no mutation for it; the nightly matrix by
reach over every mutation catches what it moves within a day. With `--head` other than HEAD (the
helper's command only), the build's files and sources are read from that head, but the registry's
check files, the harness's imports and the shared packages' places are this checkout's;
`--uncommitted` is refused with it. Without `--uncommitted`, a working tree with changes is warned of. It combines with `--only` and is refused with `--full`; `--uncommitted` adds the working tree's changes. When it cannot scope (a base git cannot diff, a mutation with no site in the sources, a reach that does not hold the sources' sites), every mutation runs, by reach, and the matrix says why. A pass reads "scoped to the change against origin/main: N of M mutations". To see a change's scope without running anything, run the harness's `scripts/changed.mjs --build <build> --base origin/main`.

**A stack of pull requests** (a milestone's slices) gets the full gate once, on the top of the stack after merging main. The lower pull requests get the build, their packages' tests and the scoped ids; the top's tree contains theirs.

**Nightly and weekly, on a spare box:**
- the matrix by reach over every mutation, each night;
- `--full` each week and before every release.

The spare boxes can't reach the repository. A timer on the desktop, which needs no open session, bundles `origin/main`, ships it and starts the run. A morning step copies the results back and writes one line per failure into the maintainers' backlog. Each build's owning session sets up its timer and triages its own failures.

A nightly failure blocks the next release, not the next pull request. A red `--full` before a release blocks the release. Heavy runs on a spare box take that box's own lock, `flock ~/galatea-runner/.heavy.lock`, one at a time, under a memory cap.

**What this gives up, measured:** in the week of 2026-10-06, the per-pull-request matrices found:
- on the applier: two harness races (GA-APPLY-15, GA-APPLY-16), two couplings, and one mutant going uncaught (GA-BUS-8, a broker-order race);
- on the steward: five harness races and one coupling.

None was a defect in a reference build. Under this rule they surface within a day instead of before merge.

**The install's Docker tests** run only in a pull request that changes `reference/install/`, and
once at each revision of a standard, as a drift check: the `postgres:18-alpine` image can change
under an install that did not.

**Review:** one preflight review per pull request, of the spike, before fixes. Fixes get the
author's own red-then-green on the reviewer's probes, and the controller runs the probes again on
the ported tree; no second full review. A fix lands as a fixup commit in the task that introduced the code, with its regression test. The pull request's *Review* section lists each finding, its fix and its test, and the plan gets one paragraph naming the review. **A plan is generated from commits once,** when the slice is first written. It is not regenerated or replayed after review fixes, and "replays exactly" is not a gate. The merged code and the review section are the truth.

## The matrix

`reference/applier/scripts/full-matrix.mjs` runs the harness over every graded id once on the clean
build and once per mutation (a negative subject built to break one row of the standard's *Negative
subjects*), 3 at a time by default (`--jobs`, `--only <m,m>`). At 6 jobs it took 651–1087 s, but under other sessions' load GA-APPLY-1's 500 ms bound and GA-STATE-2's 1 s were missed; those are the standard's bounds, so the default stays 3 (*The backlog* has the question). It fails when:
- the clean build fails a graded id;
- a mutation fails an id outside its row that `known-outside.json` does not list (a coupling the
  row does not name, listed with its reason, or a defect);
- a mutation is **not caught**: it still passes a graded id its row breaks, or its failure there
  came from setup, start or exit rather than the test's body;
- a mutation breaks no graded id, so the matrix cannot show it caught.

The last two checks used to be only in `pnpm conformance`'s negatives phase; they moved into the
matrix (2026-10-05) so that one matrix can stand in for the conformance runs.

## Skipping by reach

The matrix skips by reach unless it is given `--full` (the maintainer, 2026-10-06). It changes which ids a
mutation's run grades, never what a run's verdict means.

- **What runs.** The clean run comes first, alone, and runs every graded id with V8 coverage of each
  check's subject. Without `--full`, `--only` adds the clean run whatever it lists. A clean build that
  fails an id stops the matrix before any mutation runs. The coverage is added to the stored reach
  (`~/.cache/galatea-reach`, unless `--reach <store>` names another), and then deleted. The store
  carries every (mutation, id) pair any earlier clean run reached, across builds, for the mutations
  still declared; a `--full` run resets it to its own clean run. Each mutation then runs:
  - the ids in its reach: the checks whose clean run, this one or one the store carries, evaluated one
    of its sites;
  - every id its rows break and every coupled id (`subject.json`, `proposed-rows.json`), reached or
    not;
  - any id no covered clean run measured.
- **What is skipped.** A mutation's other ids are skipped. Their rows are marked `skipped`, never
  `pass`, and the verdict grades a mutation only on the ids it ran. An id its rows break is graded
  either way, so the matrix is never weaker than the rows. A known coupling (`known-outside.json`)
  outside the reach is not run, so it excuses nothing; the matrix prints a warning for it.
- **Why it is sound, and its known gap.** The build reads its mutation only through its sites: direct
  comparisons with the mutation's name (the steward), or reads of the mutation's flag in a frozen
  record built once from it (the applier's `mutant.trustsAnyToken`, the flag being the name in camel
  case). The lint below keeps it so. A check whose clean
  run evaluated none of a mutation's sites therefore runs the same code under the mutation, unless
  timing takes it down another branch. Reach is a sample: a branch that only some timing takes is
  reached in some clean runs and not others (`acks-without-state` reached GA-APPLY-9 in one of two
  measured runs). Carrying pairs across builds narrows that gap. It does not close it: a timing-only
  reach that no clean run has taken yet is skipped. That is a **known gap, which the weekly `--full`
  closes**.
- **What the history showed.** On the applier, every id a mutation breaks and every known coupling is
  in reach. The archived matrices hold 34 pairs of a mutation and an id it failed outside its reach
  (measured when skipping by reach was planned):
  - in 23, the same id failed under other runs of the same matrix: the load, or the build of the
    moment;
  - the other 11 were failures their spikes recorded as timing at the time.
- **A failure `--full` shows outside reach is real.** It is a defect, a coupling, or a gap in the
  reach, and it is studied like any matrix failure, never dismissed as timing.
- **The guards.**
  - A check that lost a subject instance to a signal (a SIGKILL), or whose coverage files are fewer
    than its instances that ended themselves, is in every mutation's reach: its coverage is
    incomplete. The run finds such checks; nobody lists them. A restart on SIGTERM writes both
    instances' coverage and is measured like any check.
  - A mutation with a site in start-up wiring (`main.ts`, a module's top level, a constructor or a
    field initialiser) reaches every check.
  - The lint (`test/mutation-sites.test.ts`, and again before every skip) is an allowlist. A build
    may read its mutation only:
    - by a direct comparison with a mutation's name;
    - by copying it whole into a field or an alias;
    - by passing it whole to its own functions and classes.

    A build that reads a record of flags (`mutant`) holds it to the same list: it reads a flag only as
    `mutant.<flag>`, copies the record whole (into a field or an alias named `mutant`), builds it by
    its own call (`mutantOf`, which alone compares the mutation with every name and is left out of the
    lint, as `mutationFromEnv` is), or passes it whole. A flag's name anywhere else, an index, a
    destructuring or a truth test of the record fails the lint.
    It may read `GALATEA_MUTATION` only in `mutationFromEnv`. Every mutation must have a site. Any
    other read fails the lint, and the matrix then refuses to skip; so does a clean run with no report.
- **What it says.** The matrix prints:
  - its mode;
  - each mutation's ids run (`ran 17 of 91`);
  - the checks run and skipped, in its timing summary;
  - warnings for an unreadable store, and for own-row or known-coupling ids outside reach.

  The reach's own report, `reach.md`, is beside the reports.
- **`--full`** runs every graded id under every mutation, as before. It runs **weekly and before
  every release**, so a reach that is wrong shows up within a week. With `--reach` it records its
  clean run's reach, resetting the store.

The steward's matrix skips by reach too, with the same `--reach` and `--full` (`reference/steward/scripts/full-matrix.mjs`), and its lint (`reference/steward/test/mutation-sites.test.ts`) passes. It runs `--changed <base>` too, with the harness's scope and the steward's own shared file (`steward-home.ts`, in `SHARED_BY_STANDARD`). Its reach is stored beside the applier's, in the store's `steward.json`.

## Why the tests are fast now

- **PGlite from a template.** A fresh PGlite took about 1.0 s to start. Each package's `test/db.ts`
  now loads each test's database from a template migrated once per run in a vitest global setup
  (about 0.22 s); every test still gets its own database, and `template.test.ts` checks the template
  equals a blank database plus the migrations. The test step fell from 465 s to 196–260 s, and `pnpm test:fast` runs in about 92 s on a quiet machine.
- **The harness's template database.** A subject that declares a migrate-only command in
  `subject.json` (`database.migrate`; the applier and the steward do) has it run once per harness run into a template database, and each check's database is cloned
  from it, with its own role and schema as before, so the subject's migration at start finds nothing
  to do. Phase 1 of the harness's subject-lifecycle design.
- **Node's compile cache in the matrix.** Both matrix drivers set `NODE_COMPILE_CACHE` to one
  directory per matrix, which every run's harness and subjects share.
- **The harness's clock, not real time.** Tests that waited through hours or seconds now step the
  harness's clock (GA-EVT-5 27 s to 5.5 s, GA-BUS-4 15 s to 5.3 s). GA-BUS-7 still takes 15 s:
  it waits for the applier's real MQTT keepalive, which no harness clock reaches.
- **Races fixed under load:** GA-APPLY-1's lamps no longer answer during its apply; the simulated
  bridge keeps a transport a test adds in every later status (GA-DESC-5); a subject's port is drawn below the kernel's ephemeral range and retried up to 5 times, so an outgoing connection cannot take it.
- Measured and **not** done: one database per worker (10–20 s more, at the risk of state leaking
  between tests); mocking the store (it would hide the defects those tests exist for); one subject
  process across harness tests (results would depend on test order).

## Memory

Two out-of-memory kills of the desktop on 2026-10-05 came from test runs: every test opened a PGlite
of about 260 MB and never closed it, so one worker grew with its file (the applier's
`dispatch.test.ts` reached 18.4 GB alone), and vitest started a worker per core in every package at
once, in several sessions at a time. Three things keep it bounded now:
- **Each test's databases are closed after it** (`closeOpened` in the build's `test/db.ts`, run by
  `test/close-dbs.ts`), waiting up to half a second for a write set still committing; one still in a
  transaction after that is left, since closing under it hangs the worker. `dispatch.test.ts` now
  peaks at 1.5 GB.
- **At most four workers** in each package that uses PGlite (`maxWorkers` in its `vitest.config.ts`),
  and `pnpm test:fast` runs two packages at a time.
- **At most two heavy runs at a time on the machine.** Every gate, matrix, conformance run and whole
  test suite goes through `heavy.sh <command>` (a wrapper in the workshop the builds are developed
in, as are the profiling scripts below; neither is in this repository), which waits for one of two machine-wide lock
  slots and runs the command in a systemd scope capped at 20 GB with no swap (two runs take at most
  40 of 62 GB), so an overrun ends that run and not the desktop. Slot 1 is the original lock file, so
  an older one-slot copy of the script still counts against it. `GALATEA_HEAVY_LOCK=<file>` gives the
  strict form back: one run at a time on that file, under 24 GB. Two runs share the CPU, so a matrix
  running beside another heavy run is slower and its timing checks see more load. Scoped harness ids
  and one test file may run outside it.

A new build that uses PGlite in its tests copies the three: the registry and `closeOpened` in its
`test/db.ts`, the setup file, and the worker cap.

## Profiles

Every heavy run explains its own time, so a slow gate needs no separate profiling run. Once
`heavy.sh` holds a slot, `profile-sample.mjs` samples the whole machine's `/proc` every
second while the command runs. When the command ends it prints five lines and the directory it
wrote: `$GALATEA_PROFILE_DIR` if set, else
`~/.cache/galatea-profiles/<UTC time>-<first word of the command>/`. There:
- `profile.md` (and `profile.json`): CPU seconds, share and peak memory by kind of process (Postgres,
  the applier or steward under test, the harness, the matrix driver, vitest, the broker, Docker,
  tsc, other node, other; the rules are `RULES` in `profile-lib.mjs`), the load, the busy cores,
  and a timeline every 10 s with the busiest kinds. It names the slot the run held and how much of the
  time the other slot's run was active (read from `/proc/locks`), since two runs share the CPU.
  A kind marked `outside:` is processes the run did not start: the other slot's run, another
  session's tests outside the lock, the desktop, and containers other than the run's own Postgres
  (`with-postgres.mjs` registers it); that is load the run competed with, not its own cost. Shares
  are of the run's own CPU. *Unattributed* CPU is that of processes that lived less than a second,
  which a 1 s sample cannot see, and the kernel's.
- `postgres.md` (and `postgres.json`), when the run used `with-postgres.mjs`'s throwaway server: the
  statements by kind (`CREATE DATABASE`, `DROP DATABASE`, roles, migrations, the subjects' and the
  harness's queries) and the 30 slowest by total execution time, folded across every check's own
  database; database, WAL, checkpoint and I/O totals; and the container's CPU from its cgroup, which
  counts Postgres even where the process names miss it. Execution time is the server's own; the
  harness's wait for each database is in each run's `run.json` (`database`).
- A matrix also prints, after its reports' path, the total wall, the runs' wall, each job lane's runs
  and its time making and dropping databases, the 15 slowest ids by mean time, and the profile so far.

`GALATEA_PROFILE=0 heavy.sh …` turns the sampler off; the Postgres view is written only when
`GALATEA_PROFILE_DIR` is set. The sampler costs about one percent of one core (measured 2026-10-06).

## What the probation watches

- A defect found only by the matrix that a scoped run during the work should have caught.
- A defect found after merge that the dropped conformance runs or install tests would have caught.
- Flakes that the single matrix run turns into a wrong verdict.
- A defect the nightly matrix found that a per-pull-request matrix would have caught before merge.

Any of these goes to the maintainer, and the rule is revisited.
