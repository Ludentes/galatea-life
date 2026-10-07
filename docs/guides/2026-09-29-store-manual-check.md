---
title: Checking the installation's store by hand
status: current
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/specs/2026-09-28-storage-design.md
  - reference/install/README.md
---

# Checking the installation's store by hand

After the automated tests pass, this walks the store as an owner meets it: first start, a build's
connection, a backup, a restore, a failure, and an upgrade. Run every command from
`reference/install/`. It takes about fifteen minutes and needs Docker.

## Before you start

```bash
cd reference/install
docker compose ps
```

Expected: nothing running. If a `galatea` stack is already running here, stop now: this guide
creates and deletes the `galatea-pgdata-*` volumes.

## First start

1. `cp .env.example .env`, then set `GALATEA_UID` and `GALATEA_GID` to the output of `id -u` and
   `id -g`:

   ```bash
   sed -i "s/^GALATEA_UID=.*/GALATEA_UID=$(id -u)/; s/^GALATEA_GID=.*/GALATEA_GID=$(id -g)/" .env
   ```
2. `cp instances.example instances`
3. `bin/galatea-db-prepare`. Expected: four lines, `wrote …/secrets/db/postgres`, `reader`,
   `applier` and `steward`.
4. `ls -l secrets/db`. Expected: every file `-rw-------` and owned by you.
5. `docker compose up -d`, then `docker compose ps`. Expected: `postgres` healthy, `backup`
   running (its health is `starting` for up to 10 min).
6. `docker compose logs db-init`. Expected: the last line is `db-init: ready (2 instances)`.
7. Wait until `docker compose logs backup` shows a line ending `: ok`, then `ls backups`. Expected: one `galatea-<time>.dump`, its `.check`, and `status`, all owned by you.
   The first backup is taken at start because none existed.

## A build's view

1. Connect as the applier, from a container on the stack's network:

   ```bash
   PGPASSWORD="$(cat secrets/db/applier)" docker run --rm -it --network galatea_default -e PGPASSWORD \
     postgres:18-alpine psql -h postgres -U applier -d galatea
   ```

2. In psql:
   - `CREATE TABLE t (x int); INSERT INTO t VALUES (1);` Expected: works.
   - `SELECT current_schema();` Expected: `applier`.
   - `CREATE TABLE steward.x (y int);` Expected: `permission denied for schema steward`.
   - `CREATE SCHEMA other;` Expected: `permission denied for database galatea`.
   - `\q`
3. Repeat step 1 with a wrong password (`-e PGPASSWORD=wrong`). Expected: `password authentication
   failed for user "applier"`.
4. `docker compose port postgres 5432`. Expected: `:0`, because no port is published.

## Adding a build

1. Add a line `voice_kitchen` to `instances`.
2. `bin/galatea-db-prepare`. Expected: only `wrote …/voice_kitchen`.
3. `docker compose up -d`, then `docker compose logs db-init | tail -1`. Expected:
   `db-init: ready (3 instances)`.
4. Remove the line again and run `docker compose up -d`. Then connect as `voice_kitchen` (step 1 of
   *A build's view*, with its name). Expected: it still logs in. Nothing is dropped.

## A backup and a restore

1. `docker compose run --rm backup once`. Expected: `backup: galatea-<time>.dump: ok`.
2. Connect as the applier and run `DELETE FROM t;`.
3. `bin/galatea-restore "$(ls -t backups/galatea-*.dump | head -n 1)"`, which picks the newest dump
   (step 1's). Expected: it stops `backup`, restores, runs
   `db-init` and ends `galatea-restore: restored galatea-<time>.dump`.
4. Connect as the applier and run `SELECT * FROM t;`. Expected: the row `1` is back.
5. `docker compose ps`. Expected: `postgres` and `backup` running again.

## A failing backup

1. As the superuser, make an empty migrations table:

   ```bash
   docker compose exec postgres psql -U postgres -d galatea \
     -c 'CREATE TABLE applier.migrations (id int)'
   ```

2. `docker compose run --rm backup once`. Expected: exit code 1 and
   `applier.migrations is empty`.
3. `cat backups/status`. Expected: it starts `failed`.
4. `docker compose run --rm backup health; echo $?`. Expected: `1`.
5. Clean up: `docker compose exec postgres psql -U postgres -d galatea -c 'DROP TABLE applier.migrations'`,
   then `docker compose run --rm backup once`. Expected: `ok` again.

## An upgrade

This goes down to 17 first, so there is an upgrade to make. The rollback is covered in the README only.

1. `docker compose down -v`, set `PG_MAJOR=17` in `.env`, then `docker compose up -d`. Connect as
   the applier and create `t` with a row, as in *A build's view*.
2. `bin/galatea-db-upgrade 18`. Expected: it ends `now on 18; the 17 volume is kept for a rollback`.
3. `grep PG_MAJOR .env`. Expected: `PG_MAJOR=18`. Then `ls -l backups/pre-upgrade-*`. Expected: the
   dump is `-rw-------`.
4. Connect as the applier and `SELECT * FROM t;`. Expected: the row is there.
5. `docker volume ls | grep galatea-pgdata`. Expected: both `galatea-pgdata-17` and
   `galatea-pgdata-18`. (The 17 image keeps its data in an anonymous volume of its own, so a
   rollback to 17 would start empty. From 18 on, the named volume holds the data, and a rollback
   finds it.)
6. `bin/galatea-db-upgrade 18`. Expected: `already on 18`, and nothing changes.

## Clean up

```bash
docker compose down -v
docker volume rm galatea-pgdata-17
rm -rf .env instances secrets backups
```

Removing `backups` also deletes any pre-upgrade dump. The 17 image keeps its data in an anonymous volume of its own. `docker volume prune` removes it,
along with any other unused anonymous volumes on this machine, so run it only if that's fine.
