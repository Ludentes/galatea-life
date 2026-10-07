import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

/** Another bridge runs on this data directory, or the directory or its key is not the bridge's own: it refuses to start. */
export class InstanceError extends Error {}

const KEY_FILE = "instance.key";
const KEY = /^[0-9a-f]{32}$/;
/** A key being made: `instance.key.<pid>.tmp`, linked to its name, then removed. */
const KEY_TMP = /^instance\.key\.(\d+)\.tmp$/;

/**
 * Makes the bridge's private data directory (mode 0700) or checks the one there: the bridge's own,
 * and writable by no other account, which could otherwise swap the instance key, and later the
 * network's key and the coordinator's backup, under it.
 */
export function ensureStateDir(dir: string): void {
  try {
    // Throws on a file in the directory's place, too.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new InstanceError(`cannot make ${dir}: ${(err as Error).message}`);
  }
  const st = statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new InstanceError(`${dir} belongs to another account (uid ${st.uid})`);
  if (st.mode & 0o022) throw new InstanceError(`${dir} is writable by other accounts (mode ${(st.mode & 0o777).toString(8)})`);
}

/**
 * One bridge per data directory. Two on one coordinator would answer every command twice and fight
 * over the network; two on one store would hand out the same device id twice.
 *
 * The lock is a name in Linux's abstract socket namespace: the kernel frees it when its process
 * dies, however it dies, so no stale lock survives a crash or a power cut, and no recycled pid is
 * mistaken for a live owner. The name comes from a random key kept in the data directory (mode
 * 0700), so another account on the box cannot compute it and hold it first.
 */
export class InstanceLock {
  private readonly server: Server;

  private constructor(server: Server) {
    this.server = server;
  }

  /** The caller has checked the directory first (`ensureStateDir`); throws InstanceError while another bridge holds it. */
  static async acquire(dir: string): Promise<InstanceLock> {
    const name = `\0galatea-zigbee-bridge-${key(dir)}`;
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) =>
        reject(err.code === "EADDRINUSE" ? new InstanceError(`another bridge is running on ${dir}`) : err));
      server.listen(name, () => resolve());
    });
    // The lock never keeps the process alive by itself.
    server.unref();
    return new InstanceLock(server);
  }

  /** Frees the name; a process that exits frees it anyway. */
  release(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** The directory's key, made once. Two first starts racing make one key: the link of the loser fails. */
function key(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweep(dir);
  const path = join(dir, KEY_FILE);
  const read = (): string | undefined => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new InstanceError(`cannot read ${path}: ${(err as Error).message}`);
    }
  };
  let text = read();
  if (text === undefined) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, randomBytes(16).toString("hex"), { mode: 0o600 });
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      unlinkSync(tmp);
    }
    text = read();
  }
  if (text === undefined || !KEY.test(text)) throw new InstanceError(`${path} is not a key this bridge wrote`);
  return text;
}

/** Removes the temporary key files of processes that died making one; a live process's is left to it. */
function sweep(dir: string): void {
  for (const name of readdirSync(dir)) {
    const pid = Number(name.match(KEY_TMP)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: another account's process holds that pid, so it is alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
