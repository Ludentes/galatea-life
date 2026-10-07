import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * The OS's own files the Linux backend reads, and their parsers. Every read takes the root
 * directory (`/` on the host, a fake one in the tests), so no test reads this machine's files.
 */

/** One line of `/etc/passwd`. */
export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

/** One line of `/etc/group`, its members by name as the file lists them (primary members are not listed). */
export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

/** `/etc/login.defs`'s range for the uids `useradd` gives ordinary accounts. */
export interface LoginDefs {
  uidMin: number;
  uidMax: number;
}

/** Debian's defaults (`useradd` uses them when `login.defs` sets none). */
export const LOGIN_DEFS_DEFAULTS: LoginDefs = { uidMin: 1000, uidMax: 60000 };

/** A path under the root directory: `/etc/passwd` under `/` is itself. */
export function under(root: string, path: string): string {
  return join(root, path);
}

export async function readText(root: string, path: string): Promise<string> {
  return readFile(under(root, path), "utf8");
}

/** A whole decimal number, or undefined: `1000`, never `1e3`, ` 1000` or `-1`. */
function whole(text: string | undefined): number | undefined {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
}

/** Lines that are neither empty nor comments; a malformed line is skipped, never guessed at. */
function lines(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "" && !l.startsWith("#"));
}

/** One passwd line as glibc reads it (a colon past the sixth goes into the shell), "nis" for compat's `+`/`-` lines, or undefined when malformed. */
function passwdLine(line: string): PasswdEntry | "nis" | undefined {
  const f = line.split(":");
  // NIS's `+`/`-` lines (compat) name no account of their own.
  if (f[0]!.startsWith("+") || f[0]!.startsWith("-")) return "nis";
  if (f.length < 7) return undefined;
  const uid = whole(f[2]);
  const gid = whole(f[3]);
  if (!f[0] || uid === undefined || gid === undefined) return undefined;
  return { name: f[0], uid, gid, home: f[5]!, shell: f.slice(6).join(":") };
}

/** The accounts of a passwd text (a file, or `getent`'s output), a malformed line skipped. */
export function parsePasswd(text: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  for (const line of lines(text)) {
    const e = passwdLine(line);
    if (typeof e === "object") out.push(e);
  }
  return out;
}

/**
 * `/etc/passwd` as a read that deletions and the administrators may rest on (review M2): a file
 * with no root line, or with a line that does not parse, is a failed read (an editor writing in
 * place, a full disk, a truncated copy), never a list of accounts with the rest gone. A file cut at
 * a line's end with root still in it cannot be told from a real one: a stated limit.
 */
export function parsePasswdChecked(text: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  lines(text).forEach((line, i) => {
    const e = passwdLine(line);
    if (e === undefined) throw new Error(`/etc/passwd: line ${i + 1} is malformed, so the file is taken as unreadable`);
    if (e !== "nis") out.push(e);
  });
  if (!out.some((e) => e.uid === 0)) throw new Error("/etc/passwd names no root: an empty or partial file, taken as unreadable");
  return out;
}

export function parseGroup(text: string): GroupEntry[] {
  const out: GroupEntry[] = [];
  for (const line of lines(text)) {
    const f = line.split(":");
    if (f.length !== 4 || f[0]!.startsWith("+") || f[0]!.startsWith("-")) continue;
    const gid = whole(f[2]);
    if (!f[0] || gid === undefined) continue;
    out.push({ name: f[0], gid, members: f[3]!.split(",").map((m) => m.trim()).filter(Boolean) });
  }
  return out;
}

