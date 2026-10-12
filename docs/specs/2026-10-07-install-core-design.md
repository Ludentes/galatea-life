---
title: The installation's core — the applier, the steward, credentials and TLS
status: draft
last_verified:
area: deployment
audience: dev
author: Galatea maintainers
related:
  - reference/install/README.md
  - docs/plans/2026-10-06-zigbee-bridge-4a-the-bridge-installed.md
  - docs/specs/2026-09-28-storage-design.md
  - docs/specs/2026-10-02-reference-steward-design.md
  - docs/specs/2026-09-28-reference-applier-design.md
  - docs/specs/2026-10-06-harness-subject-lifecycle-design.md
  - docs/research/2026-10-07-install-security.md
  - docs/research/2026-10-04-mosquitto-subscription-refusals.md
  - docs/plans/roadmap.md
  - standard/applier.md
  - standard/steward.md
  - standard/bridge.md
  - standard/brain.md
---

# The installation's core — the applier, the steward, credentials and TLS

## Changelog

| Date | Change |
|---|---|
| 2026-10-07 | Revised after the re-review (no blocker; the last round by the stopping rule) and the maintainer's rulings: the Beelink is the box, the gbench stack giving way at first light; the secrets archive in its own directory no service mounts, optionally encrypted off the box; anything in the owner's account acts as the owner, by design, and owner credentials are copied only to the owner's own accounts; `galatea-secret --for` installs `ca.pem` too; a brain credential names no endpoint; one path to register the steward; Postgres named as the one plain link inside the stack; the LAN override publishes the broker only; the certificate script's user and name types; crash-safe rotations; plans A to D with C split in two and A's dependencies named. |
| 2026-10-07 | Revised after three reviews (a fresh-eyes review, the applier team's, the Zigbee team's, with its owner-tool spec) and the maintainer's rulings. TLS everywhere inside the stack, the broker on `mqtts` from the installation's CA, and `box: true` possible, with what else Box still needs named. The brain under its own account, `ca.pem` out of `secrets/`. The model's refused answer carries an utterance record. The owner's tool reads `events`. The notice channel: steward 0.11's relaxed bootstrap, with the PC bridge on the desktop as the stopgap, its steps written out. The secrets tarball is made by an owner's command, not by the backup service. A register script for the steward, with no model in the loop; bridges registered by the owner's tool, under ids the applier accepts. Rotating the Postgres superuser. The TLS path variables keep their names. Four plans. |
| 2026-10-07 | First draft, for the maintainer's review before any plan or code |

## What this is for

First light in the flat: a model switches a real
Zigbee device through brain, steward, applier and bridge, and a `confirm` is asked, answered by a
person, and refused when the model tries to answer it. The installation (`reference/install/`) holds
Postgres with its provisioning and checked backups, the broker with one identity per line of
`instances`, and the Zigbee bridge. This design adds what first light still needs:

- the applier and the steward as Compose services;
- every secret they and their clients need, with how each is made, kept, rotated and backed up;
- TLS on every connection inside the stack, from a certificate authority the installation makes: the
  MCP seams and the broker;
- the broker's access rules, narrowed to what each identity uses;
- how the owner's tool and a brain reach the steward, each under its own account;
- the outline of a runbook from an empty box to a confirmed switch, for the Zigbee bridge's plan 4b.

The packages are named as `main` names them at this draft's base (`94fdf6fb`), after the rename:
`@ludentes/galatea-life-applier`, `@ludentes/galatea-life-steward`,
`@ludentes/galatea-life-install`, and so on. What was read to write it is in
the maintainers' research notes. The owner's tool's commands are named as its own
design names them (`docs/specs/2026-10-07-owner-tool-design.md`).

**Who builds it** (the maintainer, 2026-10-07): the steward team takes the install's remainder,
the agent-brain, and the applier's entry-point changes, which the applier team reviews. The
Zigbee team takes the owner's tool and plan 4b; the applier team its Zigbee-fidelity fix.
*Plans* cuts the work along those lines.

**Rulings this design carries** (the maintainer, 2026-10-07):

- TLS everywhere inside the stack, from one self-signed CA a script sets up; no shared network
  namespaces, and no standard change calling a Docker network loopback.
- The broker serves `mqtts`; the applier and the bridges validate it against the CA.
- The notice channel: steward 0.11 relaxes the first `define`'s bootstrap (its item DEF-a); until it
  is built, the PC bridge on the desktop is the stopgap channel.
- The brain runs under its own account, or in a container with only its own files.
- The stack runs on the Beelink (the maintainer, 2026-10-07). Measured that day: four cores, 15 GiB
  of RAM with 13 GiB available, the disk 4% used, load about 0.1; Frigate takes about 1.5 GiB and the
  gbench stack well under 200 MiB. The applier and the steward, each well under 1 GiB, fit. The
  gbench stack gives way to the installation at first light, since the coordinator takes one client.

## The requirements it serves

| Id | What the installation does for it |
|---|---|
| GA-SEC-1 | Every connection to the applier uses TLS with its certificate validated, from the installation's CA; no client in the installation turns validation off |
| GA-SEC-2 | The steward serves TLS, and reaches its applier over TLS with the CA given for that link alone |
| GA-BRAIN-16 | A brain reaches the steward over TLS, trusting the installation's CA in its own process |
| GA-BIND-1, GA-BIND-2 | Unchanged: both servers already serve `2026-07-28`; the installation only carries them |
| GA-AUTH-3, GA-CFG-1 | The applier's owner credential and its one client, the steward, each from its own file; the steward registered through `configure` by a script, no model in the loop |
| GA-AUTH-4 | The steward's first owner from a file; every other credential (a brain's) defined through `define`, its secret from a file |
| GA-TOKEN-2 | The shared proof key, made by the installation, read by the steward from a file and registered at the applier for the steward's client |
| GA-CONF-1, GA-CONF-2, GA-TIER-2 | First light's ask: the brain's endpoint names the owner's app in `confirm_on`, so the model's `answer`, carrying a well-formed utterance record, is `not_permitted` |
| GA-TIER-1 | The stopgap computer's power and session actions raised to `no_voice`, so the brain cannot reach them |
| GA-BRIDGE-18 | Each bridge connects as its own authenticated identity over TLS, its ClientID equal to its user name |
| GA-BUS-9 | The applier's broker grants match what it reads and writes: it may not read a command or request topic |
| GA-DESC-6 | The applier reaches its broker over `mqtts`, so it no longer refuses `box: true` |
| GA-BOX-1, GA-BOX-2 | Partly met by the broker's TLS and rules; what is still missing is named in *Box and Safe*, and built in its own plan |
| GA-NOTE-1, GA-DEF-8 | Until steward 0.11, the first `define` names the stopgap computer's `notify` |
| GA-PERSIST-1, GA-PERSIST-2 | The builds keep their state in Postgres; the nightly checked dump and the owner's secrets archive restore both |

## The stack

```
     owner's account                         brain's account
     owner's tool ─┐                         ┌─ a brain (an agent tool)
                   │ https                   │ https
   127.0.0.1:18443 ┤                         ├ 127.0.0.1:18444   (LAN only through compose.lan.yaml)
                   ▼                         ▼
   postgres ◄── db-init       applier ◄──── steward             (MCP over TLS, the installation's CA)
      ▲   ▲                    │  ▲            ▲
      │   └ backup             │  └ applier-migrate              steward-migrate
      │                        ▼ mqtts :8883 (password over TLS, the installation's CA)
      └───────────────────── broker ◄──── zigbee-bridge ───► coordinator (TCP)
                               ▲
                               └──── the PC bridge on the desktop (stopgap, until steward 0.11)
```

Services on one Compose network. Postgres publishes no port; the broker none unless the LAN override
is used. The applier and the steward publish their MCP ports on the host's loopback.

## The applier and the steward as services

