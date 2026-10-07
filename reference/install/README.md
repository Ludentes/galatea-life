# The installation: its store, its broker and the Zigbee bridge

One Postgres for every Galatea Home build that keeps state, as
`docs/specs/2026-09-28-storage-design.md` designs it: one database, `galatea`,
with a role and a same-named schema for each running build, and a nightly,
checked backup. One broker, which the applier and the bridges share. And the
reference Zigbee bridge, for a home with a Zigbee coordinator.

| Service | What it does |
|---|---|
| `postgres` | The stock `postgres:18-alpine` image. No port is published: builds reach it as `postgres:5432` on the stack's network |
| `db-init` | Runs on every `up`, then exits. Creates the role and schema of each instance in `instances`, and the read-only `reader` role. Never drops anything |
| `backup` | Dumps `galatea` every night at `GALATEA_BACKUP_AT`, restores the dump into a throwaway database to check it, keeps the last `GALATEA_BACKUP_KEEP`, and is unhealthy when the last check failed or the last good backup is over 25 h old |
| `broker` | The stock `eclipse-mosquitto:2` image, MQTT 5. Each instance is an identity with its own password; no anonymous client. No port is published: builds reach it as `broker:1883` |
| `zigbee-bridge` | Only under the profile `zigbee`. The reference Zigbee bridge, built from this repository, on the coordinator `GALATEA_ZIGBEE_COORDINATOR` names |

## First start

Run every command in this file from `reference/install/`.

1. Copy the examples, then edit them. Settings live in `.env`. Set
   `GALATEA_UID` and `GALATEA_GID` to your own `id -u` and `id -g`, because the
   backup service writes `backups/` as that user:

   ```bash
   cp .env.example .env
   sed -i "s/^GALATEA_UID=.*/GALATEA_UID=$(id -u)/; s/^GALATEA_GID=.*/GALATEA_GID=$(id -g)/" .env
   cp instances.example instances
   ```

   In `instances`, keep the uncommented lines (`applier`, `steward`) and add
   one line for each other build that keeps state. `TZ` in `.env` sets the
   clock for `GALATEA_BACKUP_AT`.

2. Make a password for `postgres`, `reader` and each instance, a broker
   password for each instance, and the backups directory:

   ```bash
   bin/galatea-db-prepare
   ```

   Passwords are written to `secrets/db/` and `secrets/broker/`, readable by
   you only, and one that exists is never changed. A build's broker password is
   never its store password. The backups directory must be yours: Docker would
   create a missing one as root, and the backup service could not write to it.

3. Start the store:

   ```bash
   docker compose up -d
   ```

4. Check it: `docker compose ps` shows `postgres` and `broker` healthy and
   `backup` running. `docker compose logs db-init` ends with `db-init: ready`,
   and `docker compose logs broker` starts with `broker-init: ready`.

## A build's connection

A build connects as its own role, with the password from `secrets/db/<id>`:

```
postgres://<id>:<password>@postgres:5432/galatea
```

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
bin/galatea-db-prepare
docker compose up -d
```

Removing a line doesn't remove the role or its data. That is kept on purpose.

## The broker

Every line of `instances` is also an identity on the broker, of the same name,
with its password in `secrets/broker/<id>`. The broker's rules, written at each
start:

- `applier` reads and writes everything under `GALATEA_ROOT` (`galatea` unless
  `.env` says otherwise);
- every other identity reads and writes only `<root>/bridges/<its id>/#`, which
  holds every topic a bridge uses.

A build connects as `mqtt://<id>@broker:1883`, with its password from its file.
Retained messages survive a restart of the broker. Access from other boxes on
the LAN, with TLS, waits for the installation's certificate authority, as the
store's does. These rules are not the bridge standard's Box level: who may read
which device is not yet the owner's grant.

## The Zigbee bridge

The bridge reaches its coordinator over TCP, so it runs on any box on the
coordinator's network.

1. Add `bridge_zigbee` to `instances`. In `.env`, set
   `COMPOSE_PROFILES=zigbee`, `GALATEA_ZIGBEE_COORDINATOR=tcp://<host>:<port>`
   and, on a network you are only reading, `GALATEA_ZIGBEE_NO_ACTIONS=1`.
2. Run `bin/galatea-db-prepare`. It also makes the bridge's data directory,
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

Its two passwords are mounted from `secrets/`, its own and no other build's.
It runs as `GALATEA_UID`, which owns the data directory. A stop waits up to
45 s, because the bridge writes the coordinator's backup as it stops.

**Backing it up.** The nightly dump holds its schema, not its data directory.
Keep the directory with:

```bash
docker compose stop zigbee-bridge
bin/galatea-zigbee backup
docker compose start zigbee-bridge
```

The file lands in `backups/zigbee/`, readable by you only. It holds the network
key: keep it as you keep `secrets/`. `form` and `backup` refuse while the
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

Audio is not in the database and not in these dumps.

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

To restore on a new box, bring `instances` (with every schema the dump holds)
and `.env`, then run `bin/galatea-db-prepare` and the script. Bringing
`secrets/db/` too keeps the builds' passwords the same. Keep copies of all
three next to the backups, because the dumps hold none of them.

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

- Access from other boxes on the LAN (TLS, `pg_hba.conf`, the broker's TLS)
  waits for the installation's certificate authority.
- The applier and the steward as services: they join this file when they are
  packaged, with their passwords from `secrets/` as the Zigbee bridge has.
- The owner tool will wrap these scripts (`galatea restore`, and so on).

## Tests

`pnpm --filter @ludentes/galatea-life-install test` needs Docker with the compose plugin.
The tests start throwaway stacks against the real images, pulling
`postgres:17-alpine`, `postgres:18-alpine` and `eclipse-mosquitto:2` and
building the Zigbee bridge's image, and remove them. No test reaches a
coordinator: the bridge's are checked against one that isn't there. Without Docker
they fail; they are never skipped. The root `pnpm test` runs them too.
