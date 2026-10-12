# The installation: its store, its broker, the applier, the steward and the Zigbee bridge

One Postgres for every Galatea Home build that keeps state, as
`docs/specs/2026-09-28-storage-design.md` designs it: one database, `galatea`,
with a role and a same-named schema for each running build, and a nightly,
checked backup. One broker, which the applier and the bridges share, on `mqtts`
only. The reference applier and steward, each with its one-off migration. And
the reference Zigbee bridge, for a home with a Zigbee coordinator.
`docs/specs/2026-10-07-install-core-design.md` designs the applier's and the
steward's services, the credentials and TLS.

| Service | What it does |
|---|---|
| `postgres` | The stock `postgres:18-alpine` image. No port is published: builds reach it as `postgres:5432` on the stack's network, the one plain link inside the stack |
| `db-init` | Runs on every `up`, then exits. Creates the role and schema of each instance in `instances`, and the read-only `reader` role. Never drops anything |
| `backup` | Dumps `galatea` every night at `GALATEA_BACKUP_AT`, restores the dump into a throwaway database to check it, keeps the last `GALATEA_BACKUP_KEEP`, and is unhealthy when the last check failed or the last good backup is over 25 h old |
| `broker` | The stock `eclipse-mosquitto:2` image, MQTT 5, on `mqtts` port 8883 only, with a certificate from the installation's CA. Identities for the applier and each bridge, each with its own password and its own grants; no anonymous client. No port is published |
| `applier-migrate`, `steward-migrate` | Run each build's migrations, then exit; a failing migration stops `docker compose up` with its error |
| `applier` | The reference applier, built from this repository, on `https://applier:18443/mcp`, published on `127.0.0.1:18443` |
| `steward` | The reference steward, on `https://steward:18444/mcp`, published on `127.0.0.1:18444`. It follows the applier once registered there (`bin/galatea-register-steward`) |
| `zigbee-bridge` | Only under the profile `zigbee`. The reference Zigbee bridge, built from this repository, on the coordinator `GALATEA_ZIGBEE_COORDINATOR` names |

The four build services run as your account (`GALATEA_UID`), which owns their
secret files. Every service's log is capped at three files of 50 MB.

## First start