**Images.** Each build gets an image built by Compose from the repository, as the Zigbee bridge's is:
`reference/applier/Dockerfile` and `reference/steward/Dockerfile`, each with an allow-list context
(`Dockerfile.dockerignore`) of the workspace's manifests and the packages it needs; `pnpm deploy
--legacy --prod`; `node:24-bookworm-slim`; tagged `galatea-applier:local` and `galatea-steward:local`.
One image per build serves both its entries: `dist/migrate-main.js` and `dist/main.js`.

**Services.** Four, none under a profile, since every installation runs an applier and a steward:

| Service | Command | Restart | Waits for |
|---|---|---|---|
| `applier-migrate` | `node dist/migrate-main.js` | `no` | `db-init` completed |
| `applier` | `node dist/main.js` | `unless-stopped` | `applier-migrate` completed, `broker` healthy |
| `steward-migrate` | `node dist/migrate-main.js` | `no` | `db-init` completed |
| `steward` | `node dist/main.js` | `unless-stopped` | `steward-migrate` completed, `applier` started |

- **Migrations** run in their one-off service, so a migration that fails stops `docker compose up`
  with that service's error, instead of a server that restarts in a loop. Each server migrates again
  when its store opens (`Store.open`) and finds nothing to do. The migrations take no lock; the
  ordering keeps the two from running on one schema at once. The steward's migrate-only entry comes
  from the harness opt-in branch (`feat/steward-harness-opt-in`); until it merges, `steward-migrate`
  is left out and the steward migrates at its start.
- **The four run as the owner's account** (`user: ${GALATEA_UID}:${GALATEA_GID}`), which owns their
  secret files, mode 0600. `init: true` passes SIGTERM; `stop_grace_period: 10s` covers each server's
  3 s to commit what it queued. (`postgres`, `db-init` and `broker` keep their images' own users; the
  broker's start runs as root, then drops to `mosquitto`.)
- **No volumes.** Both keep everything in Postgres. Each mounts only its own files, each bind refusing
  a missing source (`create_host_path: false`), as the Zigbee bridge's do.
- **Ports.** Inside the network the applier serves `https://applier:18443/mcp` and the steward
  `https://steward:18444/mcp`, each listening on `0.0.0.0` with TLS. `compose.yaml` publishes them on
  `127.0.0.1:18443` and `127.0.0.1:18444` only. Publishing elsewhere is the LAN override's
  (*How the owner and a brain reach the steward*).
- **Health checks.** One script the installation ships (`health/mcp-health.mjs`), mounted read-only
  and run by each service's own `node`: an HTTPS request to its own `/mcp`, validated against the CA,
  which must answer with any HTTP status within 3 s (so a stuck event loop is unhealthy, which a port
  check would miss), and its certificate must have more than 14 days left. It sends no credential.
  Compose restarts a service that exits, not one that is unhealthy; the owner's tool shows the state.
  The steward waits only for the applier to start, not to be healthy: it serves without its applier,
  and its link retries every failed session with a backoff of 250 ms to 5 s (`ApplierLink`).
- **Logs.** Every service in the file, the existing ones included, gets the `json-file` driver capped
  at 50 MB and three files (an anchor at the top of `compose.yaml`). A deployed fleet's broker log
  once filled a disk.

**Configuration**, each service's environment and binds, with no secret in either. On the host,
secrets live under `secrets/`, and the public certificates under `tls/`.

| `applier` | Value |
|---|---|
| `GALATEA_DATABASE_URL` | `postgres://applier@postgres:5432/galatea` |
| `GALATEA_DATABASE_PASSWORD_FILE` | `/run/secrets/db` ← `secrets/db/applier` |
| `GALATEA_BROKER` | `mqtts://applier@broker:8883` |
| `GALATEA_BROKER_PASSWORD_FILE` | `/run/secrets/broker` ← `secrets/broker/applier` |
| `GALATEA_BROKER_CA` | `/run/tls/ca.pem` ← `tls/ca.pem` |
| `GALATEA_ROOT` | `${GALATEA_ROOT:-galatea}` |
| `GALATEA_OWNER_CREDENTIAL_FILE` | `/run/secrets/owner` ← `secrets/mcp/applier-owner` |
| `GALATEA_MCP_PORT`, `GALATEA_APPLIER_HOST` | `18443`, `0.0.0.0` |
| `GALATEA_APPLIER_TLS_CERT`, `GALATEA_APPLIER_TLS_KEY` | `/run/tls/applier.pem` ← `tls/applier.pem`; `/run/secrets/tls.key` ← `secrets/tls/applier.key` |

| `applier-migrate` | Value |
|---|---|
| `GALATEA_DATABASE_URL`, `GALATEA_DATABASE_PASSWORD_FILE` | as the applier's, with the one bind `secrets/db/applier` |

| `steward` | Value |
|---|---|
| `GALATEA_DATABASE_URL`, `GALATEA_DATABASE_PASSWORD_FILE` | as the applier's, for `steward` (`secrets/db/steward`) |
| `GALATEA_OWNER_CREDENTIAL_FILE` | `/run/secrets/owner` ← `secrets/mcp/steward-owner` (makes the first owner on an empty store) |
| `GALATEA_MCP_PORT`, `GALATEA_STEWARD_HOST` | `18444`, `0.0.0.0` |
| `GALATEA_STEWARD_TLS_CERT`, `GALATEA_STEWARD_TLS_KEY` | `tls/steward.pem`, `secrets/tls/steward.key`, bound as the applier's are |
| `GALATEA_APPLIER_URL` | `https://applier:18443/mcp` |
| `GALATEA_APPLIER_CLIENT` | `steward` |
| `GALATEA_APPLIER_CREDENTIAL_FILE`, `GALATEA_APPLIER_TOKEN_KEY_FILE` | `secrets/mcp/steward-at-applier`, `secrets/mcp/steward-token-key` |
| `GALATEA_APPLIER_CA` | `/run/tls/ca.pem` ← `tls/ca.pem` |

| `steward-migrate` | Value |
|---|---|
| `GALATEA_DATABASE_URL`, `GALATEA_DATABASE_PASSWORD_FILE` | as the steward's, with the one bind `secrets/db/steward` |

The Zigbee bridge's service changes to `GALATEA_BROKER=mqtts://bridge_zigbee@broker:8883` with the
CA bound at `/run/tls/ca.pem` (*TLS inside the stack*, the clients).

No `GALATEA_TIME_SOURCE`, `GALATEA_TEST_RUN_ID` or `GALATEA_MUTATION`: those are the harness's.

