import type { AdminFacts } from "./port.js";
import type { OtherAdmin } from "./state-store.js";

/** The groups whose members are administrators on Linux: sudo's by distribution, and docker's (GA-BRIDGE-53). */
export const ADMIN_GROUPS: readonly string[] = ["sudo", "wheel", "admin", "docker"];
/** The entry that says the list is incomplete (GA-BRIDGE-53); never an account's token. */
export const UNKNOWN: OtherAdmin = { vendor: "os", label: "unknown" };

/** Deduplicated and sorted by label, so that two reads of the same set compare equal. */
function tidy(list: OtherAdmin[]): OtherAdmin[] {
  const labels = [...new Set(list.map((a) => a.label))].sort();
  return labels.map((label) => ({ vendor: "os", label }));
}

/**
 * The computer's `otherAdmins` from the OS's raw facts (the design's *The core*): root always; every
 * member of `sudo`, `wheel`, `admin` and `docker`; every account sudo lets run anything as root, one
 * command being enough; every identity polkit's administrator rules name, a user by its token and a
 * group by its own `g<gid>` (a gid is never taken for a uid); and one `unknown` where a sudo answer
 * cannot be told, polkit has a file the backend does not recognise, polkit names an identity the
 * OS could not resolve, or the OS says the set cannot be enumerated in full (`incomplete`). `token` gives an account's token from the same table as `accounts`, a service
 * account included.
 */
export function reduceAdmins(facts: AdminFacts, token: (osId: number, name: string) => string): OtherAdmin[] {
  const out: OtherAdmin[] = [];
  const add = (label: string) => out.push({ vendor: "os", label });
  add(token(0, "root"));
  for (const g of facts.groups) {
    if (!ADMIN_GROUPS.includes(g.name)) continue;
    for (const m of g.members) add(token(m.osId, m.name));
  }
  for (const s of facts.sudo) if (s.root === "yes") add(token(s.osId, s.name));
  for (const u of facts.polkit.users) add(token(u.osId, u.name));
  for (const g of facts.polkit.groups) add(`g${g.gid}`);
  const incomplete = facts.polkit.unrecognised || facts.polkit.unresolved.length > 0 || facts.sudo.some((s) => s.root === "cannotTell")
    || (facts.incomplete?.length ?? 0) > 0;
  if (incomplete) out.push(UNKNOWN);
  return tidy(out);
}

/** After a read that failed: the last set and `unknown`, never fewer names than before. */
export function withUnknown(last: OtherAdmin[]): OtherAdmin[] {
  return tidy([...last, UNKNOWN]);
}

export function sameAdmins(a: OtherAdmin[], b: OtherAdmin[]): boolean {
  return JSON.stringify(tidy(a)) === JSON.stringify(tidy(b));
}

/** The administrators with these accounts' tokens added, once each: the computer's set with each `needsSession` plugin's account (GA-BRIDGE-53). */
export function withAccounts(admins: OtherAdmin[], tokens: string[]): OtherAdmin[] {
  return tidy([...admins, ...tokens.map((label) => ({ vendor: "os", label }))]);
}

/** Two `otherAdmins` lists naming the same entries, vendor and label, in any order: a plugin's entries are not all the OS's. */
export function sameSet(a: OtherAdmin[], b: OtherAdmin[]): boolean {
  const key = (l: OtherAdmin[]) => JSON.stringify(l.map((x) => [x.vendor, x.label]).sort());
  return key(a) === key(b);
}
