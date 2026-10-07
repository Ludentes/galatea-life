import { lstat, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { coordinatorFromEnv, PINS_FILE, privateDirProblem } from "../entry.js";
import { ensureStateDir, InstanceError, InstanceLock } from "../instance-lock.js";
import { redact } from "./log.js";
import { predict as readCoordinator, type Prediction } from "./network-guard.js";
import { NETWORK_FILE, newNetwork, type Network, readNetwork, writeNetwork } from "./network.js";
import { BACKUP_FILE, DATABASE_FILE, herdsmanStack, type MakeStack, type StackEvents } from "./stack.js";

/**
 * The owner's commands (the design, *The network guard*): `zigbee-bridge form --channel N` forms the
 * network, the one thing the bridge never does on its own; `zigbee-bridge backup --out FILE` copies
 * the data directory's network, coordinator backup, herdsman's database and PINs into one file for
 * the owner to keep. Each takes the bridge's own lock on the data directory, so it refuses while the
 * bridge runs (the coordinator takes one TCP client, and the bridge's stop writes a fresh coordinator
 * backup), and the bridge cannot start while it works.
 */

/** Where a command writes what it has to say: a line to its output, a line to its error. */
export interface Say {
  out(line: string): void;
  err(line: string): void;
}

/** A command's end: 0 done, 1 failed under way, 2 refused before anything was done. */
export type Exit = 0 | 1 | 2;

export interface FormOptions {
  /** The bridge's private data directory (GALATEA_STATE_DIR). */
  dataDir: string;
  /** The coordinator, `tcp://host:port` (GALATEA_ZIGBEE_COORDINATOR). */
  coordinator: string;
  channel: number;
  say: Say;
  /** The stack; herdsman's unless given (tests). */
  makeStack?: MakeStack;
  /** Random bytes for the network; Node's unless given (tests). */
  random?: (n: number) => Buffer;
  /** The owner's word that the network the coordinator holds may be replaced (`--replace-network`). */
  replaceNetwork?: boolean;
  /** What the network guard reads from the coordinator (`network-guard.ts`'s `predict`, read-only); its own unless given (tests). */
  predict?: (coordinator: string, network: Network, backupPath: string) => Promise<Prediction>;
}

/** herdsman's files, and the owner's network, whose presence means a network was formed here already. */
const FORMED = [NETWORK_FILE, BACKUP_FILE, DATABASE_FILE] as const;

/** The coordinator's IEEE address before herdsman formed the network: not known, and never used (the form sends no health exchange). */
const NOT_YET_KNOWN = "0x0000000000000000";

/**
 * Forms a network on `channel`: refuses outside 11 to 26, in a data directory that does not exist
 * (it makes none, so a mistyped GALATEA_STATE_DIR forms nothing) or that other accounts can read,
 * while the bridge runs, or where a network, a coordinator backup or herdsman's database is already
 * there. Then it reads the coordinator with the network guard (read-only): it refuses when the
 * coordinator cannot be read, and when it holds a network, naming its channel, unless the owner says
 * `--replace-network` (plan 2c-3 review I2), since herdsman given a new network and no backup forms
 * over whatever the coordinator holds. Otherwise it starts herdsman with a fresh network
 * (`newNetwork`), which must form it (`reset`), and writes `network.json` (mode 0600) with the
 * coordinator's IEEE address. herdsman writes the coordinator's backup as it forms; one is taken if it
 * did not. Nothing said quotes the network key.
 */
export async function form(o: FormOptions): Promise<Exit> {
  const { dataDir, say } = o;
  if (!Number.isInteger(o.channel) || o.channel < 11 || o.channel > 26) {
    say.err("refusing to form: the channel is 11 to 26 (zigbee-bridge form --channel N)");
    return 2;
  }
  if (!(await exists(dataDir))) {
    say.err(`refusing to form: ${dataDir} does not exist (the owner makes it, mode 0700, and sets GALATEA_STATE_DIR to it)`);
    return 2;
  }
  const lock = await locked(dataDir, say, "form");
  if (!lock) return 2;
  try {
    for (const name of FORMED) {
      if (await exists(join(dataDir, name))) {
        say.err(`refusing to form: ${name} is there already: a network was formed here (the owner removes the data directory's files to form again)`);
        return 2;
      }
    }
    const fresh = newNetwork(o.channel, o.random);
    let held: Prediction;
    try {
      held = await (o.predict ?? readCoordinator)(o.coordinator, { ...fresh, coordinator: NOT_YET_KNOWN }, join(dataDir, BACKUP_FILE));
    } catch (err) {
      say.err(`refusing to form: the coordinator was not read (${redact(String((err as Error)?.message ?? err))})`);
      return 2;
    }
    if (held.channel !== null) {
      if (!o.replaceNetwork) {
        say.err(`refusing to form: the coordinator holds a network on channel ${held.channel}: forming replaces it, and every device paired to it`
          + " must be paired again (zigbee-bridge form --channel N --replace-network)");
        return 2;
      }
      say.err(`zigbee-bridge form: replacing the network the coordinator holds on channel ${held.channel}, as --replace-network says`);
    }
    const events: StackEvents = {
      // A refusal would send the device a Leave Request: nothing is refused, and no window is open.
      joining: async () => true,
      joined() {},
      interviewed() {},
      left() {},
      heard() {},
      disconnected() {},
    };
    const stack = (o.makeStack ?? herdsmanStack)({ coordinator: o.coordinator, dataDir, network: { ...fresh, coordinator: NOT_YET_KNOWN } },
      events);
    try {
      let result: string;
      try {
        result = await stack.start();
      } catch (err) {
        say.err(`zigbee-bridge form: herdsman's start failed: ${redact(String((err as Error)?.message ?? err))}`);
        return 1;
      }
      if (result !== "reset") {
        say.err(`zigbee-bridge form: herdsman's start ${result} a network instead of forming one; network.json is not written`);
        return 1;
      }
      const coordinator = stack.coordinatorEndpoint()?.deviceIeeeAddress;
      if (!coordinator) {
        say.err("zigbee-bridge form: herdsman named no coordinator; network.json is not written");
        return 1;
      }
      if (!(await exists(join(dataDir, BACKUP_FILE))) && !(await stack.backup())) {
        say.err("zigbee-bridge form: the coordinator's backup was not written; network.json is written, and the bridge's stop takes one");
      }
      const network: Network = { ...fresh, coordinator };
      await writeNetwork(dataDir, network);
      say.out(`formed a network on channel ${network.channel}, PAN id 0x${network.panID.toString(16).padStart(4, "0")}, coordinator ${coordinator}`);
      return 0;
    } finally {
      await stack.close();
    }
  } finally {
    await lock.release();
  }
}

/** The bridge's lock on its private data directory, or a refusal said: another account can read it, or a bridge (or a command) holds it. */
async function locked(dataDir: string, say: Say, what: string): Promise<InstanceLock | undefined> {
  try {
    ensureStateDir(dataDir);
    const exposed = privateDirProblem(dataDir);
    if (exposed) {
      say.err(`refusing to ${what}: ${exposed}`);
      return undefined;
    }
    return await InstanceLock.acquire(dataDir);
  } catch (err) {
    if (!(err instanceof InstanceError)) throw err;
    say.err(`refusing to ${what}: ${err.message}: stop the bridge first (its stop writes the coordinator's backup)`);
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** What a backup holds, in this order; the owner's network must be there. */
const KEPT = [NETWORK_FILE, BACKUP_FILE, DATABASE_FILE, PINS_FILE] as const;

/** The backup's own format, so that a reader knows the file. */
export const BACKUP_FORMAT = "galatea-zigbee-bridge-backup";

export interface BackupOptions {
  /** The bridge's private data directory (GALATEA_STATE_DIR). */
  dataDir: string;
  /** The file to write: never over one there. */
  out: string;
  say: Say;
  /** The time, for the backup's `takenAt`. */
  now?: () => number;
}

/**
 * Copies the data directory's network (`network.json`), the coordinator's backup, herdsman's database
 * and the owner's PINs, those of them there, into one file at `out`, mode 0600, never over one there:
 * the owner's to keep, holding the network key and the PINs in clear. Refuses while the bridge runs,
 * in a data directory other accounts can read, and where the owner's network is missing or cannot be
 * read. Says when the coordinator's backup was written, never what any file holds.
 */
export async function backup(o: BackupOptions): Promise<Exit> {
  const { dataDir, say } = o;
  const lock = await locked(dataDir, say, "back up");
  if (!lock) return 2;
  try {
    const network = await readNetwork(dataDir);
    if ("fault" in network) {
      say.err(`refusing to back up: ${network.detail}`);
      return 2;
    }
    const files: Record<string, string> = {};
    for (const name of KEPT) {
      if (await exists(join(dataDir, name))) files[name] = await readFile(join(dataDir, name), "utf8");
    }
    const taken = new Date((o.now ?? Date.now)()).toISOString();
    try {
      await writeFile(o.out, `${JSON.stringify({ format: BACKUP_FORMAT, version: 1, takenAt: taken, files })}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      say.err(`zigbee-bridge backup: ${o.out} was not written (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      return 1;
    }
    say.out(`backed up ${Object.keys(files).join(", ")} to ${o.out}`);
    if (files[BACKUP_FILE] === undefined) say.err("zigbee-bridge backup: there is no coordinator backup: start the bridge and stop it, which writes one");
    else say.out(`the coordinator's backup was written ${new Date((await stat(join(dataDir, BACKUP_FILE))).mtimeMs).toISOString()}`);
    return 0;
  } finally {
    await lock.release();
  }
}

const USAGE = "usage: zigbee-bridge form --channel N [--replace-network] | zigbee-bridge backup --out FILE";

/** What the command line's `form` may be given in place of herdsman's own (tests). */
export type Seams = Pick<FormOptions, "makeStack" | "predict">;

/**
 * The command line, run: `form --channel N [--replace-network]` or `backup --out FILE`, with
 * GALATEA_STATE_DIR (and, to form, GALATEA_ZIGBEE_COORDINATOR) from the environment.
 */
export async function run(argv: string[], env: NodeJS.ProcessEnv, say: Say, seams: Seams = {}): Promise<Exit> {
  const [command, ...rest] = argv;
  if (!env.GALATEA_STATE_DIR) {
    say.err("GALATEA_STATE_DIR names the bridge's data directory");
    return 2;
  }
  if (command === "form") {
    const replaceNetwork = rest.includes("--replace-network");
    const args = rest.filter((a) => a !== "--replace-network");
    if (rest.length - args.length > 1 || args.length !== 2 || args[0] !== "--channel" || !/^[0-9]{1,2}$/.test(args[1]!)) {
      say.err(USAGE);
      return 2;
    }
    const coordinator = coordinatorFromEnv(env.GALATEA_ZIGBEE_COORDINATOR);
    if ("refused" in coordinator) {
      say.err(`refusing to form: ${coordinator.refused}`);
      return 2;
    }
    return form({ dataDir: env.GALATEA_STATE_DIR, coordinator: coordinator.coordinator, channel: Number(args[1]), say, replaceNetwork,
      ...(seams.makeStack ? { makeStack: seams.makeStack } : {}), ...(seams.predict ? { predict: seams.predict } : {}) });
  }
  if (command === "backup") {
    if (rest.length !== 2 || rest[0] !== "--out" || !rest[1]) {
      say.err(USAGE);
      return 2;
    }
    return backup({ dataDir: env.GALATEA_STATE_DIR, out: rest[1], say });
  }
  say.err(USAGE);
  return 2;
}