**The one plain link inside the stack** is Postgres: the builds reach `postgres:5432` without TLS on
the Compose network. Postgres is never published, so only containers of the stack can reach it, and
its traffic never leaves the box; TLS for it (`hostssl`) comes with access from other boxes, from this
CA (the storage design's *Access from other boxes*). The backlog records it, for the maintainer to
confirm. The Zigbee coordinator's TCP link is outside the stack and plain on the LAN, as the coordinator
offers no TLS.

**Weighed.**
- *Host networking*, or the applier in the broker's network namespace, so that a connection is on
  loopback and plain text is allowed: ruled out (no shared-namespace tricks), and every other box
  needs TLS anyway.
- *No migrate services*, relying on the migrate at `Store.open`: one path fewer, but a failing
  migration becomes a restart loop. Rejected; the one-off service costs a few lines.
- *A registry image with a version tag*: comes with packaging, after the steward's slice 11;
  until then the images are built locally, as the bridge's is.
- *Compose's top-level `secrets:`*: outside Swarm they are bind mounts under `/run/secrets`, and the
  long syntax's owner and mode are not applied to a file's secret. The explicit binds the installation
  already uses do the same and refuse a missing file. Kept the binds.

## The builds' entry points

What both builds' `main.ts` (and `migrate-main.ts`) must do, against what they do today. Only the
entry points read the environment and files; the code below them takes values (the agreed shape).

- **TLS, server side.** `GALATEA_APPLIER_TLS_CERT` and `_KEY`, and `GALATEA_STEWARD_TLS_CERT` and
  `_KEY`, keep their names: they already name files, they are the harness's subject contract, and the
  harness passes paths for GA-SEC-1. What moves is the read: `main.ts` reads both files and passes the
  PEM contents to `serveMcp`, which takes `tls: { cert, key }` as contents and imports no `node:fs`.
  Today `serveMcp` (`src/mcp/server.ts`, in both builds) calls `readFileSync` itself.
- **TLS, the steward's link.** `GALATEA_APPLIER_CA` keeps its name and stays a path. `main.ts` reads
  it and passes the PEM to `McpApplierPort.connect(url, bearer, { legacy, ca, insecure })`. The link
  makes its own undici `Agent({ connect: { ca } })` (or `{ rejectUnauthorized: false }` under the
  mutation `trusts-any-applier` alone) and hands `StreamableHTTPClientTransport` its `fetch` option
  (MCP SDK 2.2.0 takes one): undici's own `fetch`, called with that agent as `dispatcher`. Node's
  global `fetch` ignores an `https.Agent`, and pairing it with another copy of undici's `Agent` risks
  two versions, so the steward takes `undici` as a dependency and uses its `fetch`. `trustApplierCa`
  (`tls.setDefaultCACertificates`) and `trustAnyApplier` (`NODE_TLS_REJECT_UNAUTHORIZED=0`) are
  removed: nothing in the process trusts anything but its system store, except that one link. The
  harness's subject-lifecycle design can then drop its clause that a reset may not change
  `GALATEA_APPLIER_CA`.
- **TLS, the applier's broker.** New: `GALATEA_BROKER_CA`, a path, read by `main.ts` and passed to
  the bus as `ca` in the MQTT client's connect options. An `mqtts://` broker is then validated
  against it; without it, against the system store. With `mqtts`, `plainOffLoopback` is false, and
  the applier no longer refuses `box: true` (GA-DESC-6).
- **Secrets.** Each secret that can be given as a value gets a `_FILE` twin, read by the entry point:
  the applier's `GALATEA_OWNER_CREDENTIAL`; the steward's `GALATEA_OWNER_CREDENTIAL`,
  `GALATEA_APPLIER_CREDENTIAL` and `GALATEA_APPLIER_TOKEN_KEY` (whose 16-character floor applies to a
  file's value too); the store's password (`GALATEA_DATABASE_PASSWORD_FILE`, both builds, both
  entries); the applier's broker password (`GALATEA_BROKER_PASSWORD_FILE`). A file must be the
  account's own, mode 0600, as the Zigbee bridge's `readSecret` requires; its last line end is
  dropped; it is never printed.
- **Which wins.** A value and its `_FILE` twin both set is refused at start, naming the two settings.
  So is a `GALATEA_DATABASE_URL` that carries a password together with `GALATEA_DATABASE_PASSWORD_FILE`
  (and the same for `GALATEA_BROKER`). The harness's full URLs and values, with no `_FILE` set, work
  as today. The password from a file is put into the URL before `connectPg` (or into the bus's
  options), and every message still passes through `maskUrls`.
- **A variable's name says what it holds.** A variable that only ever names a file keeps a plain name
  (`GALATEA_APPLIER_TLS_CERT`, `GALATEA_APPLIER_CA`, `GALATEA_BROKER_CA`); a secret that can also be a
  value has its `_FILE` twin.

## Credentials

**Every secret is a file**, made on the host by the owner's account, mode 0600 in a directory of
mode 0700, never in `compose.yaml`, `.env`, a service's environment, a command line or a log. A random
secret is 32 characters from `/dev/urandom` (about 190 bits), alphanumeric, so it is safe in a URL,
as `galatea-db-prepare` makes them today.

| Secret | File | Made by | Read by | Rotated by |
|---|---|---|---|---|
| Postgres superuser | `secrets/db/postgres` | `galatea-prepare` | Postgres at `initdb` only; `db-init`, `backup` | `bin/galatea-rotate-postgres` (below) |
| `reader`, each build's role | `secrets/db/<id>` | `galatea-prepare` | `db-init`, the build | deleting the file, `galatea-prepare`, `up` (db-init sets these passwords at each run), restarting the build |
| Each broker identity | `secrets/broker/<id>`, only for `applier` and `bridge_*` | `galatea-prepare` | the broker (hashed at its start), the build | as above, restarting the broker and the build |
| The applier's owner configuration credential | `secrets/mcp/applier-owner` | `galatea-prepare` | the applier, the owner's tool, `galatea-register-steward` | replacing the file, restarting the applier |
| The steward's first owner credential | `secrets/mcp/steward-owner` | `galatea-prepare` | the steward (only on an empty store), the owner's tool | later: the owner's tool defining a new secret for `owner-app` and writing it to the same file |
| The steward's credential at the applier | `secrets/mcp/steward-at-applier` | `galatea-prepare` | the steward; `galatea-register-steward` | `galatea-register-steward --rotate` (below) |
| The shared proof key (`@ludentes/galatea-life-binding`) | `secrets/mcp/steward-token-key` | `galatea-prepare` | the steward; `galatea-register-steward` | with the credential above, in the same `configure` |
| A brain's credential | `secrets/mcp/<id>`, and a copy owned by the brain's account | `galatea-secret <id> [--for <account>]` | the brain's agent tool; the owner's tool, which defines it (`galatea credential <id> --kind brain [--confirm-on owner-app]`; a brain credential names no endpoint) | `galatea-secret` again, the same `galatea credential` command, relaunching the agent |
| The CA's key | `secrets/ca/ca.key` | `galatea-certs`, once | only the one-off certificate container | a new CA (*TLS inside the stack*) |
| The servers' keys (applier, steward, broker) | `secrets/tls/<server>.key` | `galatea-certs` | that server | `galatea-certs` |

The CA's certificate and the servers' certificates are not secret: they live in `tls/`
(`tls/ca.pem`, `tls/<server>.pem`), mode 0644, readable by the brain's account and copied to other
machines freely.

- **One secret per seam.** A build's broker password is never its store password (4a); the owner's
  two credentials, at the applier and at the steward, are separate; the token key is never the
  steward's credential (the applier refuses that in `configure`). A leak of one opens one seam.
- **The steward has no broker identity.** `galatea-prepare` and `broker-init.sh` give one only to
  `applier` and to lines starting `bridge_` (later `finder`), closing 4a's leftover.
- **Registering the steward at the applier.** `bin/galatea-register-steward` runs a short Node script
  the installation ships (`register/register-steward.mjs`), in a one-off container of the steward's
  image (which has the MCP client), on the stack's network, bound into the image's directory so it
  resolves the image's packages. It reads, from read-only binds, the applier's owner credential, the
  steward's credential and token key, and `tls/ca.pem`; reads the applier's `describe` for its
  revision; and sends one `configure` upserting the client
  `{ id: steward, credential, token_key, kind: steward }`. It prints the diff, never a value. No
  model is in the loop, and no credential is on a command line. It is the one way to register the
  steward: the owner's tool does not carry its own command for it. `--rotate` writes a new pair to
  `steward-at-applier.next` and `steward-token-key.next`, configures it, and only then moves the two
  files over the old ones and restarts the steward; a failed `configure` leaves the steward working
  on the old pair, and a run that finds `.next` files configures them first.
- **Registering a bridge** is the owner's tool's: `galatea register bridge zigbee --identity
  bridge_zigbee`. The applier's bridge id matches `^[a-z0-9-]{1,32}$` (`configure.bridge.json`), with
  no underscore, so the id (`zigbee`, `pc-desktop`) differs from the broker identity, which is the
  `instances` line (`bridge_zigbee`, `bridge_pc_desktop`). Device ids carry the bridge id
  (`zigbee:<device>`).
- **Rotating the steward's pair** refuses its calls for the seconds between the `configure` and the
  steward's restart; an ask answered in that gap has its token refused (GA-TOKEN-2) and is asked
  again. Acceptable in a home; the README says to rotate while nothing is pending.
- **Rotating the Postgres superuser.** `POSTGRES_PASSWORD_FILE` applies only at `initdb`; after that
  the role's password is the database's, and `db-init` logs in with whatever the file holds, so
  replacing the file alone locks `db-init` out and every build waits on it.
  `bin/galatea-rotate-postgres` writes a new password to `secrets/db/postgres.next`; runs, through
  `docker compose exec -T postgres psql -U postgres` over the container's local socket (which the
  image trusts, so no old password is needed), `\set pw` from that file (mounted with the rest of
  `secrets/db/`) and `ALTER ROLE postgres PASSWORD :'pw'`, so the value is on no command line; then
  moves `postgres.next` over `postgres` and runs `docker compose up -d` so `db-init` and `backup` read
  the new file. It is resumable: a run that finds `postgres.next` applies that password first, so a
  crash between the `ALTER ROLE` and the move is mended by running it again. A failed `ALTER ROLE`
  writes its statement, password included, to the server's log, as `db-init.sh`'s role passwords
  already would; accepted, since the log is the container's and the owner's (a SCRAM verifier made on
  the client would avoid it, at the cost of a client-side tool).
- **The secrets archive.** The applier's `clients` table keeps the steward's credential and token key
  in clear (the HMAC needs the key), so the nightly dump is already secret, and so is the Zigbee
  backup beside it. A restore also needs the files that match the store. So
  `bin/galatea-backup-secrets`, run by the owner's account on the host, writes
  `install-<time>.tar` of `secrets/`, `tls/`, `instances` and `.env`, mode 0600, into its own
  directory, `GALATEA_SECRETS_BACKUPS` (`./backups-secrets`, 0700, the owner's), **never into
  `backups/`**: the `backup` service runs as the owner and mounts `backups/` read-write, so an archive
  there would be readable, and deletable, by a running service. No service mounts the archive's
  directory. It checks the archive by listing it and finding every file it should hold non-empty, and
  keeps the newest `GALATEA_BACKUP_KEEP`, never the newest good one. With `GALATEA_SECRETS_RECIPIENT`
  set, it encrypts the archive with `age` (in Debian's archive, so no extra source to trust) to that
  public key, whose private half the owner keeps off the box; the box then holds no readable copy, and
  a NAS mount behind the directory holds nothing it could use. It runs nightly from the owner's
  crontab, after the dump: the Beelink is headless and the owner is not logged in, so a systemd user
  timer would need `loginctl enable-linger`; the README gives both. Restoring on a new box starts by
  unpacking (decrypting) the archive, then `galatea-prepare` and `galatea-restore`. Where the archive
  lives is an open question.

**Weighed.**
- *Secrets in `.env` or the environment*, as a deployed fleet does: the simplest, but `docker
  inspect` and every support dump show them, and the fleet lost a user once to a value set in `.env`
  and not passed through. Rejected.
- *The archive made by the `backup` service*, or written into `backups/`: either puts every secret,
  the CA's key included, within a running service's reach. Rejected for the owner's command and a
  directory no service mounts.
- *The steward registered by a model* (the owner's Claude Code session): the credential and the token
  key would pass through the model's context and transcripts, and the owner's credential would sit in
  the tool's configuration. Rejected for `galatea-register-steward`.
- *The applier's credential column as a digest*, like the steward's: it would take the steward's
  credential out of the dump, not the token key. A backlog candidate for the applier.

## TLS inside the stack

**A local CA, made by the installation.** `bin/galatea-certs` runs `openssl` in a one-off container
of a small image the installation builds (`certs/Dockerfile`: `alpine:3` with `openssl`), since none
of the stack's images carries the command (from the maintainers' security notes). The
container runs as `--user ${GALATEA_UID}:${GALATEA_GID}`, so the keys it writes are the owner's, as
the services that read them run. It:

- makes the CA once: an ECDSA P-256 key and a self-signed certificate valid 10 years, with
  `basicConstraints=critical,CA:true,pathlen:0`, `keyUsage=critical,keyCertSign,cRLSign` and a subject
  key identifier. Re-running the script never replaces an existing CA;
- issues each server's certificate (the applier, the steward, the broker): a fresh P-256 key, valid
  two years, `basicConstraints=critical,CA:false`, `keyUsage=critical,digitalSignature`,
  `extendedKeyUsage=serverAuth`, subject and authority key identifiers. Its names: the service's
  Compose name (`applier`, `steward`, `broker`) and `localhost`, as ruled; `127.0.0.1`, because
  clients on the box use the address (below); and every name in `GALATEA_TLS_NAMES`, the box's LAN
  name or address, for a client on another box. An entry that parses as an IPv4 or IPv6 address is
  written as `IP:`, any other as `DNS:`. Python 3.13's default strict verification refuses a
  CA whose `basicConstraints` is not critical, or a leaf without an authority key identifier, so the
  profile is written for it;
- issues again a certificate that is missing, that has 60 days or fewer left, whose names differ from
  the settings, or that the current CA did not sign; and leaves every other alone;
- writes keys mode 0600 under `secrets/`, certificates mode 0644 under `tls/`, and says what it
  issued. When it issued one and the stack runs, it restarts that service.

`galatea-prepare` calls it, so a first start is still one command. The CA's key is mounted into
nothing but the one-off certificate container.

**The MCP servers** get two read-only binds, their certificate and their key, and the CA's
certificate for their own health check. `main.ts` reads the files and passes PEM to `serveMcp`.

**The broker** serves `mqtts` on 8883 only: `listener 8883` with the CA, its certificate and its key,
bound file by file (`secrets/tls/broker.key`, `tls/broker.pem`, `tls/ca.pem`), never the whole
`secrets/tls/`, which holds the applier's and the steward's keys too;
`require_certificate false` (clients authenticate by password, now over TLS), and no plain listener.
`broker-init.sh` copies the key into its tmpfs owned by `mosquitto`, as it already does with the
password file, so the broker reads it whatever the order of its privilege drop. Its health check
connects to 8883.

**Clients trust the CA per link, each in its own way:**

| Client | How it trusts the CA |
|---|---|
| The steward, to its applier | `GALATEA_APPLIER_CA`, read by `main.ts`, held by the link's own undici agent (*The builds' entry points*) |
| The applier, to its broker | `GALATEA_BROKER_CA`, read by `main.ts`, passed as the MQTT connection's `ca` |
| The Zigbee bridge, to its broker | a `GALATEA_BROKER_CA` setting it does not have today (its `brokerFromEnv` passes `mqtts://` through, but its connect options carry no `ca`): **the Zigbee team's gap**. Until it lands, `NODE_EXTRA_CA_CERTS=/run/tls/ca.pem` in its service, which reaches only that process, whose one TLS connection is the broker's |
| The PC bridge on the desktop (stopgap) | `NODE_EXTRA_CA_CERTS` in its environment file (*The stopgap notice channel*); it has no CA option either. In that process the variable also reaches its plugin-package fetches, which are checked against their `sha256` before unpacking |
| The owner's tool | reads `tls/ca.pem` and passes it to each of its two links |
| A brain run as an agent | its own process's trust: `NODE_EXTRA_CA_CERTS` pointing at the copy of `ca.pem` that `galatea-secret --for` installed in the brain's account, the tool's own CA setting otherwise; never `NODE_TLS_REJECT_UNAUTHORIZED` |
| `galatea-register-steward`, the health checks | the CA file, in their one-off processes |
| The voice front, later | its own setting for its steward link (`httpx`'s `verify`) |

**Renewal.** A server certificate lives two years and is issued again by any `galatea-certs` run in
its last 60 days. Renewal is an owner's command, `bin/galatea-certs`, and a documented check: the
README's yearly checklist names it, and `galatea-certs --check` prints each certificate's days left.
The alarm is the health check, which turns its server unhealthy 14 days before expiry; the owner's
tool shows it. A server reads its certificate only at its start, so `galatea-certs` restarts what it
renewed. The CA lasts 10 years; `galatea-certs --new-ca` makes a new one, issues every certificate
again, and restarts every service that trusts the CA (the steward and the applier for their links,
the broker, the bridges), not only the servers; every agent and tool given the old `ca.pem` needs the
new one.

**Weighed.**
- *step-ca*, a running CA with ACME and automatic renewal: a daemon and a store of its own for three
  certificates. Rejected for now; it is the answer if certificates multiply (one per satellite, client
  certificates on the broker).
- *mkcert*: a development tool that installs its CA into the system's and browsers' trust stores,
  which is the process-wide (here, machine-wide) trust this design avoids. Rejected.
- *The host's `openssl`*: no image to build, but a dependency on whatever the box has (LibreSSL on
  some), and the owner's scripts so far need only a shell and Docker. Rejected.
- *A self-signed certificate per server, each pinned by its clients*: every renewal breaks every
  client. Rejected.
- *Name constraints on the CA*, so that an agent trusting it trusts nothing else: the CA's key sits in
  the owner's 0600 files, which the brain's account cannot read, and whoever can read them already
  holds every credential. Proportionate to leave out; revisit when the CA is trusted on other machines.
- *Client certificates on the broker* (identity from the certificate, as the bridge standard's
  *Connections* prefers): a certificate per identity to issue and renew. A password over TLS meets
  GA-BOX-1's "authenticates over TLS"; client certificates come with step-ca, if ever.
- *Mutual TLS between the steward and the applier*: the standards authenticate by bearer. Rejected.
- *Reloading certificates without a restart* (`setSecureContext` on a signal): a restart takes
  seconds and the steward reconnects on its own. Rejected (YAGNI).

## The broker's access rules

**What 4a has.** `broker-init.sh` writes `topic readwrite {root}/#` for `applier` and
`pattern readwrite {root}/bridges/%u/#` for everyone, every line of `instances` an identity.

**What this design writes.** One block per identity, with no `pattern` line, since a pattern applies
to every user. Topics carry the broker identity, as the bridge's own topics do:

```
user applier
topic read  {root}/bridges/+/status
topic read  {root}/bridges/+/lwt
topic read  {root}/bridges/+/devices
topic read  {root}/bridges/+/devices/+/status
topic read  {root}/bridges/+/devices/+/ack
topic read  {root}/bridges/+/reply
topic read  {root}/bridges/+/event
topic write {root}/bridges/+/devices/+/command
topic write {root}/bridges/+/request/+
topic read  {root}/finder/#

user bridge_zigbee
topic write {root}/bridges/bridge_zigbee/status
topic write {root}/bridges/bridge_zigbee/lwt
topic write {root}/bridges/bridge_zigbee/devices
topic write {root}/bridges/bridge_zigbee/devices/+/status
topic write {root}/bridges/bridge_zigbee/devices/+/ack
topic write {root}/bridges/bridge_zigbee/reply
topic write {root}/bridges/bridge_zigbee/event
topic read  {root}/bridges/bridge_zigbee/devices/+/command
topic read  {root}/bridges/bridge_zigbee/request/+
```

- The applier reads the whole bridge tree but commands and requests, and writes only those (bridge
  standard, *Who else may read*; GA-BUS-9): its grants are the topics `BRIDGE_TOPICS` names in its
  bus, and the two it publishes, unretained. It also reads `{root}/finder/#`: it subscribes to the
  finder's three topics (`FINDER_TOPICS`) on every connection, and without the grant discovery would
  read a finder fault. The finder's own identity comes later.
- A bridge writes everything in its tree but its commands and requests, and reads only those. It
  cannot write another bridge's tree, nor its own commands.
- Identities only for `applier` and `bridge_*` (and `finder` when one is built). The steward and
  every other build have none, so they are refused at CONNECT.
- `use_username_as_clientid true`: the ClientID is the identity (*Connections*), so a second client
  under a name takes the first one's session over visibly, through its will.
- `log_type information` and `connection_messages true`, so a refused CONNECT is in the log; a
  deployed fleet's broker refused tens of thousands of connections unnoticed without them.

**Weighed.**
- *Keeping the pattern line*: correct today only because the applier's and the steward's names match
  no registered bridge. Explicit blocks say what each may do and grant nothing by accident.
- *Dynamic security now*: see *Box and Safe*.

## Box and Safe

With `mqtts` the applier accepts `box: true` (GA-DESC-6), so the owner may claim Box and the applier
may claim Safe over its bridges. The applier's own Safe is built (slice 6), and the Zigbee bridge's
herdsman doer declares no `ungoverned` way. But `box: true` is the owner's word that the broker
passes GA-BOX-1 and that the box keeps GA-BOX-2's records, and two parts of that are still missing.
Until they are built, the owner should not set `box`, and first light runs at Act.

What still keeps Safe from first light, exactly:

- **Refusals the client sees (GA-BOX-1).** `acl_file` grants a denied subscription and filters at
  delivery (measured against Mosquitto). The broker must move to
  Mosquitto's dynamic-security plugin, which refuses with `0x87`, with each identity's grants as
  roles, generated from `instances` at each start as the ACL file is now.
- **The registration record and its verification (GA-BOX-2).** The box keeps a record of one applier
  per bridge identity (from `instances`), the finder's identity and its reader, and each reader's
  grants (none: the tool refuses every reader grant until a reader exists), refusing a second entry
  for a bridge. Each change to the grants, every broker start included, is verified by one forbidden
  and one permitted publish, and the verification is recorded in a file the check can replay.

The rest of GA-BOX-1 holds once this design is built: every client authenticates over TLS; the
applier and both bridges speak MQTT 5; a publish with no subscriber is answered `0x10`; only the
applier writes commands and requests, only bridge `{b}` reads its own and writes the rest of its
tree; no reader, rule engine or finder exists yet.

**Who builds it:** the steward team, as the installation's fourth plan, *Box* (*Plans*). It needs
no change to any build.

## How the owner and a brain reach the steward

**Two accounts.** The owner's tool runs as the owner's account, which owns the installation and its
`secrets/`. A brain runs under an account of its own (for example `galatea-brain`), with no sudo, not
in the `docker` group (that group can read every container's mounts), and unable to read `secrets/`
(mode 0700, the owner's). An agent tool with shell and file tools running as the owner could read
`secrets/mcp/steward-owner` and answer its own ask as the owner's app, or read the applier's owner
credential and register a client of its own; the separate account is what makes first light's
refusal mean something. A container that mounts only the brain's two files is the alternative.

**Anything running in the owner's account acts as the owner.** That is by design: owners have a direct
way in, through Claude Code or a tool of their own, with their own endpoint (the maintainer's ruling,
*Owners have a direct way in*). An agent the owner runs in that account can read the owner's
credentials and answer an ask as `owner-app`; first light's refusal proves that a brain's account
cannot, not that no agent can. So the owner's credentials live only in the owner's own accounts, and
the owner decides which agents run there. A copy on another machine goes only to an account of the
owner's where no unattended agent runs (a dedicated account on the desktop, say, not the one its
development agents use); or there is no copy, and the owner runs the tool on the box over `ssh`.

| Who (account) | URL from the box | Presents | Trusts |
|---|---|---|---|
| The owner's tool, to the steward (owner) | `https://127.0.0.1:18444/mcp` | the owner's app credential (`secrets/mcp/steward-owner`), at endpoint `owner-app` | `tls/ca.pem`, per link |
| The owner's tool, to the applier (owner) | `https://127.0.0.1:18443/mcp` | the applier's owner credential (`secrets/mcp/applier-owner`) | the same |
| A brain (the brain's) | `https://127.0.0.1:18444/mcp` | its brain credential, from its own copy, as `Authorization: Bearer` | its own copy of `ca.pem`, in its own process |
| The steward, to the applier | `https://applier:18443/mcp` | `secrets/mcp/steward-at-applier` | `GALATEA_APPLIER_CA`, per link |

- **Addresses.** Clients on the box use `127.0.0.1`, not `localhost`: Docker publishes on IPv4 only,
  and a client that resolves `localhost` to `::1` first may not fall back. `127.0.0.1` is in every
  certificate.
- **The brain's files.** `galatea-secret <id>` makes the credential in `secrets/mcp/<id>`, which the
  owner's tool reads to define it (`galatea credential <id> --kind brain [--confirm-on owner-app]`;
  a brain credential names no endpoint, since the endpoints name it in `served_by`). With
  `--for <account>` it also installs, in that account's configuration directory, a copy of the
  credential owned by that account, mode 0600, and a copy of `tls/ca.pem`, mode 0644 (through
  `sudo install`, the one step that needs root). The installation lives in the owner's home, which
  Debian makes 0700, so the brain's account could not reach `tls/` there; it reads its two copies and
  nothing of the installation. The agent tool gets the credential at
  launch: through the tool's header-helper command where it has one, otherwise by `${VAR}` expansion
  in its MCP configuration from a variable its launcher sets from the file. Which tools offer which is
  checked when the agent-brain is built.
- **The brain's endpoint** for first light is the owner's chat window: an `app` endpoint with
  `person: owner`, `served_by` the brain's credential, and `confirm_on: owner-app`. The credential's
  own `--confirm-on owner-app` is set too: the endpoint's `confirm_on` applies first, and the
  credential's covers any other endpoint the brain comes to serve without one. The model asks for
  the switch there; the ask goes to the owner's app (an `ask` event on `owner-app`); and the model's
  own `answer` is `not_permitted`. That refusal is GA-CONF-1's only when the answer is otherwise
  well formed: `judgeAnswer` (`confirm/answer.ts`) checks the plan is held, the principal, that the
  answer names only asked steps, and then, at a brain-served endpoint, the utterance record
  (GA-CONF-2), before it checks `confirm_on`; a bare answer is `invalid_request`. So the agent's
  answer carries a record as `first-light.mjs` builds one, at the chat endpoint,
  `addressed_by: typed` (allowed from an app), timed after the ask; the record passes, the endpoint is
  bound, and the `confirm_on` check refuses it `not_permitted` ("this plan is answered at owner-app
  only").
- **The owner's tool** reads the steward's `events` with a cursor and a long poll on the owner's
  credential, and so sees the `ask` event naming `owner-app` and its `plan_id`; it shows the plan's
  asked steps (from `outcome` or the plan's own record) before the owner says yes. Steward 0.11 makes
  the `ask` event carry the asked steps (the maintainer, 2026-10-07). It reads `tls/ca.pem` and
  reaches `https://127.0.0.1:1844x/mcp`. On another machine it gets `tls/ca.pem` and the two owner
  credentials only in an owner's account, as above. Its internals are the Zigbee team's.
- **Reach from the LAN** goes through override files the owner adds to `COMPOSE_FILE` in `.env`, each
  publishing one service on the box's LAN address (`GALATEA_LAN_ADDRESS`), never `0.0.0.0`, after the
  owner adds the name clients use to `GALATEA_TLS_NAMES` and runs `galatea-certs`.
  `compose.lan.yaml` publishes the broker only, for a bridge on another box (the stopgap). The steward
  gets its own override when the question of its LAN reach is answered; until then it is on loopback
  only. For a broker on the LAN, a second listener under `per_listener_settings` that accepts only the
  LAN bridges' identities would keep the applier's password from ever being accepted from the LAN; a
  backlog item, not first light's. Docker writes its own iptables rules, so a host
  firewall such as `ufw` does not filter a published port; the README says so, and that is why
  `compose.yaml` publishes on loopback only. A Compose port of an unset variable is an error, so the
  base file cannot express "unpublished unless set"; the override can.
- **The applier** stays on loopback: no brain and no other client reaches it (a brain is never an
  applier's client), only the owner's tool and `galatea-register-steward`.

## The stopgap notice channel

The steward refuses a `define` whose resulting house has no `notify` channel (GA-NOTE-1, GA-DEF-8):
`checkChannels` runs on the model after every change set, so on steward 0.10 every `define`, naming
included, is refused until a channel is set, and the first change set must set one. It may carry other
objects too; this runbook keeps it to the home alone, so the channel is in place before anything is
named. The channel must be an adopted device offering `notify.notify`. The Zigbee bridge offers none.
Steward 0.11 relaxes the bootstrap (DEF-a); until it is built, the PC bridge on the desktop is the
channel (the maintainer, 2026-10-07). **Every step in this section is removed once steward 0.11 is
built.**

On the box:
1. Add `bridge_pc_desktop` to `instances` and run `galatea-prepare`: a broker identity and password
   (and a store role it will not use, as every line gets).
2. Set `GALATEA_LAN_ADDRESS` and add the box's LAN name or address to `GALATEA_TLS_NAMES`; add
   `compose.lan.yaml` to `COMPOSE_FILE`; run `galatea-certs` (the broker's certificate gains the name)
   and `docker compose up -d`. The broker is now on `<LAN address>:8883`, `mqtts` only.

On the desktop (root):
3. Install the PC bridge as its design says: the package in `/usr/lib/galatea-pc-bridge`, the unit
   `galatea-pc-bridge.service`.
4. Copy `secrets/broker/bridge_pc_desktop` to `/etc/galatea-pc-bridge/credential`, root, 0600
   (GA-BRIDGE-64), and `tls/ca.pem` to `/etc/galatea-pc-bridge/ca.pem`.
5. Write `/etc/galatea-pc-bridge/environment`:
   `GALATEA_BROKER=mqtts://bridge_pc_desktop@<box name>:8883`, `GALATEA_ROOT=<root>`, and
   `NODE_EXTRA_CA_CERTS=/etc/galatea-pc-bridge/ca.pem`. The PC bridge has no CA option; the variable
   adds the CA to the bridge's own process only, since it starts its helpers and plugins' servers with
   an empty environment. So the stopgap uses `mqtts` with the CA copied to the desktop, and no plain
   listener is needed.
6. `systemctl enable --now galatea-pc-bridge`.

Back on the box:
7. With the owner's tool on the applier: `galatea register bridge pc-desktop --identity
   bridge_pc_desktop`; adopt the desktop's computer (class `computer`), with no name, since naming is
   the steward's and the steward takes nothing yet; and **before anything else** raise its
   `power.sleep`, `power.shutdown`, `power.cancel` and `session.lock` to `no_voice` through
   `configure` (`tier`). Adopting the computer offers those actions to every endpoint: the brain plans
   at an endpoint whose person is the owner, so its role is `owner`, and at the default tiers it could
   sleep or lock the desktop without asking (`power.sleep` and `session.lock` are `reversible`; only
   `power.shutdown` is `confirm`, which the owner would answer). At `no_voice` they are refused to any
   brain-served endpoint (GA-TIER-1), whatever the role, and stay open to the owner's app. Setting the
   computer's `infrastructure: true` does the same for sleep and shutdown, not for the lock.
8. With the owner's tool on the steward, at `owner-app`: the first `define`, the home alone, with
   `notice_channels` naming the computer (and `timezone`). Everything else is named after it.

What to expect: `notify` reaches the screen only through a helper in an unlocked graphical session.
While the desktop is locked, asleep or off, each `notify` is acked `failed(not_shown)`, and GA-NOTE-1
retries every applier notice at least every 60 s, without end, until one is shown. That is noise in
the steward's log and the applier's outcomes, not a fault.

## A runbook from an empty box to a confirmed switch

An outline for plan 4b, which writes the guide. Run from `reference/install/` on the Beelink.
The owner's tool's commands are its own design's.

1. **The box: the Beelink.** Docker with the Compose plugin (there already); the repository; an
   account for the brain (`sudo useradd -m galatea-brain`), with no sudo and not in `docker`.
2. **The gbench stack gives way** (the Zigbee team's, in plan C2): the coordinator takes one
   client, so the bench's bridge must stop before the installation's starts. Stop the gbench stack
   and its watcher (`docker compose down` in its directory; its volumes kept), and copy its Zigbee
   data directory for step 4. The bench's measurements end here. Moving the bench's own
   installation, made before this design, is more than two lines of `.env` (the Zigbee team's
   review of plan B; the install README's *Moving an installation made before the install-core
   plan*): set `GALATEA_SECRETS`, `GALATEA_TLS` and `GALATEA_SECRETS_BACKUPS` (the old
   `GALATEA_DB_SECRETS` and `GALATEA_BROKER_SECRETS` are refused); add `steward` to `instances`;
   bring the applier and steward images by `docker save` and `docker load`, since the box holds no
   repository; stop `gbench-watch`; and make the move at once. **No tool connects under a
   service's name:** a second client as `applier` or `bridge_*` takes over the service's session,
   and the two knock each other off every second.
3. **Settings.** `cp .env.example .env` and `cp instances.example instances`; in `.env`
   `GALATEA_UID`, `GALATEA_GID`, `COMPOSE_PROFILES=zigbee`, `GALATEA_ZIGBEE_COORDINATOR`, and
   `GALATEA_ZIGBEE_NO_ACTIONS=0`. That switch is all or nothing: lifting it lets the Fingerbot be
   commanded, and also lets plan 5b's polls and the battery-report configure reach the radar and the
   vibration sensor. It needs the maintainer's go for all of those writes. In `instances`: `applier`,
   `steward`, `bridge_zigbee`.
4. **The network.** The bench's `network.json`, `coordinator_backup.json` and `database.db` into
   `GALATEA_ZIGBEE_DATA`, mode 0600. No pairing: the bench's network carries over.
5. **Files.** `bin/galatea-prepare`: passwords, the MCP secrets, the CA and the three certificates.
6. **Start.** `docker compose up -d`; `docker compose ps -a` shows `postgres`, `broker`, `applier` and
   `steward` healthy, `db-init` and the two migrate services exited 0, `zigbee-bridge` running and
   ending its log with `ready`.
7. **Register.** `bin/galatea-register-steward`: within 5 s the steward's link is up (its `describe`
   shows the applier's revision); no restart. With the owner's tool:
   `galatea register bridge zigbee --identity bridge_zigbee`.
8. **The device.** With the owner's tool on the applier: `describe` lists the Fingerbot as
   `zigbee:<device>`, unadopted and live. Adopt it with class `light` (it stands in for a lamp's
   rocker). Its `onoff` actions exist only once the bridge knows its mode is `switch`, and a fresh
   install's bridge store does not hold that setting; the Zigbee team sets the mode in plan 4b (it
   leans to doing it through the steward after step 10). No tier is raised before the mode is known.
9. **The notice channel.** *The stopgap notice channel*, steps 1 to 8, until steward 0.11 is built.
10. **The house.** `galatea-secret brain_agent --for galatea-brain` (the credential and `ca.pem`,
    both into the brain's account). With the owner's tool on `owner-app`: a room for the Fingerbot;
    `galatea credential brain_agent --kind brain --confirm-on owner-app`; the brain's chat endpoint
    (`type: app`, `person: owner`, `served_by: brain_agent`, `confirm_on: owner-app`), in the same
    change set or after, since `served_by` names the credential.
11. **The tier.** Once the Fingerbot's mode is set and its `onoff` actions are described, `configure` a
    `tier` raising `onoff.turn_on` and `onoff.turn_off` to `confirm`.
12. **The brain.** As `galatea-brain`, the agent tool, configured with
    `https://127.0.0.1:18444/mcp`, its credential and its copy of `ca.pem`, plans the Fingerbot's switch at
    the chat endpoint: the plan's step is `ask(confirm_tier)`, and the owner's tool, following
    `events`, sees the `ask` on `owner-app`.
13. **The model answers.** The agent calls `answer` on that plan at the chat endpoint, with an
    utterance record (`addressed_by: typed`, timed after the ask): `not_permitted` (GA-CONF-1).
14. **The person answers.** The owner's tool answers `yes` on `owner-app`; the agent applies the plan;
    the Fingerbot presses; `outcome` and the steward's `history` show the step `acked` with the
    owner's answer as its cause.
15. **Backups.** `docker compose run --rm backup once` and `bin/galatea-backup-secrets`: a dump and an
    `install-<time>.tar` in `backups-secrets/`, both checked `ok`.

The bridge's health check is the Zigbee team's, in plan 4b.

## Plans

One spec, five plans. The roadmap orders the owner's tool, guided pairing first, before packaging and
the installation; this design does not change that order. A and B run beside the owner's tool; C1
needs only B; C2 waits for the owner's tool's first-light subset.

| Plan | Holds | Owner | Waits for |
|---|---|---|---|
| **A. The builds' entry points** | *The builds' entry points*, in the applier and the steward: `_FILE` twins and which wins, PEM into `serveMcp`, the steward's per-link CA (undici, which also changes how the mutation `trusts-any-applier` works), the applier's `GALATEA_BROKER_CA`, both `migrate-main.ts` | the steward team; the applier team reviews the applier's part | `feat/steward-harness-opt-in` merged (it carries the steward's `src/migrate-main.ts`); then the publication work merged, which rewrite comments and how scripts reach the harness |
| **B. The installation's core** | the images, the four services, `galatea-certs` and its image, the broker on `mqtts` and its rules, the health script, logging, `galatea-prepare`, `galatea-secret`, `galatea-register-steward`, `galatea-rotate-postgres`, `galatea-backup-secrets`, `compose.lan.yaml`, the README; their tests, and the existing install tests the move to `mqtts` changes (`broker.test.ts`, `zigbee-bridge.test.ts`, `zigbee-commands.test.ts`) | the steward team | A |
| **C1. First light, simulated** | `first-light.test.ts` against the installed stack; the agent-brain's connection | the steward team | B |
| **C2. First light in the flat** (plan 4b) | the gbench stack giving way, the stopgap channel (until steward 0.11), the runbook as 4b's guide, the Fingerbot's mode, the bridge's health check and CA option, the owner's tool's first-light subset | the Zigbee team | B; the owner's tool; the maintainer's go on the bench's writes |
| **D. Box** | *Box and Safe*: dynamic security, the registration record, the recorded verification. It replaces B's `acl_file` generation, and so rewrites B's broker test "a subscription the rules deny receives nothing" into a `0x87` refusal | the steward team | B; may land after first light |

**Plan A's checks**, for the applier's part (the applier team's list): a unit test for each twin
(unset, set, both set refused); the applier's clean conformance run; GA-SEC-1, GA-AUTH-1 to 5 and
GA-CFG-1 in a scoped run; `test:fast`. The steward's part runs its own clean conformance run and
GA-SEC-2 (which grades `trusts-any-applier`, now per link) and GA-BIND-2 scoped.

**What each build changes:**

- **The installation** (plan B): `compose.yaml` and `compose.lan.yaml`; `certs/Dockerfile`,
  `health/mcp-health.mjs`, `register/register-steward.mjs`; `bin/galatea-db-prepare` renamed
  `bin/galatea-prepare` (it prepares more than the store), with the MCP secrets, broker passwords for
  `applier` and `bridge_*` only, then `galatea-certs`; `bin/galatea-certs`, `galatea-secret`,
  `galatea-register-steward`, `galatea-rotate-postgres`, `galatea-backup-secrets`;
  `broker/broker-init.sh` (one block per identity, the key copied for `mosquitto`) and
  `broker/mosquitto.conf` (`mqtts` only, `use_username_as_clientid`, connection logging); the Zigbee
  bridge's service on `mqtts`; `README.md` (the restore order, the firewall, the yearly certificate
  check, the crontab line), `.env.example`, `instances.example`, `.gitignore` (`tls/` and
  `backups-secrets/` added); the scripts and tests that name `galatea-db-prepare`
  (`galatea-restore`'s advice, `prepare.test.ts`).
- **The applier** (plan A): `reference/applier/Dockerfile` and its allow-list; `src/main.ts`,
  `src/migrate-main.ts`, `src/mcp/server.ts`, the bus's connect options (`ca`); `README.md`'s
  environment table.
- **The steward** (plan A): `reference/steward/Dockerfile`; `src/main.ts`, `src/migrate-main.ts`,
  `src/mcp/server.ts`, `src/link/port.ts`, `undici` as a dependency; `README.md`'s environment table.
- **Documents that name the changed behaviour:** [`conformance/README.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/README.md)'s subject table (the `_FILE`
  twins), [`docs/specs/2026-10-06-harness-subject-lifecycle-design.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/docs/specs/2026-10-06-harness-subject-lifecycle-design.md) (the CA clause, two mentions),
  the maintainers' notes for adopters (the twins, `GALATEA_BROKER_CA`, the CA per link), and both
  builds' READMEs.
- **The Zigbee bridge and the owner's tool** (the Zigbee team): a `GALATEA_BROKER_CA` option in the
  bridge; the bridge's health check and the Fingerbot's mode in 4b; the owner's tool connecting as
  *How the owner and a brain reach the steward* says (`tls/ca.pem`, `127.0.0.1`, no `register steward`
  of its own), with, for first light, `galatea register bridge`, the applier's `describe` and `configure` (adopt, tier), `galatea credential`, and the
  steward's `describe`, `define`, `events`, `answer`, `outcome` and `history`.
- **The PC bridge:** no change for the stopgap. A `GALATEA_BROKER_CA` option is a backlog item, if
  the PC bridge outlives it.
- **The agent-brain** (the steward team): its MCP configuration names the steward's URL, presents
  its credential from its account's copy, trusts the CA in its own process, and builds its answer's
  utterance record.

## The security floor

What every part of this design keeps; the install's tests check each.

- No anonymous client on the broker and no MCP call without a registered bearer.
- Every MCP and MQTT connection inside the stack is TLS with the certificate validated against the
  installation's CA. The broker has no plain listener. Postgres, unpublished, on the stack's network,
  is the one plain link (*The applier and the steward as services*). Nothing in the installation sets
  `NODE_TLS_REJECT_UNAUTHORIZED`, and no build changes its process's trust for more than one link.
  The named exceptions use `NODE_EXTRA_CA_CERTS`: the Zigbee bridge until its option lands, whose one
  TLS connection is the broker's; and the stopgap PC bridge, whose are the broker's and its
  hash-pinned plugin-package fetches.
- No secret in `compose.yaml`, `.env`, a container's environment, a command line or a log. Secret
  files are the owner's, 0600, in 0700 directories. Each build's service (the applier, the steward,
  their migrate services, the Zigbee bridge) mounts only its own files; a missing file stops it from
  starting. The installation's own services (`postgres`, `db-init`, `backup`) mount `secrets/db/`;
  the broker mounts `secrets/broker/` and its own key, certificate and the CA's, file by file; none
  mounts `secrets/mcp/`, `secrets/ca/` or the rest of `secrets/tls/`.
- No service mounts the directory the secrets archive is written to.
- The CA's key is mounted into no running service.
- **The brain's account holds no credential but its own; the owner's credentials live only in the
  owner's account.** The brain's account cannot read `secrets/` or the owner's home, has no sudo, and
  is not in the `docker` group; it holds its credential and `ca.pem`. Anything in the owner's account
  acts as the owner, by design; owner credentials are copied only to the owner's own accounts, and
  the owner decides which agents run there.
- No model handles the steward's pair: its registration is a script.
- One secret per seam: no password, credential or key reused across two of them.
- The MCP ports are published on the host's loopback; the LAN only through `compose.lan.yaml`, on the
  box's LAN address, never `0.0.0.0`. Postgres is never published.
- Identities on the broker only for the applier and the bridges, each with the grants its role uses
  and no other.
- Backups hold secrets (the dumps and the Zigbee backup in `backups/`, the secrets archive in its own
  directory): both directories are the owner's alone.
- `box` is set only once plan D is built (*Box and Safe*).

## The test plan

Every test starts a throwaway stack against the real images and removes it, as the installation's
tests do; without Docker they fail, never skip. Each new file is one small stack; the package's whole
suite runs through `heavy.sh` (a workshop wrapper). Since the applier and the steward are under no profile, the tests
start the services they test by name, as the existing ones already do.

- **Certificates** (`certs.test.ts`): a CA is made once and a second run leaves it; each server's
  certificate verifies against it, from Node and from Python's `ssl` with its default strict flags,
  and carries the Compose name, `localhost`, `127.0.0.1` and the configured names; a certificate
  inside its last 60 days, or with changed names, is issued again and the others are not; every key
  is 0600 and owned by the owner, and every certificate under `tls/`; a `GALATEA_TLS_NAMES` holding
  a name and an address gives a `DNS:` and an `IP:` entry; the CA's key appears in no service's
  mounts (`docker compose config`).
- **The applier's service** (`applier.test.ts`): `applier-migrate` exits 0 and the applier turns
  healthy; from a client container, `describe` with the owner's credential over TLS against the CA
  answers; plain HTTP and a TLS client that does not trust the CA are refused; a wrong credential is
  `not_permitted`; a missing secret file stops the service with a message naming the setting and not
  the value; no secret value appears in `docker inspect`, `docker compose config` or the logs; the
  applier's broker link is `mqtts`, and `configure { box: true }` is accepted (then reverted).
- **The steward's service** (`steward.test.ts`): after `galatea-register-steward`, the steward follows
  the applier over TLS within 5 s, with no restart; with the CA file swapped for another CA's, the
  link is refused and logged and the steward still serves; the first owner's credential from its file
  reaches `describe`.
- **Registration** (`register.test.ts`): `galatea-register-steward` configures the steward's client
  once, a second run changes nothing, and no value appears in its output or in `ps`; `--rotate` leaves
  the steward following the applier with the new pair.
- **The broker** (`broker.test.ts`, extended): only 8883 answers, and a client that does not trust the
  CA is refused; the applier publishes a command and a request and reads a bridge's status, acks and
  the finder's topics; a bridge publishes its tree and receives its commands; a bridge's publish to
  another bridge's tree, or to its own command topic, is refused `0x87`; a subscription the rules
  deny receives nothing; the steward's name and an unknown name are refused at CONNECT and the
  refusal is in the log; a second client under one name takes the session over. Each probe pair, one
  forbidden and one permitted publish, is the check a reload must pass.
- **Secrets and backups** (`backup.test.ts`, extended): `galatea-backup-secrets` writes a checked
  archive with every secret file into its own directory, pruned to its count, and an encrypted one
  when a recipient is set; that directory is in no service's mounts, and the `backup` service mounts
  no `secrets/mcp/` or `secrets/ca/` (`docker compose config`); a restore into a fresh directory from the archive and the dump
  brings the applier up with the steward still registered. `galatea-rotate-postgres` leaves `db-init`
  and `backup` working with the new password, and a run killed after its `ALTER ROLE` is mended by
  running it again; `galatea-register-steward --rotate` with a failing `configure` leaves the steward
  on its old pair.
- **First light, simulated** (`first-light.test.ts`): steps 1 to 9 of the steward's first-light walk
  (`reference/steward/scripts/first-light.mjs`: an adopted notify channel; the owner's app and the
  brain's endpoint defined; the lamp's `onoff.turn_on` raised to `confirm`; the brain's plan asking;
  the ask on the owner's app; the brain's own answer refused `not_permitted`; the owner's yes; a
  token minted; the lamp on and the outcome relayed), against the installed stack, with the harness's
  simulated bridge as broker identity `bridge_sim` and bridge id `sim` in a test-only Compose file.
  Its `notify` device is the notice channel. The brain's endpoint is an `app` chat endpoint as in the
  runbook, its answer's record `addressed_by: typed`. The simulated bridge takes the system clock when
  `GALATEA_TIME_SOURCE` is unset (`clockFromEnv`), so it needs no time server, and the applier and
  the steward run on the system clock too. It needs `GALATEA_TEST_TRANSPORT` and so publishes a
  `testRunId`; whether an applier without a run id takes such a bridge is checked first, and if it
  does not, the test-only Compose file gives the test's processes the run id, never `compose.yaml`.
  A heavy run: through `heavy.sh` (a workshop wrapper), once per pull request.

The hand checks on the real box follow the runbook in plan 4b's guide.

## Not in this design

- Plan D's contents beyond *Box and Safe*'s list: the box's tool for reader grants, the finder.
- Postgres from other boxes (`hostssl`, the storage design's *Access from other boxes*); its
  certificate will come from this CA.
- The owner's tool's internals, the agent-brain's prompt and skills, the voice front's service.
- Packaging: registry images, version tags, an install guide for a second household.

## Open questions for the maintainer

Each with a recommendation; to be asked one at a time. (The box is ruled: the Beelink.)

- **Where does the secrets archive live?** **Recommended:** in its own directory on the box that no
  service mounts (`backups-secrets/`, 0700, the owner's), never in `backups/`, and encrypted with
  `age` to a key the owner keeps off the box, so a stolen disk or a shared NAS behind it holds nothing
  usable. The alternative, unencrypted in that directory, is simpler and leaves every secret readable
  to whoever gets the box's disk.
- **Is Box (plan D) built before first light, or after?** `mqtts` is in, so only dynamic security and
  the registration record with its verification keep `box: true` from being honest. **Recommended:
  after.** First light needs Act only; plan D needs no change to any build and can follow straight
  after, before any heater or socket cap relies on Safe.
- **Is the steward reachable from the LAN at first light?** **Recommended: no**, loopback only; the
  owner's tool and the brain's account are on the box. A steward override joins `compose.lan.yaml`'s
  broker one when the laptop or a brain on another machine needs it.
- **Is Postgres's plain link on the stack's network acceptable until access from other boxes?**
  **Recommended: yes**, since it is never published and its traffic stays in the box; `hostssl` from
  this CA comes with that access.
