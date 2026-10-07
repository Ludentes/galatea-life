/** Whether sudo lets an account run at least one command as root (GA-BRIDGE-53). */
export type SudoRoot = "yes" | "no" | "cannotTell";

/** A Runas list's word on root: root is among the targets, it is not, or the backend cannot tell. */
type Target = "root" | "other" | "unknown";

/**
 * A Runas list as `sudo -l` prints it, `(users : groups)`, or none (sudo then runs as root, its
 * `runas_default`, and prints that): root when `ALL`, `root` or `#0` is among the users; unknown
 * for a negation (`ALL, !root`), a group of users (`%wheel`), a netgroup, or an alias, which the
 * backend does not evaluate (the design: sudo evaluates its own aliases); and a Runas of groups
 * only, `( : ALL)`, run as the account itself with another group, is unknown when that group may be
 * root's.
 */
function target(spec: string | undefined, uidOf: (name: string) => number | undefined): Target {
  if (spec === undefined) return "root";
  const [usersPart = "", groupsPart = ""] = spec.split(":");
  const words = (s: string) => s.split(",").map((w) => w.trim()).filter(Boolean);
  const users = words(usersPart);
  const opaque = (w: string) => /^[%+!]/.test(w) || /^[A-Z][A-Z0-9_]*$/.test(w) && w !== "ALL";
  if (users.length === 0) {
    const groups = words(groupsPart);
    return groups.some((g) => g === "ALL" || g === "root" || g === "#0" || opaque(g)) ? "unknown" : "other";
  }
  if (users.some((u) => u.startsWith("!"))) return "unknown";
  // Root under any name: `#0`, or a name whose uid is 0 (`toor`), resolved through the account files (review M9).
  const isRoot = (u: string) => u === "ALL" || u === "root" || /^#0+$/.test(u) || (!/^#/.test(u) && uidOf(u) === 0);
  if (users.some(isRoot)) return "root";
  return users.some(opaque) ? "unknown" : "other";
}

/** A command's tags (`NOPASSWD:`, `SETENV:`) and options (`CWD=/tmp`, `TIMEOUT=10`) off its front. */
function untagged(command: string): string {
  let c = command.trim();
  for (;;) {
    const next = c.replace(/^[A-Z_]+:\s*/, "").replace(/^[A-Z_]+=\S+\s+/, "");
    if (next === c) return c;
    c = next;
  }
}

/** An entry's commands: split at each comma outside a Runas's parentheses and not written `\,` (a comma in a command's arguments). */
function commands(entry: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i]!;
    if (c === "\\" && entry[i + 1] === ",") {
      current += "\\,";
      i++;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current.trim());
  return out;
}

/** The entries under "User … may run the following commands on …:", each one line, wrapped lines joined. */
function entries(text: string): string[] | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^User .+ may run the following commands on .+:$/.test(l.trim()));
  if (at < 0) return undefined;
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") break;
    if (/^\s{4}\(/.test(line) || out.length === 0) out.push(line.trim());
    else out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/**
 * Reads `sudo -l -U <account>`'s output (run as root, in the C locale): `yes` when any rule lets
 * the account run at least one command as root, a one-command grant included (GA-BRIDGE-53) and
 * `ALL, !/bin/su` too; `cannotTell` for a grant whose command is pinned by a digest
 * (`sha224:… /bin/ls`) or whose Runas the backend cannot read as root or not; `no` for "is not
 * allowed to run sudo", or rules that run nothing as root; and `cannotTell` for any output it does
 * not know (sudo's error, "unknown user").
 */
export function parseSudoList(text: string, uidOf: (name: string) => number | undefined = () => undefined): SudoRoot {
  if (/^User .+ is not allowed to run sudo on .+\.$/m.test(text)) return "no";
  const list = entries(text);
  if (!list) return "cannotTell";
  let unsure = false;
  for (const entry of list) {
    let runas: string | undefined;
    for (let part of commands(entry)) {
      const m = part.match(/^\(([^)]*)\)\s*(.*)$/);
      if (m) {
        runas = m[1];
        part = m[2]!;
      }
      const command = untagged(part);
      if (command === "" || command.startsWith("!")) continue;
      const t = target(runas, uidOf);
      if (t === "other") continue;
      if (t === "unknown" || /^sha(224|256|384|512):/.test(command)) {
        unsure = true;
        continue;
      }
      return "yes";
    }
  }
  return unsure ? "cannotTell" : "no";
}
