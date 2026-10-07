import { lstat, mkdir, open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import type { Stats } from "node:fs";
import type { PathInfo } from "../port.js";

/** An account as a write check sees it: its uid and every gid it has (its primary group and those listing it). */
export interface Writer {
  uid: number;
  gids: ReadonlySet<number>;
}

/** The mode bits that apply to this account, as the kernel picks them: the owner's, else the group's, else the others'. */
function modeWritable(st: Stats, w: Writer): boolean {
  if (st.uid === w.uid) return (st.mode & 0o200) !== 0;
  if (w.gids.has(st.gid)) return (st.mode & 0o020) !== 0;
  return (st.mode & 0o002) !== 0;
}

/** Whether the account can replace `child` in `dir`: `dir` writable to it, and, where `dir` is sticky (`/tmp`), the account owns `dir` or `child`. */
function canReplace(dir: Stats, child: Stats, w: Writer): boolean {
  if (!modeWritable(dir, w)) return false;
  if ((dir.mode & 0o1000) === 0) return true;
  return dir.uid === w.uid || child.uid === w.uid;
}

/** Links followed at most this many times, as the kernel's own limit (40). */
const MAX_LINKS = 40;

/**
 * Where a path leads: the file it names, and the place of each symbolic link on the way to it
 * (`/usr/bin/python3`, then `/etc/alternatives/python3`), each resolved from its directory's real
 * path. A directory named by a link higher up is resolved by `realpath` without being listed: the
 * core asks for each directory on a path itself.
 */
async function follow(path: string): Promise<{ target: string; links: string[] }> {
  const links: string[] = [];
  let p = posix.normalize(path);
  for (let i = 0; i <= MAX_LINKS; i++) {
    const place = p === "/" ? "/" : join(await realpath(dirname(p)), posix.basename(p));
    const st = await lstat(place);
    if (!st.isSymbolicLink()) return { target: place, links };
    links.push(place);
    const to = await readlink(place);
    p = isAbsolute(to) ? posix.normalize(to) : join(dirname(place), to);
  }
  throw Object.assign(new Error(`${path}: too many levels of symbolic links`), { code: "ELOOP" });
}

/**
 * Whether the account can write the path without elevation (*The OS port*, plan 3c's M5): the file
 * it leads to by its owner, group and mode; or any directory above that file, or above any link on
 * the way to it, that the account can write, since it could then replace what is below it (a sticky
 * directory only where it owns the directory or the entry below). Root writes anything. A path that
 * is not there is not writable; any other failure to look is taken as writable, never as safe.
 * POSIX ACLs are not read (Node gives no access to them): a stated limit, their mask shows in the
 * group bits.
 */
export async function canWrite(w: Writer, path: string): Promise<boolean> {
  if (w.uid === 0) return true;
  let found: { target: string; links: string[] };
  try {
    found = await follow(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return false;
    return true;
  }
  try {
    if (modeWritable(await stat(found.target), w)) return true;
    for (const place of [found.target, ...found.links]) {
      let child = place;
      while (child !== "/") {
        const dir = dirname(child);
        if (canReplace(await stat(dir), await lstat(child), w)) return true;
        child = dir;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Whether the path is there (links followed), and whether it is a regular file with an execute bit: all `PATH` resolution reads. */
export async function exists(path: string): Promise<PathInfo> {
  try {
    const st = await stat(path);
    return { exists: true, executable: st.isFile() && (st.mode & 0o111) !== 0 };
  } catch {
    return { exists: false, executable: false };
  }
}

/** What `makeRootOnlyDir` needs: this process's euid, the owner the directory must have (root), and the calls it makes. */
export interface RootDirOptions {
  euid: number;
  owner?: number;
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
}

/** Throws unless `dir` and every directory above it is root's (or `owner`'s) and writable by no other account, a sticky one only where what it holds is root's. */
async function checkChain(start: string, childUid: number, owner: number): Promise<void> {
  const ours = (uid: number) => uid === owner || uid === 0;
  let dir = start;
  for (;;) {
    const d = await lstat(dir);
    const othersWrite = (d.mode & 0o022) !== 0 && !((d.mode & 0o1000) !== 0 && ours(childUid));
    if (!d.isDirectory() || !ours(d.uid) || othersWrite) throw new Error(`${dir}, above the plugins directory, can be written by an account other than root`);
    if (dir === "/") return;
    childUid = d.uid;
    dir = dirname(dir);
  }
}

/**
 * Each link on `dir`'s path as written, and on each link's own target, is held by a directory
 * checked as `checkChain` checks: one another account could write could swap the link between the
 * check and `mkdir` (review N5). A missing component ends the walk (`mkdir` makes the rest as root).
 */
async function checkLinkHolders(dir: string, owner: number, seen: { links: number }): Promise<void> {
  let prefix = "/";
  for (const part of resolve(dir).split("/").filter(Boolean)) {
    const p = join(prefix, part);
    let st: Stats;
    try {
      st = await lstat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) {
      if (++seen.links > MAX_LINKS) throw new Error(`${dir}: too many links on the way to the plugins directory`);
      await checkChain(await realpath(prefix), st.uid, owner);
      const target = await readlink(p);
      await checkLinkHolders(isAbsolute(target) ? target : join(prefix, target), owner, seen);
    }
    prefix = p;
  }
}

/**
 * Throws unless every directory above `path` is safe to keep a root-only directory in: owned by
 * root (or `owner`) and writable by no other account, a sticky one (`/tmp`) only where what it
 * holds is root's. Checked where each really is, links resolved, from the nearest one that exists
 * (a missing one `mkdir` makes as root), and each directory holding a link on the way (N5).
 */
async function checkAbove(path: string, owner: number): Promise<void> {
  let above = dirname(path);
  for (;;) {
    try {
      above = await realpath(above);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || above === "/") throw err;
      above = dirname(above);
    }
  }
  const held = await lstat(path).catch(() => undefined);
  await checkChain(above, held?.uid ?? owner, owner);
  await checkLinkHolders(dirname(path), owner, { links: 0 });
}

/**
 * Makes the directory, or takes the one there, writable by the service alone (GA-BRIDGE-70): as
 * root, first the directories above it checked (none another account could use to replace it,
 * links resolved: review M3), then `mkdir -p` with mode 0755, then the directory opened without
 * following a link (`O_NOFOLLOW`, `O_DIRECTORY`) and, through that descriptor, owned by root and
 * mode 0755 whatever it was, and read back. Throws when any of that fails, or when this process is
 * not root (a development run): the plugin host then names `plugins_unready`. `chown`, in tests
 * only, stands in for the descriptor's chown.
 */
export async function makeRootOnlyDir(path: string, o: RootDirOptions): Promise<void> {
  const owner = o.owner ?? 0;
  if (o.euid !== 0) throw new Error(`${path}: the plugins directory is made by root, and this process is not root`);
  await checkAbove(path, owner);
  await mkdir(path, { recursive: true, mode: 0o755 });
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new Error(`${path} is not a directory`);
    throw err;
  }
  try {
    if (!(await fh.stat()).isDirectory()) throw new Error(`${path} is not a directory`);
    if (o.chown) await o.chown(path, owner, owner);
    else await fh.chown(owner, owner);
    await fh.chmod(0o755);
    const now = await fh.stat();
    if (now.uid !== owner || (now.mode & 0o022) !== 0) throw new Error(`${path} is not owned by root with no group or other write`);
  } finally {
    await fh.close();
  }
}
