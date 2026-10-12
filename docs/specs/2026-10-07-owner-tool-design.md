---
title: The owner tool — a command line for the owner's own endpoint
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/plans/roadmap.md
  - docs/specs/2026-10-07-install-core-design.md (on branch docs/install-core-design until it merges)
  - docs/specs/2026-10-02-reference-steward-design.md
  - docs/specs/2026-09-28-reference-applier-design.md
  - standard/steward.md
  - standard/applier.md
---

# The owner tool — a command line for the owner's own endpoint

## Changelog

| Date | Change |
|---|---|
| 2026-10-07 | First draft, for the maintainer's review before any plan |
| 2026-10-07 | Plan C, from its spike: `do`'s `--arg` forms and its printed plan, `events --cursor`, `history`'s times and cap, `answer` applying a plan with its declined steps skipped (the plan's *Rulings*) |
| 2026-10-07 | Aligned with the installation's design, revision 3: the CA from `tls/ca.pem`; `127.0.0.1`, not `localhost`; the steward registered by the installation's script, not the tool; copies to another machine only to an owner's account with no unattended agents |
| 2026-10-07 | Spec review round 2 (1 issue): `galatea credential`'s flags as the steward takes them; the wait before the first channel's `define` |
| 2026-10-07 | Spec review round 1 (8 issues, 10 advisories): waits on the steward's `describe`; transports, not bridges; `--name` and `--room` optional and the order on steward 0.10; `answer` applies the tool's own plans; `asks` no longer claims who asked; `register bridge --identity`; `galatea credential`; the simulated bridge's join as it is |
| 2026-10-11 | Steward 0.11: the first notice channel in any order, `no_notify_channel` and held notices shown; `asks` reads the event's `steps` and says a step it cannot show; `answer` reads the bound `answer`; `credential` defined whole under the merge (GA-DEF-14) |
| 2026-10-12 | `galatea scenario` (the maintainer's ruling: scenarios must not be testable only through a brain): `list`, `run`, `status`, `stop` (*Scenarios*); `answer` starts a scenario's plan instead of applying it; the requests the tool sends checked against the steward's request schemas |
| 2026-10-12 | From the code review: `scenario status` is a read, 0 whenever it worked (the maintainer's ruling); a re-ask is the run's by its plan, named or not, and a spent plan refused after an answer is the run's answer; Ctrl-C after a run ended said, 1; the declined line names only this answer's steps |

## What this is for

The roadmap's first release needs an owner's endpoint: adoption, `configure`, `define`, answering a
`confirm` or a `no_voice` ask, and reading notices all need one. The maintainer's order (2026-10-06): the owner tool, guided pairing first, then the
installation and first light. This design is the tool: a command line, `galatea`, that the owner runs
on the box (or on another machine with a copy of three files) to work with the home.

Classified **architectural**: no owner client exists in the repository; this adds a package and the
owner's way into both servers. The research it rests on was read from `main` at `94fdf6fb` and kept
outside the repository with the session's other records; what bears on the design is restated here.

## Rulings it rests on

- **Commands only** (the maintainer, 2026-10-07): every operation is one command with flags, no
  prompts. Pairing several devices is several commands. Scripts and tests drive the same commands the
  owner types.
- **Two servers, two credentials.** The standards give pairing to the applier and naming to the
  steward: the applier's owner configuration credential reaches `describe`, `events`, `configure` and
  `provision` (GA-CFG-1, GA-PROV-1); the steward's app credential, bound to endpoint `owner-app`,
  reaches `describe`, `define`, `plan`, `answer`, `apply`, `outcome`, `events` and `history` (*Clients,
  endpoints and principals*). "Only the owner adopts, through the applier's `configure`" (GA-DEF-9).
  The tool holds both credentials; nothing in the standards changes.
- **The first notice channel** (the maintainer, 2026-10-07): steward 0.11 accepts a change set while
  `notice_channels` is empty and refuses only one that leaves a set list without a channel (GA-DEF-8).
  The tool needs no command of its own for it: `galatea define` sets `notice_channels`, in any order
  with adopting and naming. While the house has no `notify` channel the steward holds every notice
  (GA-NOTE-1): a `define`'s answer carries `no_notify_channel: true`, which the tool says under the
  answer (`define`, `credential`, `adopt`'s naming line), and `describe` counts the notices held,
  which `galatea status` shows.
- **An ask carries what it asks** (the maintainer, 2026-10-07): in steward 0.11 the `ask` event names
  each asked step's target, action, args, tier and reason (a define's step its diff), for a read at the
  ask's endpoint (GA-CONF-5); see *Confirmations*.
- **Where it connects** (the installation's design, `docs/specs/2026-10-07-install-core-design.md`):
  the steward at `https://127.0.0.1:18444/mcp`, the applier at `https://127.0.0.1:18443/mcp` (not
  `localhost`, which may resolve to `::1` while Docker publishes IPv4 only), each over TLS from the
  installation's CA, trusted per link. The steward's registration at the applier is the
  installation's `bin/galatea-register-steward`, not the tool's.

## The commands

One bin, `galatea`, with subcommands. Every command takes `--json` (the bodies as the servers return
them, one JSON document per line for a command that streams) and otherwise prints short plain lines.

| Command | What it does | Calls |
|---|---|---|
| `galatea status` | Both servers reached, each one's revision, every transport (up, state, its bridge), the devices not live, open asks counted | applier `describe`; steward `describe`, `state`, `history` |
| `galatea devices [--all]` | The applier's devices: id, bridge, adopted or not, proposed class and its evidence, live, the steward's name and room. `--all` adds every capability and action with its tier | applier `describe`; steward `describe`, `state` |
| `galatea join [--transport T] [--for S] [--no-wait]` | Opens a join window (default 120 s; the bridge may cap it, the Zigbee bridge at 254 s), then prints each device as it joins and as it is described, until the window closes. `--no-wait` returns once the window is open | applier `describe`, `provision { join }`, `events`; steward `describe { since_revision, wait_s }` |
| `galatea close [--transport T]` | Closes the window | applier `provision { join_close }` |
| `galatea adopt <device> --class C [--name N --room R] [--tier action=tier]...` | Adopts the device with its class and any raised tiers; with a name and room, waits until the steward sees it adopted, then names it and puts it in the room (made if new) | applier `configure { adopt, tier }`; steward `describe { since_revision, wait_s }`, `define { room, target }` |
| `galatea remove <device> [--block]` | Removes a device from its bridge; `--block` refuses its rejoin (`block_rejoin`, sent `false` without it) | applier `provision { remove }` |
| `galatea register bridge <id> [--identity I]` | Registers a bridge with the applier under its broker identity (default: the id). The applier's bridge id is `^[a-z0-9-]{1,32}$`, so the installation's `bridge_zigbee` identity is registered as `galatea register bridge zigbee --identity bridge_zigbee` | applier `configure { bridge }` |
| `galatea credential <id> --kind K [--endpoint E] [--confirm-on E2]` | Defines a credential at the steward, its secret read from `secrets/mcp/<id>`, which the installation's `galatea-secret <id>` makes (at least 16 characters; the steward refuses a shorter one or one another credential has). `--endpoint` is for `app` and `panel` only; a `brain` or `front` credential names none (the endpoint names its `served_by`), and `--confirm-on`, brain only, must name an existing endpoint no brain serves (GA-CONF-4). The endpoint itself is defined first, with `galatea define`. The credential is defined whole: the steward's upsert merges (GA-DEF-14), so a field the kind does not take, or a flag left out, is sent as null and cleared. The secret goes to the steward only inside `define`, over TLS, which keeps only its digest; it never appears on a command line, in a JSON file, or in the tool's output, `--json` included | steward `define { credential }` |
| `galatea configure <file\|->` `[--dry-run]` | Any applier change set, as JSON | applier `configure` |
| `galatea define <file\|->` `[--dry-run]` | Any steward change set, as JSON (the home and its `notice_channels`, persons, endpoints, credentials, scenarios, rules) | steward `define` |
| `galatea do <target> <action> [--arg k=v]... [--arg k:=JSON]... [--yes]` | Plans one action at `owner-app` and prints every step (target, action, args, tier, verdict) before anything happens; with `--yes` answers the tool's own ask, without it leaves an asked plan open and prints the `galatea answer` line; applies; waits for the outcome. `k=v` takes `true`, `false` and plain decimals by their form, anything else as a string; `k:=` takes any JSON value. The arguments go as one object; a one-argument action's bare value is the applier's to send its bridge | steward `events`, `plan`, `answer`, `apply`, `outcome` |
| `galatea asks` | Asks waiting on `owner-app` | steward `events`, `history` |
| `galatea answer <plan> <step>... yes\|no` | Answers an ask; when the plan is the tool's own (made at `owner-app`) and nothing in it waits for an answer any more, applies it and waits for the outcome; a step answered `no` ends `skipped(not_confirmed)` and the rest is applied; a scenario's plan is started and its run followed instead (*Scenarios*) | steward `answer`, `events`, `apply`, `outcome`; for a scenario's plan `describe`, `history`, `scenario_run`, `scenario_status` |
| `galatea events [--cursor C] [--follow]` | The steward's events (notices, outcomes, provisioning, model changes), from now or after a cursor an earlier read said, one read of up to 30 s or, with `--follow`, as they come until Ctrl-C; the cursor reached is said last | steward `events` |
| `galatea history [<target>] [--from T] [--to T]` | What happened, and why: a day back by default; `T` is RFC 3339 with its offset or a span ago (`2h`, `7d`); paged with `after_seq`, at most 10 pages, the cap said | steward `history` |
| `galatea scenario list` | The scenarios the steward holds: id, name, mode, the number of steps | steward `describe` |
| `galatea scenario run <id> [--yes]` | Plans the scenario's run at `owner-app` and prints every step; settles its asks as `do` does; starts the run and prints each step's outcome as it lands, for up to 120 s (*Scenarios*) | steward `events`, `scenario_plan`, `answer`, `scenario_run`, `scenario_status` |
| `galatea scenario status <run>` | A run: running or ended with its reason, its failed steps and the steps sent without a witness | steward `scenario_status` |
| `galatea scenario stop <run>` | Stops a run, asked at `owner-app` | steward `scenario_stop` |

What it leaves out, and why:
- **No prompts** (the ruling). The owner reads `galatea join`'s output and runs `galatea adopt`.
- **No `candidates`, `connect` or `commission` command.** No network-device bridge or Matter bridge is
  built; they come with the finder and the Matter bridge.
- **No wrapper over the installation's scripts** (`galatea-restore` and the rest). The storage design
  wants `galatea restore` some day; the scripts work as they are, and the tool reaches only the two
  MCP servers.
- **No rotation of the owner's own credentials.** The installation's design has the tool write a
  rotated `owner-app` secret to its file; that is left for a later plan (no first-light step needs
  it). A brain's credential is `galatea credential`.
- **No editing of rules, scenarios or schedules beyond `define`'s JSON.** A friendlier way to author
  them is the agent-brain's work.

## Pairing

`galatea join` is the guided part:

1. Reads the applier's `describe` and picks the transport: the one given, or the only one in
   `transports`. Two or more, and none given, is refused, naming them. Whether the bridge claims
   Provision is the applier's to answer (`not_claimed`, GA-PROV-1); the tool does not guess it.
2. Opens the window with `provision { join: { transport, window_s } }` and an `idempotency_key`
   (GA-PROV-3), so a retried call opens one window. The reply is a body with a `status`, not a tool
   error: anything but `accepted` is printed with its `reason` and exits 1 (or 2 for `not_claimed` and
   `invalid_request`, refused before anything was done). `failed(busy)` says a window is already
   open.
3. Long-polls the applier's `events` from the cursor it took before the request. Each `provision`
   event `joined` prints `joined: <device>`. A `joined` names no request and no transport (it carries
   `bridge`, `what` and `device`, cause `device`), so the tool takes every `joined` from the window's
   transport's `bridge` while its window is open as this window's.
4. Waits for each joined device to be described, with the steward's `describe { since_revision,
   wait_s }` (the applier's `describe` does not wait), which lists unadopted devices too: the Zigbee
   bridge lists a device only after its interview succeeds. When it appears the tool prints its
   id, the proposed class and its evidence, its capabilities, and the exact `galatea adopt` line to run
   with the proposed class filled in.
5. A device joined and not described within 120 s of joining is printed as `joined, not described:
   its interview may have failed; it stays unadopted` (no standard event says an interview failed).
6. Ends when the window's `window_closed` event comes, printing every device it listed and the
   window's effective length; a device still being described then is waited for, up to its own 120 s
   from joining. Ctrl-C closes the window first (`provision { join_close }`), then exits.

`galatea adopt` is two calls on two servers and cannot be one transaction:
1. Applier `configure` with the `adopt` change (class, declarations) and any `tier` changes, at the
   revision it read, `stale_revision` retried twice after reading again. Without `--name` and
   `--room` the command ends here.
2. Steward `describe { since_revision, wait_s: 30 }` until the device shows adopted (the steward's
   revision moves with the applier's model, GA-HOUSE-1).
3. Steward `define`: the room if it does not exist, then the target with its name and room;
   `stale_revision` retried twice.

A failure after step 1 leaves the device adopted and unnamed. The tool says so and prints the
`galatea adopt` line to run again: adopting an adopted device with the same class changes nothing, so
the rerun goes on to name it (the reference applier adds no change for it; the standard does not
say so either way).

A device may need a step after adoption before it offers what the owner wants: the Fingerbot offers
`onoff` only once its mode is switch, set by its extension action `set_mode`, so after adopting it the
owner runs `galatea do <fingerbot> org.galatea.zigbee.ts0001_fingerbot.set_mode --arg value=switch`.

A joiner the owner does not want is left unadopted, where it can do nothing (GA-ADOPT-1), or removed
with `galatea remove <device> --block`.

## Confirmations

- **`galatea do`** plans at `owner-app`. Its own plan lists every step's target, action, args and
  tier, so the tool prints what will happen before anything does. A step at `confirm` (or `no_voice`,
  which `owner-app` may request and answer, being served by no brain) puts the ask on `owner-app`:
  with `--yes` the tool answers it and applies; without, it prints the plan id and the `galatea answer`
  line and exits 0, leaving the plan open for its validity window. Only the credential that made a
  plan may apply it (GA-STW-5), so `galatea answer` applies the tool's own plans itself once nothing
  in them waits for an answer. The tool learns where its question was put from the plan's `ask` event
  (GA-CONF-5), read from the steward's events after a cursor taken before the plan; a question put
  elsewhere (`owner-app`'s `confirm_on`) is said and left there, and the command ends 1. `--yes` answers
  only a step asked for its tier (`ask(confirm_tier)`): a step asked for another reason (`toggle_only`,
  `in_use`, `in_use_unknown`, `occupancy_unknown`) carries a question the owner has not read when
  typing the command, so it is printed with its reason and left open with its `galatea answer` line.
- **`galatea asks`** reads the `ask` events put on `owner-app` from `history` over the last
  `ask_expiry_s`, less those answered, each with what is asked from the event's `steps` (one per
  asked step, GA-CONF-5; a define's step told by its reason `confirm_define` and shown by its diff).
  A waiting step the event shows nothing for (no `steps`, none for that step, or an entry with no
  target that is not a define's) makes the event malformed: the step is said not shown, never offered
  in the `galatea answer` line, said on stderr, and `asks` ends 1.
- **`galatea answer`** sends `yes` or `no` for the named steps and prints the plan as `answer` returns
  it. Each asked step of that plan carries the answer that stands for it (steward 0.11, *Steps*), so
  the tool reads earlier answers from it; a step just answered that comes back without one is a
  malformed reply (the answer was taken; 1).

## Scenarios

A scenario is defined with `galatea define`, as any other part of the house; `galatea scenario`
lists, runs, reads and stops runs, so a scenario can be tried from the owner's endpoint without a
brain (the maintainer, 2026-10-12). It follows the steward's *Scenario runs*.

- **`galatea scenario list`** reads the steward's `describe` and prints each scenario's id, name,
  mode and the number of its steps as `describe` gives them (a `run` or an `if` step counts as one).
  Ends 0.
- **`galatea scenario run <id> [--yes]`** takes the steward's event cursor, then plans the run at
  `owner-app` (`scenario_plan`) and prints every step before anything happens, a step inside an `if`
  marked `conditional`. A plan whose every step is refused starts nothing, 2. Any other plan is run,
  even when every step is already so: the run judges each step again when it is dispatched
  (GA-SCN-7), so a `turn_off` planned `skip(already)` runs after the `turn_on` before it. Its asks are
  settled as `do` settles them, by the same code: `--yes` answers only a tier's question, a step asked
  for another reason is left open with its `galatea answer` line, a question put elsewhere is said
  and left there (1). Then `scenario_run`, under a new idempotency key, a lost call sent once more
  with the same key (GA-SCN-6). A start that `single` ignores is said with the running run's id,
  nothing done by it (2, or 1 after an answer).
- **Following the run.** The tool reads `scenario_status`, then the steward's events, at most 5 s at
  a time, and prints each event of the run as it comes: a step's `outcome` (the `outcome` events
  whose cause names the run), an `if`'s branch, a `wait`'s timeout, and the run's plan asked again
  for a toggle (GA-SCN-3) with the line that answers it, which `--yes` never answers: once the run has
  started its plan is asked nothing else, so an `ask` on it is the run's whether or not it names the
  run (GA-CONF-5 says it may). Once the run
  has ended it prints the end, each failed step with its outcome and time, and each step sent
  without a witness. It follows for up to 120 s; a run still running then, or when Ctrl-C stops the
  following, goes on, and the tool prints its id with the `scenario status` and `scenario stop` lines.
  Once the run has ended its last events are read whole; a Ctrl-C meanwhile is said after the end, 1,
  as `do` says one after its outcomes.
- **`galatea answer` of a scenario's plan** starts the run once nothing in the plan waits, and
  follows it, since the steward starts a scenario's plan with `scenario_run`, never with `apply`. An
  `ask` event of the plan that names a run is that run's question asked again: the answer is the
  running run's, and nothing is started. A re-ask that names no run is found when `scenario_run`
  refuses the plan `plan_expired`, spent by its run: the answer was taken by the run, said, 0. The
  `declined` line names only the steps this answer declined, and is said once a run has started.
- **`galatea scenario status <run>`** prints `scenario_status`; **`galatea scenario stop <run>`**
  sends `scenario_stop` at `owner-app` (GA-SCN-9) and prints the status it returns, saying so when
  the run had ended already.

Exit codes, as the tool's others:

| Command | 0 done | 1 failed under way | 2 refused before anything was done |
|---|---|---|---|
| `scenario list` | listed | a lost call | a bad line; the steward not reached or refusing |
| `scenario run`, and `answer` of a scenario's plan | the run ended `done` with no failed step; or the plan left open for an answer | the run ended `timeout`, `stopped` or `interrupted`, or with a failed step; still running at 120 s, or Ctrl-C; a question put elsewhere; a malformed status; a refusal after the start or an answer | a bad line; the scenario unknown (`invalid_request`); every step refused; a start `single` ignored with nothing done before it |
| `scenario status` | the read worked, however the run stands or ended (its lines and `--json` say it; the maintainer's ruling: it is a read) | a malformed reply | `unknown_run`; a bad line |
| `scenario stop` | the run ended `stopped`, or had ended already | the steward answered with the run still running; a malformed reply | `unknown_run`, `not_permitted`; a bad line |

A step the owner answered `no` ends `skipped(not_confirmed)` and is in the run's `failed_steps`
(GA-SCN-11); the tool prints it marked as the owner's answer and, as `do` counts it, it is no failure
for the exit code.

## Connecting

**What it reads.** An installation directory, `--install <dir>` or `GALATEA_INSTALL`, default the
current directory. From it: `secrets/mcp/applier-owner`, `secrets/mcp/steward-owner`, a brain's
`secrets/mcp/<id>` for `galatea credential`, and the CA's certificate `tls/ca.pem` (public, 0644; the
CA's key stays in `secrets/ca/` and the tool never reads it). Each secret file must be the owner's and
unreadable by other accounts, as the builds require of theirs. The URLs default to the installation's (*Rulings*), changed with
`--applier <url>` and `--steward <url>` or `GALATEA_APPLIER_URL` and `GALATEA_STEWARD_URL`. On another
machine the owner copies the CA and the two owner credentials into the same layout; nothing else.
Anything running in the owner's account there acts as the owner, by design, so the copies go only to
an owner's account with no unattended agents; otherwise the owner runs the tool on the box over ssh.

**How.** MCP over Streamable HTTP, revision `2026-07-28` with the SDK's fallback (GA-BIND-1), on
`@modelcontextprotocol/client` as the harness's `McpSeam` and the steward's `McpApplierPort` use it.
`Authorization: Bearer` from the credential file. Each of the two links trusts the CA through its own
`fetch` with its own `undici` `Agent`: undici is a dependency, and the link uses undici's own `fetch`
rather than Node's built-in one, whose bundled undici differs by Node version; the tool changes no process-wide TLS setting and never turns validation off. The
steward's process-wide `trustApplierCa` is not the pattern. A `define` held over 10 s comes back as
an MCP protocol error with `data.pending: true`; `Link` returns it as a held result, and the tool says
the change will be judged at its revision and exits 1. Plain `http://` is accepted only for a loopback address, as the servers allow it there (the
tests use it).

**What it never prints**: a credential, the token key, or a token. `--json` output passes the servers'
bodies through, which carry none (the steward stores secrets as digests and never returns one).

**Exit codes**, as the Zigbee bridge's command line: 0 done; 1 failed under way (a refusal from a
server after something was done, a lost connection, a timeout); 2 refused before anything was done (a
bad flag, a missing or unsafe file, a server that cannot be reached, a refusal of the first call).

## The package

`reference/owner-tool`, named `@ludentes/galatea-life-owner-tool`, private like every reference build,
its bin `galatea` pointing at `dist/main.js`. TypeScript, ESM, Node 24 or later; argument parsing with
`node:util`'s `parseArgs` (no dependency), as the harness hand-rolls its own.

| Unit | What it does | Depends on |
|---|---|---|
| `src/main.ts` | The only reader of the environment, argv and files: builds the two links and hands them, with `Say { out, err }`, to `run` | everything below |
| `src/cli.ts` | `run(argv, deps)`: parses, dispatches to a command, maps errors to exit codes | the commands |
| `src/link.ts` | `Link`: one MCP client with one bearer and one CA; `call(tool, args)` returns the body or a `Refused { error, message, data }`; `poll` helpers for `events` and `describe { since_revision }` | the MCP SDK |
| `src/servers.ts` | `Applier` and `Steward`: typed calls over a `Link` (`describe`, `provision`, `configure`, `define`, `plan`, ...) | `Link` |
| `src/commands/*.ts` | One file per command group: `status`, `devices`, `pairing` (`join`, `close`, `adopt`, `remove`), `register` (with `credential`), `changes` (`configure`, `define`), `confirm` (`do`, `asks`, `answer`), `reading` (`events`, `history`), `scenario` (`list`, `run`, `status`, `stop`) | `Applier`, `Steward`, `Say` |
| `src/print.ts` | The plain-line and JSON renderings | — |

The commands take `Applier` and `Steward` interfaces, so their tests use in-memory fakes.

## Testing

- **Unit tests** (vitest) per command over fakes of `Applier` and `Steward`: what is called, in which
  order, with which arguments; retries on `stale_revision`; the 120 s not-described message on a fake
  clock; Ctrl-C closing the window; exit codes; that no secret appears in any output.
  The fake steward runs a scenario's top-level action and delay steps on its fake clock as the
  reference steward runs them (each step ended before the next, an unanswered ask
  `skipped(not_confirmed)`, `single` ignoring a second start), but judges every step once, when the
  run starts, not at each step's dispatch; it runs no `if`, `wait` or `run` step, and its re-ask
  (`reask`) reopens the plan to the re-asked steps' answer as the reference's does, the run not
  waiting on it; the tests feed the rest as events.
- **Request shapes.** Every request the tool's `Steward` sends is checked against the steward's own
  request schema for its operation (`requestSchemaFor`, as the steward's `tools/list` serves it).
  Those schemas are open (no `additionalProperties: false`), so the check catches a missing required
  field or a wrong type, not an extra one; the four scenario requests are also compared exactly.
- **`Link` tests** against a small MCP server in the test (the SDK's server), over plain HTTP on
  loopback and over TLS with a test CA: the bearer is sent, a server certificate from another CA is
  refused, a refusal's body is returned whole.
- **An end-to-end test** of the reference applier and steward over the harness's simulated bridge,
  as the steward's first-light script runs them (real processes, a fresh database, the simulated
  broker), the simulated bridge started claiming Provision: `galatea register`; `galatea adopt` of
  the simulated `notify` device without a name; `galatea define` of the home with it as the channel;
  `galatea join` with a device joined in the window through the simulated bridge's `join` control
  (it joins with no proposed class, so the test passes `--class`); `galatea adopt` of it with a name
  and room; `galatea do` of a lamp's `turn_on` raised to `confirm`, with `--yes`, and the outcome; a
  `do` without `--yes` then `galatea answer`, which applies it; `galatea asks` before and after;
  a `no` whose step is skipped and nothing sent; `galatea events --follow` showing the outcome, ended by
  Ctrl-C; `galatea history` reading it back; two scenarios defined over the lamp (on, a delay, off)
  and listed, one run with `--yes` and read back with `scenario status`, the other started through
  `galatea answer` and stopped with `scenario stop` before its `turn_off` is sent. A heavy run,
  through `heavy.sh` (a workshop wrapper), once per pull request.
- The hand check is plan 4b's: the owner tool against the installed stack in the flat.

## The plans

Three, each its own pull request:
- **A: the ground.** The package, `Link` with a CA per link, `main.ts`'s files and settings,
  `status`, `devices`, `register bridge`, `credential`, `configure`, `define`, and `adopt` without a name
  (the 0.10 channel's first step), and the end-to-end test's skeleton.
  Enough to do first light's setup steps (the installation's runbook, steps 6, 7 and 10).
- **B: pairing.** `join`, `close`, `adopt`, `remove`, and the end-to-end test's join and adopt.
- **C: confirmations and reading.** `do`, `asks`, `answer`, `events`, `history`, and the end-to-end
  test's confirm. Built against steward 0.10's `ask`; moved to steward 0.11 on 2026-10-11, `asks`
  showing the event's steps.
- **Scenarios**, after C (2026-10-12): `galatea scenario`, and its end-to-end steps.

The maintainer's order puts pairing first; A comes before B because pairing needs the links, the
settings and `devices` to show what joined.

## What this does not decide

- How the agent-brain authors rules and scenarios; it is the steward session's.
- Box (the broker's registration record and its warnings), which the installation's design leaves for
  later, and the tool's commands for it.
- The owner tool on another operating system than Linux: it should run where Node 24 runs, untested.
