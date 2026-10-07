import { mkdirSync, readFileSync, statSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { checkPlugins, type PluginsState } from "./plugins/record.js";
import { checkTokens, type TokenTable } from "./tokens.js";

/** One entry of a device's `otherAdmins`, as the bridge declares it. */
export interface OtherAdmin {
  vendor: string;
  label: string;
}

/**
 * What the bridge keeps across its restarts (GA-BRIDGE-31): each device's `lastCheckIn`, as wire
 * time; the token table (GA-BRIDGE-52); each device's `otherAdmins` as last declared; and the
 * plugins installed, with the requests in flight (GA-BRIDGE-68). The last three are absent from a
 * file an earlier plan's bridge wrote, which reads as empty.
 */
export interface BridgeState {
  v: 1;
  lastCheckIn: Record<string, string>;
  tokens?: TokenTable;
  otherAdmins?: Record<string, OtherAdmin[]>;
  plugins?: PluginsState;
}

/** The state directory cannot be read, or holds what the bridge did not write: it refuses to start. */
export class StateError extends Error {}

const FILE = "state.json";
/** Wire time as the bridge writes it (GA-BRIDGE-3): RFC 3339 UTC with milliseconds. */
const WIRE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Makes the state directory (mode 0700) or checks the one there: the bridge's own, and writable by
 * no other account, which could otherwise swap the state or the instance key under it.
 */
export function ensureStateDir(dir: string): void {
  try {
    // Throws on a file in the directory's place, too.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new StateError(`cannot make ${dir}: ${(err as Error).message}`);
  }
  const st = statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new StateError(`${dir} belongs to another account (uid ${st.uid})`);
  if (st.mode & 0o022) throw new StateError(`${dir} is writable by other accounts (mode ${(st.mode & 0o777).toString(8)})`);
}

function empty(): BridgeState {
  return { v: 1, lastCheckIn: {} };
}

function check(value: unknown): BridgeState {
  const s = value as Partial<BridgeState> | null;
  if (!s || typeof s !== "object" || s.v !== 1 || !s.lastCheckIn || typeof s.lastCheckIn !== "object") {
    throw new StateError("not a state file of this bridge");
  }
  for (const [id, at] of Object.entries(s.lastCheckIn)) {
    if (typeof at !== "string" || !WIRE_TIME.test(at) || Number.isNaN(Date.parse(at))) throw new StateError(`lastCheckIn of ${id} is not a time`);
  }
  if (s.tokens !== undefined) {
    try {
      checkTokens(s.tokens);
    } catch (err) {
      throw new StateError((err as Error).message);
    }
  }
  if (s.otherAdmins !== undefined) {
    if (!s.otherAdmins || typeof s.otherAdmins !== "object" || Array.isArray(s.otherAdmins)) throw new StateError("otherAdmins is not a map of devices");
    for (const [id, list] of Object.entries(s.otherAdmins)) {
      if (!Array.isArray(list) || !list.every((a) => a && typeof a === "object" && typeof a.vendor === "string" && typeof a.label === "string")) {
        throw new StateError(`otherAdmins of ${id} is not a list of administrators`);
      }
    }
  }
  if (s.plugins !== undefined) {
    try {
      checkPlugins(s.plugins);
    } catch (err) {
      throw new StateError((err as Error).message);
    }
  }
  return s as BridgeState;
}

/**
 * One JSON file in the state directory, written whole and atomically (a temporary file, synced,
 * then renamed over the old one, and the directory synced), so a crash leaves the old state or the new, never half of one.
 */
export class StateStore {
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly dir: string, readonly state: BridgeState) {}

  /** A missing file is a first start; an unreadable or foreign one is a StateError, never an empty store. */
  static load(dir: string): StateStore {
    ensureStateDir(dir);
    let text: string;
    try {
      text = readFileSync(join(dir, FILE), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new StateStore(dir, empty());
      throw new StateError(`cannot read ${join(dir, FILE)}: ${(err as Error).message}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new StateError(`${join(dir, FILE)} is not JSON: ${(err as Error).message}`);
    }
    try {
      return new StateStore(dir, check(json));
    } catch (err) {
      throw new StateError(`${join(dir, FILE)}: ${(err as Error).message}`);
    }
  }

  /** Writes the state as it stands; saves run one at a time, in the order asked. */
  save(): Promise<void> {
    const text = JSON.stringify(this.state);
    const next = this.chain.then(() => this.write(text));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Resolves once every save asked so far is on disk, or has failed. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async write(text: string): Promise<void> {
    const tmp = join(this.dir, `${FILE}.tmp`);
    const f = await open(tmp, "w", 0o600);
    try {
      await f.writeFile(text);
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, join(this.dir, FILE));
    await syncDir(this.dir);
  }
}

/** Syncs a directory, so that a rename or link in it survives a power cut as the file's own sync does. */
export async function syncDir(dir: string): Promise<void> {
  const d = await open(dir, "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
