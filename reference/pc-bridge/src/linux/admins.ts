import { ADMIN_GROUPS } from "../admins.js";
import type { AdminFacts } from "../port.js";
import { getentPasswd } from "./accounts.js";
import {
  configuredDirectory, parseGroup, parseNsswitch, parsePasswdChecked, readText, type GroupEntry, type PasswdEntry,
} from "./etc.js";
import { scanPolkit } from "./polkit.js";
import { COMMAND_MS, RunError, type Runner } from "./run.js";
import { parseSudoList, type SudoRoot } from "./sudo.js";

/** What the administrator reads need: the root directory, the command runner, and whether this process is root. */
export interface AdminSources {
  root: string;
  run: Runner;
  euid: number;
}

/** The facts, with a line for each thing that made them incomplete, for the log and the by-hand read. */
export interface AdminRead {
  facts: AdminFacts;
  notes: string[];
}

/** How many `sudo -l -U` run at once: a machine with fifty service accounts reads them in a few rounds. */
export const SUDO_AT_ONCE = 8;

/** `work` over `items`, at most `n` at once, the results in the items' order. */
async function pool<T, R>(items: readonly T[], n: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

async function readOr<T>(root: string, path: string, parse: (t: string) => T, fallback: T): Promise<T> {
  try {
    return parse(await readText(root, path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/**
 * One account's sudo answer, from `sudo -n -l -U <account>` (never a prompt), bounded: sudo not
 * installed is `no`; a run that fails or outlasts its bound is `cannotTell`, so a hung sudo never
 * stalls the read; otherwise what its output says (`parseSudoList`), a Runas name read as root
 * when `uidOf` gives it uid 0.
 */
export async function sudoAnswer(
  run: Runner, name: string, uidOf: (name: string) => number | undefined = () => undefined,
): Promise<{ root: SudoRoot; missing: boolean; note?: string }> {
  try {
    const r = await run("sudo", ["-n", "-l", "-U", name], { timeoutMs: COMMAND_MS, env: { COLUMNS: "4096" } });
    const root = parseSudoList(r.stdout, uidOf);
    return root === "cannotTell" ? { root, missing: false, note: `sudo -l -U ${name}: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 200) || `exit ${r.code}`}` }
      : { root, missing: false };
  } catch (err) {
    if (err instanceof RunError && err.kind === "missing") return { root: "no", missing: true };
    return { root: "cannotTell", missing: false, note: `sudo -l -U ${name}: ${(err as Error).message}` };
  }
}

/** A name looked up through NSS: the entry, `absent` (NSS's "not found", exit 2), or `failed`. */
type Lookup<T> = T | "absent" | "failed";

/** `getent group -- <name>`, NSS's answer for a group, a directory's or systemd's userdb's included. */
async function getentGroup(run: Runner, name: string): Promise<Lookup<GroupEntry>> {
  try {
    const r = await run("getent", ["group", "--", name]);
    if (r.code === 0) return parseGroup(r.stdout.split("\n")[0] ?? "")[0] ?? "failed";
    return r.code === 2 ? "absent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The OS's raw administrator facts (*The OS port*), which the core reduces:
 * - the groups of `/etc/group`, each with its listed members and every account whose primary group
 *   it is, by uid; a listed member not in `/etc/passwd` is looked up through NSS (a directory, or
 *   systemd's userdb, may serve it); one NSS answers is not there is left out (it cannot log in),
 *   and one whose lookup fails, or that a directory may be holding, makes the set incomplete when
 *   its group is an administrators' group (review I1);
 * - each account's sudo answer, root's aside, service accounts included (the standard's "every
 *   account sudo lets run any command as root", wider than the design's interactive accounts),
 *   `sudo -l -U` run as root, eight at a time; without root, `cannotTell` for each (sudo lists
 *   another account's rules to root only), which the core reads as `unknown`;
 * - polkit's recognised identities, resolved to an account or a group by the files, else NSS; one
 *   NSS answers is not there, with no directory named, names no one and is left out (ratified by the
 *   maintainer 2026-10-01: review M8); one a directory may hold, or whose lookup fails, is given as written;
 *   and whether any file is unrecognised;
 * - `incomplete`: why the set cannot be enumerated in full. Where `nsswitch.conf` names a directory
 *   for `passwd`, `group` or `sudoers`, a directory's accounts, groups and sudo rules are not read
 *   here, so the set is never complete (GA-BRIDGE-53's `unknown`; review I1).
 * `/etc/passwd` (checked: `parsePasswdChecked`) or `/etc/group` unreadable throws: the core then
 * keeps the last set with `unknown`.
 */
export async function readAdminFacts(src: AdminSources): Promise<AdminRead> {
  const notes: string[] = [];
  const incomplete: string[] = [];
  const passwd = parsePasswdChecked(await readText(src.root, "/etc/passwd"));
  const groupFile = parseGroup(await readText(src.root, "/etc/group"));
  const nss = await readOr(src.root, "/etc/nsswitch.conf", (t) => ({
    passwd: parseNsswitch(t, "passwd"), group: parseNsswitch(t, "group"), sudoers: parseNsswitch(t, "sudoers"),
  }), { passwd: ["files"], group: ["files"], sudoers: ["files"] });
  const directory = {
    passwd: await configuredDirectory(src.root, nss.passwd),
    group: await configuredDirectory(src.root, nss.group),
    sudoers: await configuredDirectory(src.root, nss.sudoers),
  };
  for (const db of ["passwd", "group", "sudoers"] as const) {
    if (directory[db]) incomplete.push(`nsswitch.conf names a configured directory for ${db} (${nss[db].join(" ")}): its administrators are not enumerated here`);
  }
  const byName = new Map(passwd.map((e) => [e.name, e]));
  const looked = new Map<string, Promise<Lookup<PasswdEntry>>>();
  const account = (name: string): Promise<Lookup<PasswdEntry>> => {
    const local = byName.get(name);
    if (local) return Promise.resolve(local);
    let p = looked.get(name);
    if (!p) {
      p = getentPasswd(src.run, name);
      looked.set(name, p);
    }
    return p;
  };

  const groups: AdminFacts["groups"] = [];
  for (const g of groupFile) {
    const members = new Map<number, string>();
    for (const name of g.members) {
      const e = await account(name);
      if (typeof e === "object") members.set(e.uid, e.name);
      else if (e === "absent" && !directory.passwd) notes.push(`group ${g.name}: member ${name} does not resolve`);
      else if (ADMIN_GROUPS.includes(g.name)) incomplete.push(`group ${g.name}: member ${name} could not be looked up`);
      else notes.push(`group ${g.name}: member ${name} could not be looked up`);
    }
    for (const e of passwd) if (e.gid === g.gid) members.set(e.uid, e.name);
    groups.push({ name: g.name, gid: g.gid, members: [...members].map(([osId, name]) => ({ osId, name })) });
  }

  // Every account but root, a service account included: the standard names every account sudo lets run a command as root.
  const accounts = passwd.filter((e) => e.uid !== 0);
  const uidOf = (name: string) => byName.get(name)?.uid;
  let sudo: AdminFacts["sudo"];
  if (src.euid !== 0) {
    sudo = accounts.map((e) => ({ osId: e.uid, name: e.name, root: "cannotTell" as const }));
    if (accounts.length) notes.push("sudo: not root, so no account's rules can be listed");
  } else {
    const answers = await pool(accounts, SUDO_AT_ONCE, async (e) => ({ e, a: await sudoAnswer(src.run, e.name, uidOf) }));
    sudo = answers.map(({ e, a }) => ({ osId: e.uid, name: e.name, root: a.root }));
    for (const { a } of answers) if (a.note) notes.push(a.note);
  }

  const scan = await scanPolkit(src.root, src.run);
  notes.push(...scan.unrecognised.map((u) => `polkit: ${u}`));
  const polkit: AdminFacts["polkit"] = { users: [], groups: [], unresolved: [], unrecognised: scan.unrecognised.length > 0 };
  const groupByName = new Map(groupFile.map((g) => [g.name, g]));
  for (const identity of scan.identities) {
    const user = identity.match(/^unix-user:(.+)$/)?.[1];
    const group = identity.match(/^unix-group:(.+)$/)?.[1];
    // NSS's own "not found" with no directory named: the identity names no one, as polkit's own
    // lookup finds no one (Ubuntu's stock rule names `unix-group:admin`, which Ubuntu no longer makes).
    if (user !== undefined) {
      const e = user === "root" ? { uid: 0, name: "root" } : await account(user);
      if (typeof e === "object") polkit.users.push({ osId: e.uid, name: e.name });
      else if (e === "absent" && !directory.passwd) notes.push(`polkit: ${identity} names no account here`);
      else polkit.unresolved.push(identity);
    } else if (group !== undefined) {
      const g = groupByName.get(group) ?? await getentGroup(src.run, group);
      if (typeof g === "object") polkit.groups.push({ name: g.name, gid: g.gid });
      else if (g === "absent" && !directory.group) notes.push(`polkit: ${identity} names no group here`);
      else polkit.unresolved.push(identity);
    } else {
      polkit.unresolved.push(identity);
    }
  }
  notes.push(...incomplete);
  return { facts: { groups, sudo, polkit, incomplete }, notes };
}