Run every command in this file from `reference/install/`, as the account that
owns it (the owner's account). It needs Docker with the Compose plugin and a
shell; nothing else on the host.

1. Copy the examples, then edit them. Settings live in `.env`. Set
   `GALATEA_UID` and `GALATEA_GID` to your own `id -u` and `id -g`, because the
   services run as you and read your files:

   ```bash
   cp .env.example .env
   sed -i "s/^GALATEA_UID=.*/GALATEA_UID=$(id -u)/; s/^GALATEA_GID=.*/GALATEA_GID=$(id -g)/" .env
   cp instances.example instances
   ```

   In `instances`, keep the uncommented lines (`applier`, `steward`) and add
   one line for each other build that keeps state. `TZ` in `.env` sets the
   clock for `GALATEA_BACKUP_AT`.

2. Make every secret, the CA and the servers' certificates, and the backup
   directories:

   ```bash
   bin/galatea-prepare
   ```

   See *Secrets* and *Certificates* below for what it writes.

3. Start everything. The first `up` builds the applier's and the steward's
   images from this repository:

   ```bash
   docker compose up -d
   ```

4. Register the steward at the applier, once:

   ```bash
   bin/galatea-register-steward
   ```

   Within a few seconds `docker compose logs steward` says
   `the applier reached at MCP revision 2026-07-28`; nothing restarts.

5. Check it: `docker compose ps -a` shows `postgres`, `broker`, `applier` and
   `steward` healthy, `backup` running, and `db-init`, `applier-migrate` and
   `steward-migrate` exited 0.

## A build's connection

A build connects as its own role, with the password from `secrets/db/<id>`,
given as a file: `GALATEA_DATABASE_URL=postgres://<id>@postgres:5432/galatea`
and `GALATEA_DATABASE_PASSWORD_FILE` naming the file mounted into it.

Its tables land in its own schema without naming it, because the schema has
the role's name. It can't read another build's schema or create a schema. A
build's service in `compose.yaml` waits for its role:

```yaml
depends_on:
  db-init: { condition: service_completed_successfully }
```

## Adding a build

Add its id to `instances`, then:

```bash
bin/galatea-prepare
docker compose up -d
```

Removing a line doesn't remove the role or its data. That is kept on purpose.

## Secrets

Every secret is a file, made by `bin/galatea-prepare` (or `bin/galatea-secret`)
as 32 random letters and digits, readable by you alone (0600, in 0700
directories). None is ever in `compose.yaml`, `.env`, a service's environment,
a command line or a log, and a file that exists is never changed. Each service
mounts only its own files, and a missing one stops it from starting.

| File | What it is |
|---|---|
| `secrets/db/postgres`, `secrets/db/reader`, `secrets/db/<id>` | The store's superuser, the read-only role, each instance's role |
| `secrets/broker/applier`, `secrets/broker/bridge_*` | Each broker identity's password; never the store's. No other build has one |
| `secrets/mcp/applier-owner` | The applier's owner credential: the owner's tool and `galatea-register-steward` present it |
| `secrets/mcp/steward-owner` | The steward's first owner, made on an empty store; the owner's tool presents it at `owner-app` |
| `secrets/mcp/steward-at-applier`, `secrets/mcp/steward-token-key` | The steward's credential at the applier and the shared proof key |
| `secrets/mcp/<id>` | A brain's credential (`bin/galatea-secret`) |
| `secrets/ca/ca.key`, `secrets/tls/<server>.key` | The CA's key, mounted into nothing but the certificate tool's container; each server's key |
| `backups-secrets/zigbee/zigbee-<time>.json` | The Zigbee network's backup, with its key (`galatea-zigbee backup`) |

**A brain's credential.** A brain runs under an account of its own, with no
sudo and not in the `docker` group, which can read every container's mounts:

```bash
sudo useradd -m galatea-brain
bin/galatea-secret brain_agent --for galatea-brain
```

This makes `secrets/mcp/brain_agent`, which the owner's tool reads to define
the credential at the steward, and installs a copy of it and of `tls/ca.pem` in
`~galatea-brain/.config/galatea/`, owned by that account (through `sudo
install`). The brain's account reads those two files and nothing of the
installation. Anything running in your own account acts as you: copy the owner
credentials only to accounts of yours where no unattended agent runs.

**Rotating.**

- A store or broker password: delete its file, run `bin/galatea-prepare` and
  `docker compose up -d`, then restart the build (`db-init` sets the store's
  passwords at each run; the broker hashes its passwords at its start).
- The Postgres superuser: `bin/galatea-rotate-postgres`. The image reads its
  password file only when the database is first made, so replacing the file
  alone would lock `db-init` and the backups out. The script sets a new
  password from `secrets/db/postgres.next` over the container's local socket,
  then moves it over `postgres`. Stopped part way, it is mended by running it
  again.
- The steward's pair at the applier: `bin/galatea-register-steward --rotate`.
  It writes the new pair beside the old, configures it, and only then moves it
  over the old files and restarts the steward. A failed configure leaves the
  steward on its old pair, and the next run tries the new one again. The
  steward's calls are refused for the seconds before its restart: rotate while
  nothing waits for a person's yes.
- The applier's owner credential: replace the file and restart the applier.

## Certificates

Every connection inside the stack is TLS from one certificate authority the
installation makes, except Postgres's, which is never published and stays in
the box. `bin/galatea-certs` (which `galatea-prepare` runs) makes the CA once
(P-256, ten years) and issues the applier, the steward and the broker each a
certificate valid two years, for its Compose name, `localhost`, `127.0.0.1`
and every name in `GALATEA_TLS_NAMES`. openssl runs in a one-off container of
`certs/Dockerfile`. Keys land in `secrets/`, certificates in `tls/` (0644,
free to copy).

Clients on this box use `https://127.0.0.1:18443/mcp` (the applier) and
`https://127.0.0.1:18444/mcp` (the steward), trusting `tls/ca.pem` and nothing
else; `127.0.0.1`, not `localhost`, since Docker publishes on IPv4 only.

**Renewal.** Each run issues again a certificate that is missing, has 60 days
or fewer left, carries other names than the settings, or was not signed by the
current CA, and restarts the running service that holds it. A server's health
check turns it unhealthy 14 days before its certificate expires. Once a year:

```bash
bin/galatea-certs --check    # each certificate's days left
bin/galatea-certs            # issue what is due
```

The CA lasts ten years. `bin/galatea-certs --new-ca` makes a new one, issues
every certificate again, and restarts every service that trusts it; every tool
and agent given the old `tls/ca.pem` needs the new one.

## The broker

The broker serves `mqtts` on 8883 only, with its certificate from the
installation's CA; there is no plain listener. Its identities are `applier`,
each line of `instances` starting `bridge_`, and each watcher listed there,
each with its password from `secrets/broker/<id>`, and a client's ClientID is
its user name, so a second client under one name takes the first one's
session over. Its rules, written at each start, one block per identity:

- `applier` reads every bridge's status, will, roster, devices' statuses and
  acks, replies and events, and the finder's topics; it writes only commands
  and requests;
- `bridge_<x>` writes its own tree, `<root>/bridges/bridge_<x>/`, but its
  commands and requests, and reads only those;
- a watcher (`watch`, or `watch-<n>`) reads everything and writes nothing.

**Watchers.** A tool that only reads the broker (a bench monitor, a
`mosquitto_sub` while debugging) connects as a watcher. Add `watch` to
`instances`, or `watch-<n>` (lower-case letters and digits) for each one more
that runs at the same time, since two clients under one name take each other's
session over; run `bin/galatea-prepare` and restart the broker (`docker compose
restart broker`). The password is `secrets/broker/watch` (or `watch-<n>`); a
watcher has no store password, role or schema. Its publishes are refused
(`0x87`), so it cannot write a command, take a service's session over or leave a
will anyone hears. The broker has no port on the host, so a watcher joins the
stack's network, as the tests' clients do (`<project>` is the Compose project,
by default this directory's name):

```
docker run --rm -i --network <project>_default -v "$PWD/tls/ca.pem:/ca.pem:ro" \
  --entrypoint sh eclipse-mosquitto:2 -c 'exec mosquitto_sub -h broker -p 8883 \
  --cafile /ca.pem -V mqttv5 -u watch -P "$(cat)" -t "#" -v' <secrets/broker/watch
```

or, on another box, reaches it through `compose.lan.yaml` (*From the LAN*).

A publish outside a client's grants is refused (`0x87`). Refused connections
are in `docker compose logs broker`. A build connects as
`mqtts://<id>@broker:8883`, with its password from its file, trusting
`tls/ca.pem`. Retained messages survive a restart of the broker.

**No tool connects under a service's name.** Never run a watcher, a test
client or any other tool as `applier` or a `bridge_*` identity while that
service runs. The ClientID is the user name, so the tool and the service take
each other's session over, again and again, and every takeover fires the
service's will: the applier sees the bridge die each time. A tool that reads
connects as a watcher (*Watchers*), under a name of its own.

These rules are not yet the bridge standard's Box level: the broker grants a
subscription the rules deny and delivers nothing on it, where Box asks for a
refusal, and the box keeps no registration record. Leave the applier's `box`
unset until that is built.

**From the LAN.** A bridge on another box reaches the broker through
`compose.lan.yaml`, which publishes 8883 on the box's LAN address alone: set
`GALATEA_LAN_ADDRESS`, add the name or address the bridge uses to
`GALATEA_TLS_NAMES`, run `bin/galatea-certs`, add
`COMPOSE_FILE=compose.yaml:compose.lan.yaml` to `.env`, and run `docker
compose up -d`. Docker writes its own iptables rules, so a host firewall such
as `ufw` does not filter a published port; that is why `compose.yaml`
publishes only on loopback. The applier and the steward are not reachable from
the LAN.

## The Zigbee bridge

The bridge reaches its coordinator over TCP, so it runs on any box on the
coordinator's network.

1. Add `bridge_zigbee` to `instances`. In `.env`, set
   `COMPOSE_PROFILES=zigbee`, `GALATEA_ZIGBEE_COORDINATOR=tcp://<host>:<port>`
   and, on a network you are only reading, `GALATEA_ZIGBEE_NO_ACTIONS=1`.
2. Run `bin/galatea-prepare`. It also makes the bridge's data directory,
   `GALATEA_ZIGBEE_DATA` (`./zigbee`), yours and closed to others: it holds
   the network key.
3. A network: either bring one the bridge formed elsewhere (its `network.json`,
   `coordinator_backup.json` and `database.db`, mode 0600, into the data
   directory), or form one, once, with the service stopped:

   ```bash
   bin/galatea-zigbee form --channel 15
   ```

   `form` refuses when the coordinator already holds a network, unless you add
   `--replace-network`, which drops every device paired to that network.
4. `docker compose up -d`. The first `up` builds the bridge's image from this
   repository. `docker compose logs zigbee-bridge` ends with `ready`.

It reaches the broker as `mqtts://bridge_zigbee@broker:8883`. Until the bridge
has a CA option of its own, `NODE_EXTRA_CA_CERTS` gives its process the
installation's CA; its one TLS connection is the broker's. Its two passwords
are mounted from `secrets/`, its own and no other build's.
It runs as `GALATEA_UID`, which owns the data directory. A stop waits up to
45 s, because the bridge writes the coordinator's backup as it stops.

**Backing it up.** The nightly dump holds its schema, not its data directory.
Keep the directory with:

```bash
docker compose stop zigbee-bridge
bin/galatea-zigbee backup
docker compose start zigbee-bridge
```

The file lands in `backups-secrets/zigbee/` (`GALATEA_SECRETS_BACKUPS`), readable
by you only, never in `backups/`: it holds the network key. With
`GALATEA_SECRETS_RECIPIENT` set it is encrypted with `age`, and this box keeps no
readable copy. `bin/galatea-backup-secrets` takes the newest one into the
secrets archive. `form` and `backup` refuse while the
service runs, because the coordinator takes one client and the bridge's stop
writes a fresh backup. Each runs in a one-off container of the bridge's image,
on its data directory. Don't start the service while one runs.

## Backups

Dumps are written to `backups/` as `galatea-<time>.dump`, each with a
`.check` file saying `ok` or why it failed. `backups/status` holds the last
result. Pruning keeps the newest `GALATEA_BACKUP_KEEP` dumps, but never
deletes the newest dump whose check passed, so failed checks alone can't
remove your last good backup. A failed check makes the `backup` service
unhealthy, and so does a backup older than 25 h. Take one now with:

```bash
docker compose run --rm backup once
```

Audio is not in the database and not in these dumps. The dumps hold secrets:
the applier keeps the steward's credential and proof key in its store.

**The secrets archive.** A restore also needs the files that match the store:

```bash
bin/galatea-backup-secrets
```

writes `install-<time>.tar` of `secrets/`, `tls/`, `instances` and `.env` into
`GALATEA_SECRETS_BACKUPS` (`./backups-secrets`), a directory of yours that no
service mounts, never into `backups/`, which the backup service can write. It
checks that every file is in the archive, and keeps the newest
`GALATEA_BACKUP_KEEP`. Set `GALATEA_SECRETS_RECIPIENT` to an `age` public key
(`sudo apt install age`; `age-keygen` on a machine you keep the private key on)
and the archive is encrypted to it, as `install-<time>.tar.age`: the box then
keeps no readable copy, and a NAS behind that directory holds nothing it could
use. Run it nightly after the dump from your crontab (`crontab -e`), since the
box runs headless and a systemd user timer would need `loginctl
enable-linger`:

```
45 3 * * * cd /path/to/reference/install && bin/galatea-backup-secrets >>backups-secrets/cron.log 2>&1
```

## Restoring

```bash
bin/galatea-restore [--force] backups/galatea-<time>.dump
```

Before it stops anything, the script checks that the file is a readable
archive, and that every schema in it has a line in `instances`. Then it stops
every service but Postgres, restores the dump into a side database, and only
when that has worked replaces `galatea` with it. If the restore fails, the
current database is left as it was and the services start again. Last it
recreates what the dump lacks (instances added since) and starts everything.

A dump whose `.check` file doesn't say `ok` is refused. `--force` restores it
anyway, and overrides nothing else.

**On a new box,** in this order:

1. Unpack the secrets archive here (`age -d -i <key> install-<time>.tar.age |
   tar -x`, or `tar -xf` an unencrypted one): `secrets/`, `tls/`, `instances`
   and `.env`. Check the paths in `.env`.
2. `bin/galatea-prepare`: it writes nothing that is there, and keeps the CA and
   the certificates. Add the new box's LAN name to `GALATEA_TLS_NAMES` first if
   it changed.
3. `bin/galatea-restore backups/galatea-<time>.dump`. The steward is still
   registered at the applier: its credential is in the dump, and its files in
   the archive.
4. The Zigbee network, from the archive's `zigbee/zigbee-<time>.json`
   (decrypt a `.json.age` with your key first), into the bridge's empty data
   directory, with the service stopped:

   ```bash
   bin/galatea-zigbee restore backups-secrets/zigbee/zigbee-<time>.json
   ```

   It writes each file of the backup mode 0600, and refuses a data directory
   that already holds a network.

## Moving an installation made before the install-core plan

The bench's installation (the Zigbee bridge's plan 4a) set
`GALATEA_DB_SECRETS` and `GALATEA_BROKER_SECRETS`; every script now refuses
them. Its `secrets/db/` and `secrets/broker/` are already the layout
`GALATEA_SECRETS` expects, and `galatea-prepare` keeps every file that is there.
At the move, and not before (this `compose.yaml` against the old stack's
running services would bring the broker up on 8883 with no certificate):

1. Stop the old stack's watcher (`gbench-watch` on the bench): plain 1883 is
   gone, and it connects as `applier` (*No tool connects under a service's
   name*). Add `watch` to `instances` now; after step 5, point `gbench-watch`
   at `broker:8883` on the stack's network (or the LAN address, through
   `compose.lan.yaml`), trusting `tls/ca.pem`, as `watch` with
   `secrets/broker/watch` (*Watchers*), and start it again.
