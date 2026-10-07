/** The display variables a `needsSession` server and the helper get from their session (*Starting a process in a session*). */
export const DISPLAY_NAMES: readonly string[] = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

const SIMPLE: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };

/**
 * One value as `systemctl show-environment` prints it: as it is, or, where it holds a character a
 * shell would read (a space, a quote, `$`, a glob, a control character, any non-ASCII), in `$'…'`
 * with C escapes, as systemd's `shell_maybe_quote(…, SHELL_ESCAPE_POSIX)` writes it (systemd 247 and
 * later): `\\`, `\'`, `\"`, `\a` … `\v`, and `\NNN` in octal for any other control byte. A `\x` is
 * read too. An escape it does not know keeps its character.
 */
export function unquoteSystemdValue(raw: string): string {
  if (!(raw.startsWith("$'") && raw.endsWith("'") && raw.length >= 3)) return raw;
  const body = raw.slice(2, -1);
  const bytes: number[] = [];
  const push = (s: string) => bytes.push(...Buffer.from(s, "utf8"));
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\" || i === body.length - 1) {
      push(c);
      continue;
    }
    const n = body[i + 1]!;
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    const hex = /^x([0-9a-fA-F]{2})/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8) & 0xff);
      i += 3;
    } else if (hex) {
      bytes.push(parseInt(hex[1]!, 16));
      i += 3;
    } else {
      push(SIMPLE[n] ?? n);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The display variables from `systemctl --user show-environment`'s output (`NAME=value`, one a
 * line, quoted as `unquoteSystemdValue` reads): those of `DISPLAY_NAMES` it gives, nothing else, an
 * empty value left out.
 */
export function parseShowEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !DISPLAY_NAMES.includes(m[1]!)) continue;
    const value = unquoteSystemdValue(m[2]!);
    if (value !== "") out[m[1]!] = value;
  }
  return out;
}

/**
 * The session scope's `cgroup.procs` (*Starting a process in a session*):
 * `<cgroup root>/user.slice/user-<uid>.slice/<scope>/cgroup.procs`, the scope being logind's
 * session `Scope` property where it gives one, else `session-<id>.scope` (the name logind gives
 * every session scope). A scope name that is not a plain unit name is refused.
 */
export function scopeProcs(cgroupRoot: string, uid: number, session: string, scope: string): string {
  const unit = scope !== "" ? scope : `session-${session}.scope`;
  if (!/^[A-Za-z0-9_.:\\-]+\.scope$/.test(unit) || unit.includes("..")) throw new Error(`not a scope's name: ${JSON.stringify(unit)}`);
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error(`not an account's id: ${uid}`);
  return `${cgroupRoot}/user.slice/user-${uid}.slice/${unit}/cgroup.procs`;
}
