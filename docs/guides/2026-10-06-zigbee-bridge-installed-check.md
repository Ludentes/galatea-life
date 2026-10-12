---
title: The Zigbee bridge installed — a hand check
status: draft
last_verified:
area: guides
audience: maintainer
author: Galatea maintainers
related:
  - docs/plans/2026-10-06-zigbee-bridge-4a-the-bridge-installed.md
  - docs/specs/2026-10-01-zigbee-bridge-design.md
  - reference/install/README.md
  - docs/guides/2026-10-04-zigbee-bridge-coordinator-bench.md
---

# The Zigbee bridge installed — a hand check

Plan 4a puts the Zigbee bridge into the installation's Compose file
(`reference/install/`), beside the store: its image, the broker it shares with the applier, its
role in Postgres, its data directory, and the owner's `form` and `backup`. This guide checks it by
hand, in two parts.

- **Read-only.** A throwaway stack on any box that reaches the coordinator, resuming the network the
  bench already has, with every action withheld (`GALATEA_ZIGBEE_NO_ACTIONS=1`). It changes nothing
  on the network. About 15 minutes.
- **For the final destructive suite.** `form` on a coordinator, for real.

The automated checks run without a coordinator: `pnpm --filter @ludentes/galatea-life-install test` (it needs
Docker, and builds the bridge's image).

## What you need

- Docker with the compose plugin, on a box whose route to the coordinator is the coordinator's own
  network. On a box with two networks, check which one the route uses:
  `ip route get <coordinator's address>` names the interface. Containers leave through the same
  route.
- Nothing else connected to the coordinator: it takes one TCP client. Stop any other bridge or
  spike on it first.
- The bench network's three files: `network.json`, `coordinator_backup.json` and `database.db`,
  from the data directory of the last bridge that ran it. They hold the network key: never print
  them, and keep them mode 0600.
- A clone of this repository, and a directory of its own for the throwaway stack (mode 0700), here
  `$B`.

## Read-only checks

### A throwaway stack

1. Settings, from `reference/install/` in the clone (`R` is that directory):

   ```bash
   R=$PWD
   B=~/zigbee-install-check; mkdir -p $B && chmod 700 $B
   cat > $B/.env <<EOF2
   GALATEA_UID=$(id -u)
   GALATEA_GID=$(id -g)
   GALATEA_BACKUPS=$B/backups
   GALATEA_SECRETS=$B/secrets
   GALATEA_TLS=$B/tls
   GALATEA_SECRETS_BACKUPS=$B/backups-secrets
   GALATEA_INSTANCES=$B/instances
   GALATEA_PGDATA_PREFIX=zcheck-pgdata
   GALATEA_ZIGBEE_DATA=$B/zigbee
   COMPOSE_PROFILES=zigbee
   GALATEA_ZIGBEE_COORDINATOR=tcp://<coordinator's address>:6638
   GALATEA_ZIGBEE_NO_ACTIONS=1
   EOF2
   printf 'applier\nbridge_zigbee\n' > $B/instances
   export COMPOSE_FILE=$R/compose.yaml COMPOSE_PROJECT_NAME=zcheck COMPOSE_ENV_FILES=$B/.env
   $R/bin/galatea-prepare
   ```

   **Expected:** lines naming the secrets it wrote, in `secrets/db/`, `secrets/broker/` and
   `secrets/mcp/`, then `ca made` and one `issued` line per server;
   `ls -ld $B/zigbee` shows `drwx------` and your name.

2. Copy the three network files into `$B/zigbee/`, then `chmod 600 $B/zigbee/*`.

### The bridge resumes the network, from its image

1. Start the store and the broker, then watch the bridge's topics as the applier would:

   ```bash
   docker compose up -d --wait postgres broker
   docker run --rm -i --network zcheck_default --entrypoint sh eclipse-mosquitto:2 \
     -c 'exec mosquitto_sub -h broker -V mqttv5 -u applier -P "$(cat)" -t "galatea/bridges/bridge_zigbee/#" -v' \
     < $B/secrets/broker/applier > $B/watch.txt &
   docker compose up -d zigbee-bridge
   docker compose logs -f zigbee-bridge
   ```

   **Expected:** the first `up` builds `galatea-zigbee-bridge:local` (a minute or two). The log
   shows herdsman opening a TCP socket to the coordinator twice (the network guard's read, then
   herdsman's resume) and ends with `ready`. No line says `refusing to start`.
2. Stop following the log (Ctrl-C). In `$B/watch.txt`:
   - `galatea/bridges/bridge_zigbee/devices`: each of the bench's devices, with its model and **no
     actions** (they are withheld);
   - `galatea/bridges/bridge_zigbee/status` every few seconds: `bridgeId` `bridge_zigbee`,
     `levels` `["Serve"]` only (the switch withholds Provision), `faults` `[]`, and the transport
     `zigbee` `up`. A device reads observable once it has reported since the start; a sleeping
     sensor may take its whole check-in interval.

   **If instead** the status names `no_network`, the files are not in `$B/zigbee/`;
   `invalid_network`, `network.json` is malformed; `network_mismatch`, the coordinator holds another
   network than the files say. Stop, and find out why before going on.

### The key never reaches a log

```bash
docker compose logs --no-log-prefix zigbee-bridge > $B/log.txt
```

Then count every form of the key in `$B/log.txt` and in `$B/watch.txt`, with the command in
`docs/guides/2026-10-04-zigbee-bridge-coordinator-bench.md`, *The key never reaches the log*
(`$B/zigbee/network.json` for its `network.json`, each file for its `bridge.log`). It never prints
the key. **Expected:** only zeros, for both files.

### A stop within its grace

```bash
time docker compose stop zigbee-bridge
docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' zcheck-zigbee-bridge-1
```

**Expected:** the stop takes well under 45 s (about 20 s on the bench); `0 false`. The log's last
lines say herdsman wrote the coordinator's backup, then `closing`. In `$B/watch.txt`, the last
status says `"state":"offline"` with `"graceful":true`, and `lwt` was cleared.

### The owner's backup

With the service stopped:

```bash
$R/bin/galatea-zigbee backup
ls -l $B/backups-secrets/zigbee/
```

**Expected:** `backed up network.json, coordinator_backup.json, database.db to
/backups/zigbee/zigbee-<time>.json` and the time the coordinator's backup was written. The file is
`-rw-------` and yours. While the service runs, the same command says `the bridge's service is
running: stop it first` and writes nothing: start it again (`docker compose start zigbee-bridge`)
and try.

### Taking it down

```bash
docker compose --profile zigbee down -v
```

`$B/zigbee/` now holds the newest coordinator backup and herdsman database: keep it as the bench's
data, or delete `$B` with the key in it.

## For the final destructive suite

### Forming a network from the install

On a coordinator whose network may be lost, with a fresh `$B/zigbee/` (no files in it) and the
service stopped:

```bash
$R/bin/galatea-zigbee form --channel <11 to 26>
```

**Expected:** the bridge's own `form`, as the coordinator guide's *Forming a network* describes,
run in a one-off container: it refuses a coordinator that holds a network unless
`--replace-network` is added, and on success writes `network.json` (0600) into `$B/zigbee/` and
prints the channel, the PAN id and the coordinator, never the key. Then `docker compose up -d`
starts the bridge on it.