2. In `.env`: replace the two old settings with `GALATEA_SECRETS` (the
   directory holding `db/` and `broker/`), and set `GALATEA_TLS` and
   `GALATEA_SECRETS_BACKUPS` beside it, or their defaults land in this
   directory.
3. Add `steward` to `instances`: the applier and the steward run under no
   profile, and the steward's binds need its files.
4. On a box without this repository, load the images built elsewhere:
   `docker save galatea-applier:local galatea-steward:local
   galatea-zigbee-bridge:local | ssh <box> docker load`. `galatea-certs` builds
   its own image from `certs/` and pulls `alpine:3`.
5. `bin/galatea-prepare` (it also closes `secrets/` to 0700), `docker compose
   up -d`, `bin/galatea-register-steward`.
6. Move any Zigbee backup from `backups/zigbee/` to `backups-secrets/zigbee/`.

## Upgrading Postgres

```bash
bin/galatea-db-upgrade <new major>
```

The stack must be running, and `PG_MAJOR` must not be exported in your shell
(the script refuses if it is; keep it in `.env` only). This stops every service
but Postgres, dumps with the old major to
`backups/pre-upgrade-<old>-to-<new>-<time>.dump` (pruning never removes it),
switches `PG_MAJOR` in `.env`, and restores into a fresh volume for the new
major. The old volume (`galatea-pgdata-<old>`) is kept. To roll back, set
`PG_MAJOR` back in `.env` and run `docker compose up -d`; changes made since
the upgrade are lost, because the old volume doesn't have them. This works from
18 on; the 17 image kept its data in an anonymous volume of its own. If the
restore fails, the script prints where the dump is and how to go back. Once the new major has run
well for a while, remove the old volume with
`docker volume rm galatea-pgdata-<old>`.

