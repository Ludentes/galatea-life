import type { Identity } from "../port.js";
import {
  configuredDirectory, interactive, LOGIN_DEFS_DEFAULTS, parseLoginDefs, parseNsswitch, parsePasswd, parsePasswdChecked, readText, type LoginDefs,
  type PasswdEntry,
} from "./etc.js";
import { COMMAND_ENV, type Runner } from "./run.js";

/** What the account reads need: the root directory and the command runner. */
export interface AccountSources {
  root: string;
  run: Runner;
}

/** A file that is not there reads as `fallback`; any other failure is the read's failure. */
async function readOr<T>(root: string, path: string, parse: (text: string) => T, fallback: T): Promise<T> {
  try {
    return parse(await readText(root, path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** `/etc/machine-id` must be 32 lowercase hex digits (machine-id(5)). */
const MACHINE_ID = /^[0-9a-f]{32}$/;

/**
 * The machine as the OS names it: `/etc/machine-id` (else D-Bus's copy, `/var/lib/dbus/machine-id`,
 * which Debian links to it), and DMI's vendor and product name, `unknown` where the firmware gives
 * none (a container). Throws when no machine id can be read: the computer has no stable identifier
 * without it, and the bridge refuses to start rather than make one up.
 */
export async function readIdentity(root: string): Promise<Identity> {
  let machineId: string | undefined;
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const text = await readText(root, path).catch(() => "");
    if (MACHINE_ID.test(text.trim())) {
      machineId = text.trim();
      break;
    }
  }
  if (!machineId) throw new Error("no machine id: /etc/machine-id is missing, unreadable or not 32 hex digits");
  const dmi = async (name: string) => (await readText(root, `/sys/class/dmi/id/${name}`).catch(() => "")).trim() || "unknown";
  return { machineId, vendor: await dmi("sys_vendor"), model: await dmi("product_name") };
}

/** One passwd line as `getent passwd` prints it, or undefined. */
function getentLine(stdout: string): PasswdEntry | undefined {
  return parsePasswd(stdout.split("\n")[0] ?? "")[0];
}

/**
 * Looks an account up through NSS (`getent passwd <uid or name>`), a directory included: the entry,
 * `absent` when NSS answers "not found" (exit 2, which an offline directory gives as well), or
 * `failed` when the lookup did not run to an answer.
 */
export async function getentPasswd(run: Runner, key: string | number): Promise<PasswdEntry | "absent" | "failed"> {
  try {
    const r = await run("getent", ["passwd", "--", String(key)]);
    if (r.code === 0) return getentLine(r.stdout) ?? "failed";
    return r.code === 2 ? "absent" : "failed";
  } catch {
    return "failed";
  }
}

/** The accounts the OS lists now, and which known uids it reports deleted: `accounts`' reading, before each account's `PATH`. */
export interface AccountsRead {
  listed: PasswdEntry[];
  deleted: number[];
}

/**
 * The interactive accounts, read afresh (never remembered):
 * - every local one, from `/etc/passwd` and `/etc/login.defs` (*The OS port*);
 * - a directory account (sssd, LDAP) only where the machine's `nsswitch.conf` names a directory and
 *   the account is known already (it holds a token) or has a logind session now: NSS enumerates no
 *   directory by default, so the backend looks those uids up one by one.
 *
 * A known uid is reported deleted only when it is gone from `/etc/passwd` and no directory could be
 * holding it: `nsswitch.conf` names none. With a directory named, a uid gone from `/etc/passwd`
 * that NSS does not resolve is "cannot tell" (exit 2 is the same for an account that does not exist
 * and for a directory that is offline with no cache), never a deletion: a stated limit, which also
 * keeps a deleted local account's token on such a machine.
 */
export async function readAccounts(src: AccountSources, known: readonly number[], sessionUids: readonly number[] = []): Promise<AccountsRead> {
  const passwd = parsePasswdChecked(await readText(src.root, "/etc/passwd"));
  const defs: LoginDefs = await readOr(src.root, "/etc/login.defs", parseLoginDefs, LOGIN_DEFS_DEFAULTS);
  const sources = await readOr(src.root, "/etc/nsswitch.conf", (t) => parseNsswitch(t, "passwd"), ["files"]);
  const directory = await configuredDirectory(src.root, sources);
  const local = new Map(passwd.map((e) => [e.uid, e]));
  const listed = passwd.filter((e) => interactive(e, defs, true));
  const deleted: number[] = [];
  const elsewhere = [...new Set([...known, ...sessionUids])].filter((uid) => uid !== 0 && !local.has(uid));
  // NSS asked even with local sources only: systemd's userdb (homed) serves accounts that are not in /etc/passwd.
  const found = await Promise.all(elsewhere.map(async (uid) => [uid, await getentPasswd(src.run, uid)] as const));
  for (const [uid, entry] of found) {
    if (typeof entry === "object") {
      if (interactive(entry, defs, false)) listed.push(entry);
    } else if (entry === "absent" && !directory && known.includes(uid)) {
      deleted.push(uid);
    }
  }
  return { listed, deleted };
}

/** How long an account's `PATH` is kept: a login shell per account per check-in would be too many. */
export const PATH_TTL_MS = 10 * 60_000;
/** How soon a `PATH` that could not be read is tried again. */
export const PATH_RETRY_MS = 60_000;

interface PathEntry {
  path: string[];
  ok: boolean;
  at: number;
  refreshing?: Promise<void>;
}

/**
 * Each account's `PATH` as a login shell of it gives it (the design's *Files*): as root through
 * `setpriv --reuid=<uid> --regid=<gid> --init-groups -- env -i HOME=… USER=… LOGNAME=… SHELL=…
 * PATH=<system> <shell> -l -c 'printenv PATH'`, the account's own login shell with a clean
 * environment. setpriv opens no PAM session (so no logind session and no user manager: review I2)
 * and execs in place with no `setsid`, so the runner's process-group kill at the bound reaches the
 * shell and what it forked (review N2; the VM run confirms both). For the process's own account (a
 * non-root development run), its shell with `-l -c`;
 * for any other account without root, nothing: its `PATH` is empty, so nothing resolves in it and
 * no interpreter is taken on a guess. `printenv` prints the variable as exported, whatever the
 * shell (fish keeps `$PATH` as a list); the last line is taken, so a profile that prints does not
 * count, and only absolute directories are kept, since an empty or relative entry would resolve
 * a command in whatever directory the server runs in.
 *
 * Kept 10 minutes per account (keyed by its uid, name, shell and home), a stale one used while it
 * is read again; one that failed is tried again after a minute, and reads as empty meanwhile.
 */
export class LoginPaths {
  private readonly cache = new Map<string, PathEntry>();

  constructor(private readonly o: {
    run: Runner;
    euid: number;
    now?: () => number;
    /** The setpriv program, a stand-in in tests. */
    setpriv?: string;
    /** The read's bound, the runner's own by default. */
    boundMs?: number;
  }) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async get(e: PasswdEntry): Promise<string[]> {
    const key = [e.uid, e.name, e.shell, e.home].join("\0");
    const hit = this.cache.get(key);
    if (hit) {
      const fresh = this.now() - hit.at < (hit.ok ? PATH_TTL_MS : PATH_RETRY_MS);
      if (!fresh && !hit.refreshing) {
        hit.refreshing = this.read(e).then((r) => void this.cache.set(key, { ...r, at: this.now() }));
      }
      return [...hit.path];
    }
    const r = await this.read(e);
    this.cache.set(key, { ...r, at: this.now() });
    return [...r.path];
  }

  private async read(e: PasswdEntry): Promise<{ path: string[]; ok: boolean }> {
    const script = "printenv PATH";
    let file: string;
    let args: string[];
    let env: Record<string, string> | undefined;
    const shell = e.shell.trim() || "/bin/sh";
    if (this.o.euid === 0) {
      // No PAM (runuser's would fork and setsid the shell out of the killable group: review N2), so no
      // logind session (review I2). The login shell itself reads the profile, from a clean environment
      // as `-l` would give it. The account by its uid and gid, never a name an option could take (M6).
      [file, args] = [this.o.setpriv ?? "setpriv", [
        `--reuid=${e.uid}`, `--regid=${e.gid}`, "--init-groups", "--", "env", "-i", `HOME=${e.home}`, `USER=${e.name}`,
        `LOGNAME=${e.name}`, `SHELL=${shell}`, `PATH=${COMMAND_ENV.PATH}`, shell, "-l", "-c", script,
      ]];
    } else if (this.o.euid === e.uid) {
      [file, args, env] = [shell, ["-l", "-c", script], { HOME: e.home, USER: e.name, LOGNAME: e.name, SHELL: shell }];
    } else {
      return { path: [], ok: true };
    }
    try {
      const r = await this.o.run(file, args, { ...(env ? { env } : {}), ...(this.o.boundMs ? { timeoutMs: this.o.boundMs } : {}) });
      const last = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
      if (r.code !== 0 || last === undefined) return { path: [], ok: false };
      return { path: [...new Set(last.split(":").filter((d) => d.startsWith("/")))], ok: true };
    } catch {
      return { path: [], ok: false };
    }
  }
}