/** `UID_MIN` and `UID_MAX`, each its default when absent or not a number. */
export function parseLoginDefs(text: string): LoginDefs {
  const value = (key: string) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s+(\\S+)\\s*$`, "m"));
    return whole(m?.[1]);
  };
  return { uidMin: value("UID_MIN") ?? LOGIN_DEFS_DEFAULTS.uidMin, uidMax: value("UID_MAX") ?? LOGIN_DEFS_DEFAULTS.uidMax };
}

/** The sources `nsswitch.conf` names for a database (`passwd`, `group`), the `[...]` actions left out. */
export function parseNsswitch(text: string, database: string): string[] {
  const m = text.match(new RegExp(`^\\s*${database}\\s*:(.*)$`, "m"));
  if (!m) return ["files"];
  return m[1]!.replace(/#.*$/, "").replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * The NSS sources that read only this machine's own files: every other one (`sss`, `ldap`,
 * `winbind`, `nis`, and any the backend does not know) is a directory, which may be offline.
 */
export const LOCAL_SOURCES: readonly string[] = ["files", "compat", "systemd", "extrausers", "altfiles", "cache", "db", "usrfiles"];

export function hasDirectory(sources: readonly string[]): boolean {
  return sources.some((s) => !LOCAL_SOURCES.includes(s));
}

/**
 * What makes a named NSS directory module configured (review N1): a module named in
 * `nsswitch.conf` but with nothing to serve (Ubuntu's desktop names `sss` with sssd installed and
 * not set up) answers nothing, so the set can be enumerated in full. `sss` by sssd.service's own
 * start conditions (`sssd.conf`, or a file in `conf.d`); `ldap` by nslcd's, libnss-ldap's, the old
 * `/etc/ldap.conf`, or the LDAP client's own (`/etc/ldap/ldap.conf`, `/etc/openldap/ldap.conf`); `winbind` by samba's `smb.conf`; `nis` and `nisplus` by a server or a domain.
 */
const DIRECTORY_CONFIG: Readonly<Record<string, { files: readonly string[]; dirs?: readonly string[] }>> = {
  sss: { files: ["/etc/sssd/sssd.conf"], dirs: ["/etc/sssd/conf.d"] },
  ldap: { files: ["/etc/nslcd.conf", "/etc/libnss-ldap.conf", "/etc/ldap.conf", "/etc/ldap/ldap.conf", "/etc/openldap/ldap.conf"] },
  winbind: { files: ["/etc/samba/smb.conf"] },
  nis: { files: ["/etc/yp.conf", "/etc/defaultdomain"] },
  nisplus: { files: ["/etc/yp.conf", "/etc/defaultdomain"] },
};

/** Every path `configuredDirectory` reads: the watches follow them with `nsswitch.conf`. */
export const DIRECTORY_CONFIG_PATHS: ReadonlySet<string> = new Set(
  Object.values(DIRECTORY_CONFIG).flatMap((c) => [...c.files, ...(c.dirs ?? [])]),
);

/** A failure other than "not there" (EACCES) counts as there: configured is the side that never deletes. */
const notThere = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Whether these NSS sources include a directory that is configured (review N1), for deletions
 * (GA-BRIDGE-52) and the administrators (GA-BRIDGE-53) alike: a local source never is; a known
 * directory module is when its configuration is there (`DIRECTORY_CONFIG`); any other module
 * always is. Configured, not answering: an offline directory is still one.
 */
export async function configuredDirectory(root: string, sources: readonly string[]): Promise<boolean> {
  for (const s of sources) {
    if (LOCAL_SOURCES.includes(s)) continue;
    const c = DIRECTORY_CONFIG[s];
    if (!c) return true;
    for (const f of c.files) {
      try {
        await stat(under(root, f));
        return true;
      } catch (err) {
        if (!notThere(err)) return true;
      }
    }
    for (const d of c.dirs ?? []) {
      try {
        if ((await readdir(under(root, d))).length > 0) return true;
      } catch (err) {
        if (!notThere(err)) return true;
      }
    }
  }
  return false;
}

/** A shell that refuses a login: `nologin` or `false`, wherever installed. */
export function refusesLogin(shell: string): boolean {
  return /(^|\/)(nologin|false)$/.test(shell.trim());
}

/**
 * An interactive account, as the design says: a uid from `UID_MIN` to `UID_MAX` and a shell other
 * than `nologin` or `false` (an empty shell is `/bin/sh`). A directory account is held to `UID_MIN`
 * only: `UID_MAX` bounds what `useradd` gives here, and directories number their accounts higher.
 */
export function interactive(e: PasswdEntry, defs: LoginDefs, local: boolean): boolean {
  if (refusesLogin(e.shell)) return false;
  return e.uid >= defs.uidMin && (!local || e.uid <= defs.uidMax);
}