## Not here yet

- Box (the bridge standard's level): Mosquitto's dynamic security, so that a
  denied subscription is refused, and the box's registration record and its
  recorded verification.
- Access to Postgres from other boxes (`hostssl`, from this CA).
- The steward on the LAN: an override of its own, when a laptop or a brain on
  another machine needs it.
- The owner tool will wrap these scripts (`galatea restore`, and so on).

## Tests

`pnpm --filter @ludentes/galatea-life-install test` needs Docker with the compose plugin.
The tests start throwaway stacks against the real images, pulling
`postgres:17-alpine`, `postgres:18-alpine`, `eclipse-mosquitto:2`, `alpine:3`
and `python:3.13-alpine` (for its strict certificate check), building the
applier's, the steward's and the Zigbee bridge's images, and remove them. Each
stack has its own Compose project and its own published ports, so files run
side by side. No test reaches a
coordinator: the bridge's are checked against one that isn't there. Without Docker
they fail; they are never skipped. The root `pnpm test` runs them too.

`test/first-light.test.ts` walks first light on a simulated home: from an empty
directory to a brain's switch and a confirmation the brain's own answer cannot
give, with the harness's simulated bridge in place of the Zigbee one. It adds
`test/sim/compose.sim.yaml`, a test-only file no installation uses: the
simulated bridge (identity `bridge_sim`, run from this checkout's built
packages, so `pnpm -r build` first) and, through a wrapper around
`broker-init.sh`, its test transport's grants and the test's own identity on
them, `sim_control`. The production rules are unchanged, and no test client
connects under a service's name. The brain is run by
`reference/agent-brain`'s own launcher, as an account holding only its
credential and `ca.pem`.
